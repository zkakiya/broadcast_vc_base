// src/core/transcribe.js
// Node -> Whisper (faster-whisper優先 / GPU→CPUフォールバック / 起動時CUDA自己診断)
// 人名ホットワード & ユーザー辞書適用 & 連呼抑止を含む

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';
import util from 'util';

import { FWWorker } from './asr/worker.js';
import {
  applyUserDictionary,
  loadUserDictionary,
  buildPeopleHotwordPrompt,
  getPersonProtectSet,
} from '../utils/dictionary.js';
import { fuzzyPeopleReplace } from '../utils/text_sanitize.js';

const execFileAsync = util.promisify(execFile);

// ── ESM: __dirname ─────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === 共通設定 ================================================================
let IMPL = (process.env.WHISPER_IMPL || 'whisper').toLowerCase(); // 'faster' | 'whisper'
const MODEL = process.env.WHISPER_MODEL || 'small';
const WHISPER_LANG = process.env.WHISPER_LANG || 'ja';

const NO_SPEECH = process.env.WHISPER_NO_SPEECH ?? '0.3';
const STRIP_CLOSERS = (process.env.WHISPER_STRIP_CLOSERS ?? '1') === '1';
const DEBUG = process.env.WHISPER_DEBUG === '1';

const USE_FW_WORKER = process.env.FW_WORKER === '1';
const FW_PY = process.env.WHISPER_PY || '/home/z_kakiya/whisper-venv/bin/python';

// このファイル基準で解決（CWD依存を排除）
const FW_WORKER_SCRIPT = path.resolve(__dirname, './fw_worker.py');
const FW_RUNNER = path.resolve(__dirname, './fw_runner.py');

const FW_DEVICE = process.env.FASTER_WHISPER_DEVICE || 'cuda';     // cuda / cpu
const FW_COMPUTE = process.env.FW_COMPUTE_TYPE || 'float16';       // float16 / int8_float16 / int8

