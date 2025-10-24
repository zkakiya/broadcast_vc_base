// src/discord/transcribe.js
// Node -> Python Whisper CLI を実行して文字起こし
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);

// ★ Whisper の Python 実行ファイル（環境に合わせて変更可）
const WHISPER_PY = process.env.WHISPER_PY || '/home/z_kakiya/whisper-venv/bin/python';

// Whisper CLI で “締めの作文” を抑止するための堅めの既定
// - condition_on_previous_text False: 文脈継続を禁止（勝手な補完防止）
// - temperature 0.0: ランダム性をゼロ（創作を抑止）
// - beam_size 1: 単一案のみ（探索での冗長生成を抑止）
// - no_speech_threshold 0.4: 無音検知を強めに（ノイズでの誤起動防止）
// - compression_ratio_threshold 2.4: 不自然な冗長テキストを棄却
const BASE_ARGS = (filePath, outDir) => ([
  '-m', 'whisper',
  filePath,
  '--model', process.env.WHISPER_MODEL || 'small', // small 推奨（負荷と精度のバランス）
  '--language', 'ja',
  '--task', 'transcribe',
  '--output_format', 'json',
  '--output_dir', outDir,
  '--temperature', '0.0',
  '--beam_size', '1',
  '--condition_on_previous_text', 'False',
  '--no_speech_threshold', process.env.WHISPER_NO_SPEECH ?? '0.3',
  '--compression_ratio_threshold', '2.4',
]);

/**
 * WAVファイルを Whisper (Python) で文字起こし
 * - まず GPU (cuda)、失敗時に CPU (--fp16 False) へフォールバック
 * - 出力 .txt は同ディレクトリへ生成 → 直後に読み取り・削除
 * @param {string} filePath WAV ファイルパス
 * @returns {Promise<string|null>}
 */
export async function transcribeAudioGPU(filePath) {
  const outDir = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const jsonPath = path.join(outDir, `${baseName}.json`);

  const args = BASE_ARGS(filePath, outDir);

  // 1) GPU (cuda)
  try {
    await execFileAsync(WHISPER_PY, [...args, '--device', 'cuda']);
  } catch (e) {
    // 2) CPU フォールバック（fp16 無効化で安定）
    try {
      await execFileAsync(WHISPER_PY, [...args, '--device', 'cpu', '--fp16', 'False']);
    } catch (ee) {
      // どちらも失敗
      throw ee;
    }
  }

  if (!fs.existsSync(jsonPath)) return null;

  // Whisper JSON を解析して低信頼セグメントを除外
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const segs = Array.isArray(j?.segments) ? j.segments : [];

  const MIN_AVG_LOGPROB = Number(process.env.WHISPER_MIN_AVG_LOGPROB ?? -1.0);   // これ未満は捨て
  const MAX_NO_SPEECH   = Number(process.env.WHISPER_MAX_NO_SPEECH ?? 0.60);    // これ超えは捨て

  const kept = [];
  for (const s of segs) {
    const lp = Number(s?.avg_logprob ?? 0);
    const ns = Number(s?.no_speech_prob ?? 0);
    if (lp < MIN_AVG_LOGPROB) continue;
    if (ns > MAX_NO_SPEECH) continue;
    if (typeof s?.text === 'string' && s.text.trim()) {
      kept.push(s.text);
    }
  }

  let text = kept.join('').trim();

  // 任意: 末尾の「ありがち締め文」を剥がす（誤補完に効く）
  if (text) {
    const STRIP_CLOSERS = (process.env.WHISPER_STRIP_CLOSERS ?? '1') === '1';
    if (STRIP_CLOSERS) {
      const closers = [
        /(?:ご視聴|ご清聴)ありがとうございました[。！!]?$/u,
        /以上です[。！!]?$/u,
        /失礼いたします[。！!]?$/u,
      ];
      for (const re of closers) text = text.replace(re, '').trim();
    }
  }

  // 後片付け
  try { fs.unlinkSync(jsonPath); } catch {}
  return text || null;
}
