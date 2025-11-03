// src/translate/providers/deepl.js
export class DeepLTranslator {
    constructor({ apiKey }) { this.apiKey = apiKey || process.env.DEEPL_API_KEY; }
    get name() { return 'deepl'; }

    async translate(text, { source, target }) {
        if (!text || !target) return null;
        if (!this.apiKey) return null;
        const url = 'https://api-free.deepl.com/v2/translate';
        const params = new URLSearchParams({
            text,
            target_lang: target.toUpperCase().replace('-', '_'),
        });
        if (source) params.set('source_lang', source.toUpperCase().replace('-', '_'));
        const r = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `DeepL-Auth-Key ${this.apiKey}` },
            body: params,
        });
        if (!r.ok) throw new Error(`DeepL ${r.status}`);
        const j = await r.json();
        return j.translations?.[0]?.text || null;
    }
}
