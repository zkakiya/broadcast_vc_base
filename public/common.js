// /public/common.js
// Shared helpers for broadcast_vc_base frontends

export const POSITION_CONFIG_URL = window.POSITION_CONFIG_URL || '/position.config.json';

// Fallback POSITION_CONFIG (can be overridden by external JSON)
export let POSITION_CONFIG = {
  // "userId": { x: 100, y: 120, scale: 1.0, mask: "" }
};

export function loadPositionConfig() {
  return fetch(POSITION_CONFIG_URL, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : {})
    .then(cfg => { POSITION_CONFIG = cfg || {}; return POSITION_CONFIG; })
    .catch(() => POSITION_CONFIG);
}

export function getPos(userId) {
  return POSITION_CONFIG[userId] || null;
}

export function sanitizeDisplayName(name) {
  return String(name || '').replace(/\[[^\]]+\]/g, '').trim();
}

export function ensureSocketIO() {
  // socket.io is assumed to be served at /socket.io/socket.io.js
  if (!window.io) {
    console.error('Socket.IO client not found. Include /socket.io/socket.io.js');
  }
  return window.io?.();
}

export function ensureContainer(elId) {
  const el = document.getElementById(elId);
  if (!el) throw new Error(`#${elId} not found`);
  return el;
}
