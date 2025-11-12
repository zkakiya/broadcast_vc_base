import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { CFG } from '../config.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates, // ★必要
    // GatewayIntentBits.MessageContent, // 必要なら
  ],
  partials: [Partials.Channel],
});

// readyイベント例
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// 他で client を利用できるよう export
export default client; // ←default も併用しておくと安全
