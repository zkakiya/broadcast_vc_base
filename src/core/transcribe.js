// src/discord/transcribe.js
// Node -> Whisper を実行して文字起こし（faster-whisper 切替可 / GPU優先 / CPUフォールバック / 起動時にGPU自己診断）

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FWWorker } from '../core/asr/worker.js';
import { execFile, execFileSync } from 'child_process';
import util from 'util';
import { applyUserDictionary, getPersonProtectSet } from '../utils/dictionary.js';

const execFileAsync = util.promisify(execFile);

// ── ESM: __dirname 相当 ─────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === 実装切替・共通設定 ========================================================
let IMPL = (process.env.WHISPER_IMPL || 'whisper').toLowerCase(); // 'faster' | 'whisper'
const MODEL = process.env.WHISPER_MODEL || 'small';                // 速度寄りの既定
const WHISPER_LANG = process.env.WHISPER_LANG || 'ja';

const NO_SPEECH = process.env.WHISPER_NO_SPEECH ?? '0.3';
const STRIP_CLOSERS = (process.env.WHISPER_STRIP_CLOSERS ?? '1') === '1';
const DEBUG = process.env.WHISPER_DEBUG === '1';

// faster-whisper 常駐ワーカー切替
const USE_FW_WORKER = process.env.FW_WORKER === '1';
const FW_PY = process.env.WHISPER_PY || '/home/z_kakiya/whisper-venv/bin/python';

// ★ このファイル基準でパスを解決（CWDに依存しない）
const FW_WORKER_SCRIPT = path.resolve(__dirname, '../core/fw_worker.py');

// faster-whisper ランナー設定（CLI呼び出し版）
const FW_RUNNER = path.resolve(__dirname, '../core/fw_runner.py');
const FW_DEVICE = process.env.FASTER_WHISPER_DEVICE || 'cuda';     // cuda / cpu
const FW_COMPUTE = process.env.FW_COMPUTE_TYPE || 'float16';        // float16 / int8_float16 / int8

// === Whisper CLI の解決 =======================================================
function resolveWhisperCmd() {
  const fromEnv = process.env.WHISPER_CMD;
  const candidates = [
    fromEnv,
    '/usr/local/bin/whisper',
    '/usr/bin/whisper',
    'whisper', // PATH に任せる
  ].filter(Boolean);

  // PATH検索を先に試す
  try {
    const found = execFileSync('bash', ['-lc', 'command -v whisper'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch { /* noop */ }

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* noop */ }
  }

  const searchList = [
    `PATH=${process.env.PATH || ''}`,
    ...candidates.map(p => `candidate: ${p}`),
  ].join('\n  ');
  throw new Error(`[whisper] executable not found.\n  ${searchList}`);
}

const WHISPER_CMD = resolveWhisperCmd();

// === whisper の shebang から python を推定 → CUDA 自己診断 ===================
function detectPythonFromWhisper(cmd) {
  try {
    const head = fs.readFileSync(cmd, 'utf8').split('\n')[0] || '';
    const m = head.match(/^#!\s*(.*python[0-9.]*)/i);
    return m ? m[1].trim() : null; // 例: /usr/bin/python3
  } catch {
    return null; // バイナリの場合など
  }
}

function probeCuda() {
  const py = detectPythonFromWhisper(WHISPER_CMD);
  if (!py) {
    if (DEBUG) console.info('[whisper] no python shebang detected; skip CUDA probe');
    return;
  }
  try {
    const out = execFileSync(
      py,
      ['-c', 'import torch,sys;print("torch",torch.__version__);print("cuda",torch.cuda.is_available());print("cuda_ver",getattr(torch.version,"cuda",None));'],
      { encoding: 'utf8' }
    );
    console.info('[whisper][probe]\n' + out.trim());
  } catch (e) {
    console.warn('[whisper][probe] failed to run python torch check:', e?.message || e);
  }
}
probeCuda();

// === 実行系：faster-whisper & Whisper CLI ====================================

// faster-whisper（fw_runner.py）を呼び出す
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

// Whisper CLI（GPU → CPUフォールバック）
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
  '--verbose', 'False', // 端末へのセグメント出力抑止
]);

