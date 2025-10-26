// src/discord/transcribe.js
// Node -> Whisper を実行して文字起こし（faster-whisper 切替可 / GPU優先 / CPUフォールバック / 起動時にGPU自己診断）

import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

// === 実装切替・共通設定 ========================================================
let IMPL = (process.env.WHISPER_IMPL || 'whisper').toLowerCase(); // 'faster' | 'whisper'
const MODEL = process.env.WHISPER_MODEL || 'small';                // 速度寄りの既定
const WHISPER_LANG = process.env.WHISPER_LANG || 'ja';

const NO_SPEECH = process.env.WHISPER_NO_SPEECH ?? '0.3';
const STRIP_CLOSERS = (process.env.WHISPER_STRIP_CLOSERS ?? '1') === '1';
const DEBUG = process.env.WHISPER_DEBUG === '1';

// faster-whisper ランナー設定
const FW_PY = process.env.WHISPER_PY || '/home/z_kakiya/whisper-venv/bin/python';
const FW_RUNNER = path.join(process.cwd(), 'src/core/fw_runner.py');
const FW_DEVICE = process.env.FASTER_WHISPER_DEVICE || 'cuda';     // cuda / cpu
const FW_COMPUTE = process.env.FW_COMPUTE_TYPE || 'float16';       // float16 / int8_float16 / int8

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
  } catch { }

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { }
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

// === メイン API ===============================================================
export async function transcribeAudioGPU(filePath) {
  const outDir = path.dirname(filePath);
  const jsonPath = pickJsonPath(filePath);

  // 前回の残骸を掃除
  try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch { }

  let usedImpl = 'whisper'; // 実際に使った実装名（ログ用）

  // 1) faster-whisper を選択している場合はまず試す
  if (IMPL === 'faster') {
    try {
      await runFasterWhisper(filePath, outDir);
      usedImpl = 'faster';
    } catch (e) {
      if (DEBUG) console.warn('[faster] failed, fallback to whisper:', e?.message || e);
      // フォールバックして続行
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
    // 2) IMPL=whisper の場合は従来どおり
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
        try { fs.unlinkSync(jsonPath); } catch { }
      }
    }
  }

  // 旧来の stdout / .txt フォールバックは、--output_format json 指定で基本不要。
  // 念のため .txt があれば読む（互換）
  if (!text) {
    const base = path.basename(filePath, path.extname(filePath));
    const txtPath = path.join(outDir, `${base}.txt`);
    if (fs.existsSync(txtPath)) {
      try { text = fs.readFileSync(txtPath, 'utf8').trim(); } catch { }
      if (process.env.WHISPER_KEEP_TXT !== '1') {
        try { fs.unlinkSync(txtPath); } catch { }
      }
    }
  }

  text = stripClosers(text || '');
  if (DEBUG) console.info('[asr] impl:', usedImpl, ' / text:', text);
  return text || null;
}
