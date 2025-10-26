// src/discord/transcribe.js
// Node -> Whisper CLI を実行して文字起こし（GPU優先, CPUフォールバック, 起動時にGPU自己診断）

import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

// === 1) whisperコマンド解決（PATH/代表パス/環境変数から堅牢に探す） ==========
function resolveWhisperCmd() {
  const fromEnv = process.env.WHISPER_CMD;
  const candidates = [
    fromEnv,
    '/usr/local/bin/whisper',
    '/usr/bin/whisper',
    'whisper', // PATH 任せ
  ].filter(Boolean);

  // PATH検索
  try {
    const found = execFileSync('bash', ['-lc', 'command -v whisper'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch { }

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { }
  }

  const searchList = [
    `PATH=${process.env.PATH || ''}`,
    ...candidates.map(p => `candidate: ${p}`)
  ].join('\n  ');
  throw new Error(`[whisper] executable not found.\n  ${searchList}`);
}

const WHISPER_CMD = resolveWhisperCmd();
const MODEL = process.env.WHISPER_MODEL || 'medium'; // 以前の運用に近づけて既定をmediumに
const NO_SPEECH = process.env.WHISPER_NO_SPEECH ?? '0.3';
const STRIP_CLOSERS = (process.env.WHISPER_STRIP_CLOSERS ?? '1') === '1';
const DEBUG = process.env.WHISPER_DEBUG === '1';

// === 2) whisperスクリプトのshebangからPython推定 → torch/cuda自己診断 ==========
function detectPythonFromWhisper(cmd) {
  try {
    const head = fs.readFileSync(cmd, 'utf8').split('\n')[0] || '';
    const m = head.match(/^#!\s*(.*python[0-9.]*)/i);
    return m ? m[1].trim() : null; // 例: /usr/bin/python3
  } catch {
    return null; // バイナリの場合などは無視
  }
}

function probeCuda() {
  const py = detectPythonFromWhisper(WHISPER_CMD);
  if (!py) {
    if (DEBUG) console.info('[whisper] no python shebang detected; skip CUDA probe');
    return;
  }
  try {
    const out = execFileSync(py, ['-c',
      'import torch,sys;print("torch",torch.__version__);print("cuda",torch.cuda.is_available());print("cuda_ver",getattr(torch.version,"cuda",None));'],
      { encoding: 'utf8' });
    console.info('[whisper][probe]\n' + out.trim());
  } catch (e) {
    console.warn('[whisper][probe] failed to run python torch check:', e?.message || e);
  }
}
probeCuda();

// === 実行時ENV（venv優先 + GPU可視化） ==========================
function buildExecEnv() {
  // whisper の shebang から venv/bin を推定
  let py = null, venvBin = null, venvDir = null;
  try { py = detectPythonFromWhisper(WHISPER_CMD); } catch { }
  if (py) { venvBin = path.dirname(py); venvDir = path.dirname(venvBin); }
  const env = {
    ...process.env,
    PATH: venvBin ? `${venvBin}:${process.env.PATH || ''}` : (process.env.PATH || ''),
    VIRTUAL_ENV: venvDir || process.env.VIRTUAL_ENV,
    // Node をどう起動しても GPU 0 を見せる（未設定時のみ）
    CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES ?? '0',
  };
  if (DEBUG) {
    const head = (env.PATH || '').split(':').slice(0, 3);
    console.info('[whisper][env] PATH(head)=', head, ' VIRTUAL_ENV=', env.VIRTUAL_ENV, ' CUDA_VISIBLE_DEVICES=', env.CUDA_VISIBLE_DEVICES);
  }
  return env;
}
const EXEC_ENV = buildExecEnv();


// === SELF TEST: Node経由でもGPUが見えるか強制チェック =========================
// 環境変数 WHISPER_SELFTEST=1 のときだけ実行（本番では無効）
function selfTestCuda() {
  if (process.env.WHISPER_SELFTEST !== '1') return;
  const py = detectPythonFromWhisper(WHISPER_CMD);
  if (!py) { console.warn('[whisper][selftest] no python shebang; skip'); return; }
  try {
    console.info('[whisper][selftest] allocating CUDA tensor for ~10s via', py);
    // 大きめのCUDAテンソルを確保して 10 秒保持 → nvidia-smi で必ず見える
    execFileSync(py, ['-c', `
import torch, time
assert torch.cuda.is_available(), "cuda.is_available() is False"
_ = torch.empty((4096,4096), device="cuda", dtype=torch.float16)
print("ok: cuda tensor allocated; sleeping 10s...", flush=True)
time.sleep(10)
print("done", flush=True)
`], { env: EXEC_ENV, encoding: 'utf8', stdio: 'inherit' });
  } catch (e) {
    console.warn('[whisper][selftest] failed:', e?.message || e);
  }
}
selfTestCuda();

// === 3) 共通引数 ==============================================================
const BASE_ARGS = (filePath, outDir) => ([
  filePath,
  '--model', MODEL,
  '--language', 'ja',
  '--task', 'transcribe',
  '--output_format', 'json',
  '--output_dir', outDir,
  '--temperature', '0.0',
  '--beam_size', '1',
  '--condition_on_previous_text', 'False',
  '--no_speech_threshold', NO_SPEECH,
  '--compression_ratio_threshold', '2.4',
  // ターミナルへセグメントを出させない（[00:..] 行を抑止）
  '--verbose', 'False',
]);

async function runWhisperOnce(device, filePath, outDir) {
  const args = [
    ...BASE_ARGS(filePath, outDir),
    '--device', device,
    ...(device === 'cpu' ? ['--fp16', 'False'] : []),
    // DEBUG=0 のときも progress は付けない（Whisper CLI 非対応のため）
    // verbose 抑制は BASE_ARGS 側の '--verbose False' で十分
  ];

  if (DEBUG) console.info(`[whisper] exec: ${WHISPER_CMD} ${args.join(' ')}`);

  try {
    const { stdout, stderr } = await execFileAsync(WHISPER_CMD, args, {
      env: process.env, // stdio は既定（pipe）のまま
    });
    if (DEBUG && stderr?.trim()) console.warn('[whisper][stderr]', stderr.trim());
    if (DEBUG && stdout?.trim()) console.info('[whisper][stdout]', stdout.trim());
    return { stdout, stderr, device };
  } catch (e) {
    if (e?.code === 'ENOENT') {
      console.error('[whisper] ENOENT: whisper command not found at runtime. WHISPER_CMD or PATH may be wrong. cmd=', WHISPER_CMD);
    }
    throw e;
  }
}

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

// === 4) メイン ================================================================
export async function transcribeAudioGPU(filePath) {
  const outDir = path.dirname(filePath);
  const jsonPath = pickJsonPath(filePath);

  // 前回の残骸を掃除
  try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch { }

  // GPU → CPUフォールバック
  let result;
  try {
    console.info(`[whisper] run (cuda)  cmd=${WHISPER_CMD} model=${MODEL}`);
    result = await runWhisperOnce('cuda', filePath, outDir);
  } catch (e) {
    console.warn('[whisper] cuda failed; fallback to CPU (--fp16 False). err=', e?.message || e);
    try {
      result = await runWhisperOnce('cpu', filePath, outDir);
    } catch (ee) {
      console.error('[whisper] cpu fallback also failed:', ee?.message || ee);
      return null;
    }
  }

  // 取り出し（JSON → stdout → txt）
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

  if (!text && result?.stdout) {
    try {
      // Whisper が何かを stdout に出していた場合のフォールバック。
      // タイムスタンプ行（[00:00.000 --> 00:02.000] ...）は削除してから結合する。
      const raw = result.stdout;
      const lines = raw.split(/\r?\n/);
      const cleanedLines = lines
        // SRT/verbose 風のタイムスタンプ行は丸ごと捨てる
        .filter(l => !/^\s*\[\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}\.\d{3}\]\s*/.test(l))
        // それ以外の行はそのまま
        .map(l => l.trim())
        .filter(Boolean);
      const trimmed = cleanedLines.join(' ').trim();
      if (trimmed.startsWith('{')) {
        const j = JSON.parse(trimmed);
        if (Array.isArray(j?.segments)) text = filterSegments(j.segments);
        else if (typeof j?.text === 'string') text = j.text.trim();
      } else {
        text = trimmed;
      }
    } catch { }
  }

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
  if (DEBUG) console.info('[whisper] device used:', result?.device, ' / text:', text);
  return text || null;
}
