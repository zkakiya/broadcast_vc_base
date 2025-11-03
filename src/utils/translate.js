// src/utils/translate.js
import { CFG } from '../config.js';
import { getTranslator } from '../translate/index.js';

export async function translateText({ text, source, target }) {
  const enabled = (CFG.translate?.enabled ?? true);
  if (!enabled) return null;

  // target未指定時は既定ターゲット（例: 環境変数で en など）を使う
  const to = target || CFG.translate.defaultTarget;
  if (!text || !to || to === source) return null;

  try {
    const provider = getTranslator();
    return await provider.translate(text, { source, target: to });
  } catch (e) {
    console.warn('[translate] failed:', e?.message || e);
    return null;
  }
}
