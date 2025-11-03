// src/translate/index.js
import { CFG } from '../config.js';
import { GoogleTranslator } from './providers/google.js';
import { DeepLTranslator } from './providers/deepl.js';
import { AzureTranslator } from './providers/azure.js';

let singleton = null;

export function getTranslator() {
    if (singleton) return singleton;

    const p = (CFG.translate?.provider || 'google').toLowerCase();
    switch (p) {
        case 'deepl':
            singleton = new DeepLTranslator({ apiKey: CFG.translate.deeplKey });
            break;
        case 'azure':
            singleton = new AzureTranslator({ apiKey: CFG.translate.azureKey, region: CFG.translate.azureRegion });
            break;
        case 'libre':
            singleton = new LibreTranslator({ url: process.env.LIBRETRANSLATE_URL, apiKey: process.env.LIBRETRANSLATE_API_KEY });
            break;
        default:
            singleton = new GoogleTranslator({ apiKey: process.env.OPENAI_API_KEY });
    }
    return singleton;
}
