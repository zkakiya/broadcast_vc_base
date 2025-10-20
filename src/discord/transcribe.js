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
  '--output_format', 'txt',
  '--output_dir', outDir,
  '--temperature', '0.0',
  '--beam_size', '1',
  '--condition_on_previous_text', 'False',
  '--no_speech_threshold', '0.4',
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
  const txtPath = path.join(outDir, `${baseName}.txt`);

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

  if (!fs.existsSync(txtPath)) return null;

  const text = fs.readFileSync(txtPath, 'utf8').trim();

  // 後片付け
  try { fs.unlinkSync(txtPath); } catch {}

  return text || null;
}
