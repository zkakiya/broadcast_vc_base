// src/translate/providers/azure.js
export class AzureTranslator {
    constructor({ apiKey, region }) {
        this.apiKey = apiKey || process.env.AZURE_TRANSLATOR_KEY;
        this.region = region || process.env.AZURE_TRANSLATOR_REGION;
    }
    get name() { return 'azure'; }

    async translate(text, { source = 'auto', target }) {
        if (!text || !target) return null;
        if (!this.apiKey || !this.region) return null;

        const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(target)}${source ? `&from=${encodeURIComponent(source)}` : ''}`;
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': this.apiKey,
                'Ocp-Apim-Subscription-Region': this.region,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([{ Text: text }]),
        });
        if (!r.ok) throw new Error(`Azure ${r.status}`);
        const j = await r.json();
        return j?.[0]?.translations?.[0]?.text || null;
    }
}