async function runWhisperOnce(device, filePath, outDir) {
  const args = [
    ...BASE_ARGS(filePath, outDir),
    '--device', device,
    ...(device === 'cpu' ? ['--fp16', 'False'] : []),
  ];
  if (DEBUG) console.info(`[whisper] exec: ${WHISPER_CMD} ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync(WHISPER_CMD, args, { env: process.env });
  if (DEBUG && stderr?.trim()) console.warn('[whisper][stderr]', stderr.trim());
  if (DEBUG && stdout?.trim()) console.info('[whisper][stdout]', stdout.trim());
}

// === ユーティリティ：JSON 読み出し・テキスト整形 =============================
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

function filterSegments(segments) {
  const MIN_AVG_LOGPROB = Number(process.env.WHISPER_MIN_AVG_LOGPROB ?? -1.0);
  const MAX_NO_SPEECH = Number(process.env.WHISPER_MAX_NO_SPEECH ?? 0.60);

  const kept = [];
  for (const s of (segments || [])) {
    const lp = Number(s?.avg_logprob ?? 0);
    const ns = Number(s?.no_speech_prob ?? 0);
    if (lp < MIN_AVG_LOGPROB) continue;
    if (ns > MAX_NO_SPEECH) continue;
    if (typeof s?.text === 'string' && s.text.trim()) kept.push(s.text);
  }
  return kept.join('').trim();
}

// ★ 常駐ワーカー（singleton）
let fwWorker = null;
let fwWorkerDisabled = false; // ★ 追加：クラッシュ検知で当面は使わない

function getFw() {
  if (!fwWorker) {
    fwWorker = new FWWorker({
      python: FW_PY,
      script: FW_WORKER_SCRIPT, // ← __dirname 基準で安定
      init: {
        model: process.env.WHISPER_MODEL || 'small',
        device: process.env.FASTER_WHISPER_DEVICE || 'cuda',
        compute: process.env.FW_COMPUTE_TYPE || 'float16',
        lang: process.env.WHISPER_LANG || 'ja',
        initial_prompt: process.env.ASR_HINTS || undefined,
      },
    });
  }
  return fwWorker;
}

// === メイン API ===============================================================
export async function transcribeAudioGPU(filePath) {
  const outDir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const jsonPath = path.join(outDir, `${base}.json`);

  // 前回の残骸を掃除
  try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch { /* noop */ }

  let usedImpl = 'whisper'; // 実際に使った実装名（ログ用）

  // 1) FW_WORKER を優先
  if (USE_FW_WORKER && !fwWorkerDisabled) {
    try {
      const { text, segments } = await getFw().transcribe(filePath, {
        lang: process.env.WHISPER_LANG || 'ja',
      });
      const t = filterSegments(segments) || (text || '').trim();
      return stripClosers(t || '') || null;
    } catch (e) {
      console.warn('[faster][worker] failed, fallback to existing path:', e?.message || e);
      // このプロセス生存中はワーカー経路を封印（クラッシュループを防ぐ）
      fwWorkerDisabled = true;
      // 以降は既存ルートへフォールバック
    }
  }

  if (IMPL === 'faster') {
    // 2) faster-whisper を選択している場合はまず試す
    try {
      await runFasterWhisper(filePath, outDir);
      usedImpl = 'faster';
    } catch (e) {
      if (DEBUG) console.warn('[faster] failed, fallback to whisper:', e?.message || e);
      // フォールバック（whisper → cuda → cpu）
      try {
        await runWhisperOnce('cuda', filePath, outDir);
      } catch (e1) {
        if (DEBUG) console.warn('[whisper] cuda failed; fallback to cpu:', e1?.message || e1);
        try {
          await runWhisperOnce('cpu', filePath, outDir);
        } catch (e2) {
          console.error('[whisper] cpu fallback also failed:', e2?.message || e2);
          return null;
        }
      }
      usedImpl = 'whisper';
    }
  } else {
    // 3) IMPL=whisper の場合は従来どおり
    try {
      await runWhisperOnce('cuda', filePath, outDir);
    } catch (e1) {
      if (DEBUG) console.warn('[whisper] cuda failed; fallback to cpu:', e1?.message || e1);
      try {
        await runWhisperOnce('cpu', filePath, outDir);
      } catch (e2) {
        console.error('[whisper] cpu fallback also failed:', e2?.message || e2);
        return null;
      }
    }
    usedImpl = 'whisper';
  }

  // 取り出し（JSON）
  let text = null;
  if (fs.existsSync(jsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (Array.isArray(j?.segments)) text = filterSegments(j.segments);
      else if (typeof j?.text === 'string') text = j.text.trim();
    } catch (e) {
      if (DEBUG) console.warn('[whisper] json parse failed:', e?.message || e);
    } finally {
      if (process.env.WHISPER_KEEP_JSON !== '1') {
        try { fs.unlinkSync(jsonPath); } catch { /* noop */ }
      }
    }
  }

  // 念のため .txt フォールバック（互換）
  if (!text) {
    const txtPath = path.join(outDir, `${base}.txt`);
    if (fs.existsSync(txtPath)) {
      try { text = fs.readFileSync(txtPath, 'utf8').trim(); } catch { /* noop */ }
      if (process.env.WHISPER_KEEP_TXT !== '1') {
        try { fs.unlinkSync(txtPath); } catch { /* noop */ }
      }
    }
  }

  function sanitizeRepeats(text) {
    if (!text) return text;
    const hints = (process.env.ASR_HINTS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    let out = text;

    // 1) ヒント語が「4回以上」連なるとき、最大2回に畳む（区切りは空白/読点/カンマを許容）
    const sep = String.raw`[\s、,]*`;
    for (const h of hints) {
      if (!h) continue;
      const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 正規表現エスケープ
      const re = new RegExp(`(?:${esc}${sep}){4,}`, 'g');
      out = out.replace(re, `${h}、${h}`);
    }

    // 2) 任意語の“機械連呼”も保険で畳む（同一トークン6連以上 → 2回に）
    out = out.replace(/(\S+)(?:\s*\1){5,}/g, '$1 $1');

    return out;
  }

  text = sanitizeRepeats(stripClosers(text || ''));
  text = applyUserDictionary(text);
  if (DEBUG) console.info('[asr] impl:', usedImpl, ' / text:', text);
  return text || null;
}

export async function transcribeAudioGPUStream(filePath, { onPartial } = {}) {
  // ワーカーが有効なら逐次
  if (USE_FW_WORKER) {
    const fw = getFw();
    try {
      let finalText = '';
      finalText = await fw.transcribeStream(
        filePath,
        { lang: process.env.WHISPER_LANG || 'ja' },
        {
          onPartial: (p) => {
            // p.text を都度 Append で上げる
            onPartial?.(String(p.text || ''));
          },
          onFinal: () => { /* no-op */ },
        }
      );
      return finalText || null;
    } catch (e) {
      console.warn('[asr stream] failed, fallback to batch:', e?.message || e);
      // バッチへ
    }
  }
  // フォールバック：従来バッチ
  return await transcribeAudioGPU(filePath);
}