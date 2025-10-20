// src/utils/cleanup.js
import fs from 'fs/promises';
import path from 'path';

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.pcm', '.webm']);

/**
 * recordings ディレクトリ内をクリーンアップ
 * @param {object} opts
 * @param {string} opts.dir - ディレクトリパス
 * @param {number} [opts.maxAgeMinutes=0] - この分数より古いファイルのみ削除（0 なら全削除）
 * @param {boolean} [opts.dryRun=false] - true なら削除せずログだけ
 */
export async function cleanRecordingsDir({ dir, maxAgeMinutes = 0, dryRun = false } = {}) {
  const abs = path.resolve(dir);
  const now = Date.now();
  const maxAgeMs = Math.max(0, Number(maxAgeMinutes)) * 60 * 1000;

  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const targets = [];

    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (ent.name === '.gitkeep') continue;

      const full = path.join(abs, ent.name);
      const ext = path.extname(ent.name).toLowerCase();

      // 音声拡張子のみ対象（必要なら拡張子セットを調整）
      if (!AUDIO_EXTS.has(ext)) continue;

      let remove = true;
      if (maxAgeMs > 0) {
        const st = await fs.stat(full);
        const age = now - st.mtimeMs; // 更新時刻基準
        remove = age >= maxAgeMs;
      }

      if (remove) targets.push(full);
    }

    if (targets.length === 0) {
      console.log(`[cleanup] No files to remove in ${abs}`);
      return;
    }

    for (const file of targets) {
      if (dryRun) {
        console.log(`[cleanup][dry-run] ${file}`);
      } else {
        await fs.unlink(file).catch(err => {
          console.warn(`[cleanup] Failed to remove ${file}:`, err.message);
        });
      }
    }

    console.log(`[cleanup] Removed ${targets.length} file(s) in ${abs}${dryRun ? ' (dry-run)' : ''}`);
  } catch (err) {
    // ディレクトリが存在しなくてもエラーにしない
    if (err.code === 'ENOENT') {
      console.log(`[cleanup] Directory not found, skipped: ${abs}`);
      return;
    }
    console.error('[cleanup] Error:', err);
  }
}
