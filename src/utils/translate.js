// src/utils/translate.js
import { CONFIG } from '../config.js';

const hasOpenAI = !!process.env.OPENAI_API_KEY;
const hasDeepL = !!process.env.DEEPL_API_KEY;
const hasLibre = !!process.env.LIBRETRANSLATE_URL;

export async function translateText({ text, source, target }) {
  if (!CONFIG.translate.enabled) return null;
  if (!text || !target || target === source) return null;

  try {
    if (hasOpenAI) return await translateOpenAI(text, source, target);
    if (hasDeepL)  return await translateDeepL(text, source, target);
    if (hasLibre)  return await translateLibre(text, source, target);
    return null;
  } catch (e) {
    console.warn('[translate] failed:', e?.message || e);
    return null;
  }
}

async function translateOpenAI(text, source, target) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: `You are a translator. Translate from ${source ?? 'auto'} to ${target}. Output only the translation.` },
      { role: 'user', content: text },
    ],
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || null;
}

async function translateDeepL(text, source, target) {
  const url = 'https://api-free.deepl.com/v2/translate';
  const params = new URLSearchParams({
    text,
    target_lang: target.toUpperCase().replace('-', '_'),
  });
  if (source) params.set('source_lang', source.toUpperCase().replace('-', '_'));
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}` },
    body: params,
  });
  if (!r.ok) throw new Error(`DeepL ${r.status}`);
  const j = await r.json();
  return j.translations?.[0]?.text || null;
}

async function translateLibre(text, source, target) {
  const url = `${process.env.LIBRETRANSLATE_URL}/translate`;
  const body = { q: text, source: source || 'auto', target };
  if (process.env.LIBRETRANSLATE_API_KEY) body.api_key = process.env.LIBRETRANSLATE_API_KEY;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LibreTranslate ${r.status}`);
  const j = await r.json();
  return j.translatedText || null;
}