// === Whisper CLI の解決 ======================================================
function resolveWhisperCmd() {
  const fromEnv = process.env.WHISPER_CMD;
  const candidates = [fromEnv, '/usr/local/bin/whisper', '/usr/bin/whisper', 'whisper'].filter(Boolean);
  try {
    const found = execFileSync('bash', ['-lc', 'command -v whisper'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch { }
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { }
  }
  const searchList = [`PATH=${process.env.PATH || ''}`, ...candidates.map(p => `candidate: ${p}`)].join('\n  ');
  throw new Error(`[whisper] executable not found.\n  ${searchList}`);
}
const WHISPER_CMD = resolveWhisperCmd();

function detectPythonFromWhisper(cmd) {
  try {
    const head = fs.readFileSync(cmd, 'utf8').split('\n')[0] || '';
    const m = head.match(/^#!\s*(.*python[0-9.]*)/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function probeCuda() {
  const py = detectPythonFromWhisper(WHISPER_CMD);
  if (!py) { if (DEBUG) console.info('[whisper] no shebang; skip CUDA probe'); return; }
  try {
    const out = execFileSync(py, ['-c',
      'import torch,sys;print("torch",torch.__version__);print("cuda",torch.cuda.is_available());print("cuda_ver",getattr(torch.version,"cuda",None));'
    ], { encoding: 'utf8' });
    console.info('[whisper][probe]\n' + out.trim());
  } catch (e) {
    console.warn('[whisper][probe] failed:', e?.message || e);
  }
}

export const probeWhisper = probeCuda;

// === 実行系：faster-whisper & Whisper CLI ===================================
async function runFasterWhisper(filePath, outDir) {
  const base = path.basename(filePath, path.extname(filePath));
  const jsonPath = path.join(outDir, `${base}.json`);
  const args = [
    FW_RUNNER, filePath, jsonPath,
    '--model', MODEL,
    '--device', FW_DEVICE,
    '--compute', FW_COMPUTE,
    '--lang', WHISPER_LANG,
    ...(process.env.ASR_HINTS ? ['--initial_prompt', process.env.ASR_HINTS] : []),
  ];
  if (DEBUG) console.info(`[faster] exec: ${FW_PY} ${args.join(' ')}`);
  await execFileAsync(FW_PY, args, { env: process.env });
  return jsonPath;
}

const BASE_ARGS = (filePath, outDir) => ([
  filePath,
  '--model', MODEL,
  '--language', WHISPER_LANG,
  '--task', 'transcribe',
  '--output_format', 'json',
  '--output_dir', outDir,
  '--temperature', '0.0',
  '--beam_size', '1',
  '--condition_on_previous_text', 'False',
  '--no_speech_threshold', NO_SPEECH,
  '--compression_ratio_threshold', '2.4',
  '--verbose', 'False',
]);
async function runWhisperOnce(device, filePath, outDir) {
  const args = [...BASE_ARGS(filePath, outDir), '--device', device, ...(device === 'cpu' ? ['--fp16', 'False'] : [])];
  if (DEBUG) console.info(`[whisper] exec: ${WHISPER_CMD} ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync(WHISPER_CMD, args, { env: process.env });
  if (DEBUG && stderr?.trim()) console.warn('[whisper][stderr]', stderr.trim());
  if (DEBUG && stdout?.trim()) console.info('[whisper][stdout]', stdout.trim());
}

// === ユーティリティ ==========================================================
function pickJsonPath(filePath) {
  const outDir = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  return path.join(outDir, `${baseName}.json`);
}
function stripClosers(text) {
  if (!STRIP_CLOSERS || !text) return text;
  const closers = [
    /(?:ご視聴|ご清聴)ありがとうございました[。！!]?$/u,
    /以上です[。！!]?$/u,
    /失礼いたします[。！!]?$/u,
  ];
  for (const re of closers) text = text.replace(re, '').trim();
  return text;
}

// 連呼抑止 + 人名の近似補正 + ユーザー辞書
function sanitizeFinal(text) {
  if (!text) return text;

  const hints = (process.env.ASR_HINTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let out = text.trim();

  // 1) ヒント語の機械連呼（4回以上）を最大2回に畳む
  const sep = String.raw`[\s、,]*`;
  for (const h of hints) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:${esc}${sep}){4,}`, 'g');
    out = out.replace(re, `${h}、${h}`);
  }
  // 2) 任意語の6連以上も念のため2回に
  out = out.replace(/(\S+)(?:\s*\1){5,}/g, '$1 $1');

  // 3) 人名の近似補正（ユーザー辞書の people を使う）
  try {
    const dict = loadUserDictionary();
    out = fuzzyPeopleReplace(out, dict.people || []);
  } catch { }

  // 4) 最後に辞書の置換を適用
  out = applyUserDictionary(out);

  return out || null;
}

// ★ 常駐ワーカー（singleton）+ クラッシュ時は封印
let fwWorker = null;
let fwWorkerDisabled = false;
function getFw() {
  if (!fwWorker) {
    fwWorker = new FWWorker({
      python: FW_PY,
      script: FW_WORKER_SCRIPT,
      init: {
        model: MODEL,
        device: FW_DEVICE,
        compute: FW_COMPUTE,
        lang: WHISPER_LANG,
        initial_prompt: process.env.ASR_HINTS || undefined,
      },
    });
  }
  return fwWorker;
}

// === メイン API ==============================================================
export async function transcribeAudioGPU(filePath) {
  const outDir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const jsonPath = path.join(outDir, `${base}.json`);
  try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch { }

  let usedImpl = 'whisper';

  // 1) ワーカー経路（低レイテンシ）
  if (USE_FW_WORKER && !fwWorkerDisabled) {
    try {
      const hotwordPrompt = buildPeopleHotwordPrompt({ repeats: 2 }); // 人名ホットワード
      const { text, segments } = await getFw().transcribe(filePath, {
        lang: WHISPER_LANG,
        prompt: hotwordPrompt || undefined,
      });
      const t = (Array.isArray(segments) && segments.length) ? segments.map(s => s.text || '').join('') : (text || '');
      return sanitizeFinal(stripClosers(t || '')) || null;
    } catch (e) {
      console.warn('[faster][worker] failed, fallback:', e?.message || e);
      fwWorkerDisabled = true; // クラッシュループ回避
    }
  }

  // 2) CLI 経路
  if (IMPL === 'faster') {
    try {
      await runFasterWhisper(filePath, outDir);
      usedImpl = 'faster';
    } catch {
      try { await runWhisperOnce('cuda', filePath, outDir); }
      catch (e1) {
        if (DEBUG) console.warn('[whisper] cuda failed; cpu fallback:', e1?.message || e1);
        try { await runWhisperOnce('cpu', filePath, outDir); }
        catch (e2) { console.error('[whisper] cpu fallback also failed:', e2?.message || e2); return null; }
      }
      usedImpl = 'whisper';
    }
  } else {
    try { await runWhisperOnce('cuda', filePath, outDir); }
    catch (e1) {
      if (DEBUG) console.warn('[whisper] cuda failed; cpu fallback:', e1?.message || e1);
      try { await runWhisperOnce('cpu', filePath, outDir); }
      catch (e2) { console.error('[whisper] cpu fallback also failed:', e2?.message || e2); return null; }
    }
    usedImpl = 'whisper';
  }

  // 3) 結果取り出し
  let text = null;
  if (fs.existsSync(jsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      text = Array.isArray(j?.segments) ? j.segments.map(s => s.text || '').join('') : (j?.text || '');
    } catch (e) {
      if (DEBUG) console.warn('[whisper] json parse failed:', e?.message || e);
    } finally {
      if (process.env.WHISPER_KEEP_JSON !== '1') { try { fs.unlinkSync(jsonPath); } catch { } }
    }
  }
  if (!text) {
    const txtPath = path.join(outDir, `${base}.txt`);
    if (fs.existsSync(txtPath)) {
      try { text = fs.readFileSync(txtPath, 'utf8').trim(); } catch { }
      if (process.env.WHISPER_KEEP_TXT !== '1') { try { fs.unlinkSync(txtPath); } catch { } }
    }
  }

  text = sanitizeFinal(stripClosers(text || ''));
  if (DEBUG) console.info('[asr] impl:', usedImpl, ' / text:', text);
  return text || null;
}

export async function transcribeAudioGPUStream(filePath, { onPartial } = {}) {
  if (USE_FW_WORKER && !fwWorkerDisabled) {
    const fw = getFw();
    try {
      // ストリーム対応を後日入れる場合のフック（今はバッチに近い挙動）
      const { text } = await fw.transcribe(filePath, { lang: WHISPER_LANG });
      onPartial?.(text || '');
      return text || null;
    } catch (e) {
      console.warn('[asr stream] failed, fallback to batch:', e?.message || e);
    }
  }
  return await transcribeAudioGPU(filePath);
}
