// src/translate/providers/google.js
export class GoogleTranslator {
    constructor({ apiKey } = {}) {
        this.apiKey = apiKey || process.env.OPENAI_API_KEY; // 互換
    }
    get name() { return 'google-openai'; }

    async translate(text, { source = 'auto', target }) {
        if (!text || !target) return null;
        if (!this.apiKey) return null;

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
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`OpenAI ${r.status}`);
        const j = await r.json();
        return j.choices?.[0]?.message?.content?.trim() || null;
    }
}
