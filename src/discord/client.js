import { Client, GatewayIntentBits } from 'discord.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

export const GUILD_ID = process.env.GUILD_ID;           // ギルドID
export const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // VC ID
export const TEXT_CHANNEL_ID = process.env.TEXT_CHANNEL_ID;   // テキストCH ID
// ← ログインは index.js で行う（副作用を持たないモジュールに）