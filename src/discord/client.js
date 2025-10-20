import { Client, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';

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

// ✅ Botログインをこのファイルで完了させる（index.jsではready待ちのみ）
client.login(process.env.BOT_TOKEN)
  .then(() => console.log(`✅ Logged in as ${client.user.tag}`))
  .catch(console.error);
