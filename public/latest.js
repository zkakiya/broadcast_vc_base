// /public/latest.js
import { sanitizeDisplayName, ensureSocketIO } from './common.js';
const socket = ensureSocketIO();

const bubble = document.getElementById('bubble');
const nameEl = bubble.querySelector('.name');
const textEl = bubble.querySelector('.text');
const trEl = bubble.querySelector('.tr');

let currentId = null;
let hideTimer = null;

function show(payload) {
  currentId = payload.id;
  nameEl.textContent = sanitizeDisplayName(payload.name || payload.displayName || 'Speaker');
  textEl.textContent = payload.text || '';
  trEl.textContent = ''; // reset translation
  bubble.classList.remove('hidden');
  bubble.classList.add('show');

  clearTimeout(hideTimer);
  const ms = Number(getComputedStyle(document.documentElement).getPropertyValue('--show-ms')) || 30000;
  hideTimer = setTimeout(() => hide(), ms);
}

function hide() {
  bubble.classList.remove('show');
  bubble.classList.add('hidden');
  currentId = null;
}

function update(payload) {
  if (!currentId || payload.id !== currentId) return;
  const tr = payload?.tr || payload?.append?.translation;
  if (!tr) return;
  if (tr.text) {
    trEl.textContent = tr.text;
  } else {
    const one = Object.values(tr)[0];
    if (typeof one === 'string') trEl.textContent = one;
  }
}

if (socket) {
  socket.on('connect', () => console.log('[latest] socket connected'));
  socket.on('transcript', (payload) => show(payload));
  socket.on('transcript_update', (payload) => update(payload));
}
