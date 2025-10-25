// /public/avatars.js
import { loadPositionConfig, POSITION_CONFIG, getPos, sanitizeDisplayName, ensureSocketIO, ensureContainer } from './common.js';

const stage = ensureContainer('stage');
const socket = ensureSocketIO();

const avatars = new Map(); // userId -> element

function place(el, pos) {
  if (!pos) return;
  el.style.left = (pos.x || 0) + 'px';
  el.style.top  = (pos.y || 0) + 'px';
  const scale = pos.scale || 1;
  el.style.transform = `scale(${scale})`;
  if (pos.mask) el.style.clipPath = pos.mask;
}

function ensureAvatar(userId, payload) {
  let el = avatars.get(userId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'avatar inactive';
    el.dataset.user = userId;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'img';
    const img = document.createElement('img');
    img.src = payload.avatar || payload.avatarUrl || payload.icon || '';
    img.alt = sanitizeDisplayName(payload.name || payload.displayName || userId);
    imgWrap.appendChild(img);

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = sanitizeDisplayName(payload.name || payload.displayName || 'Speaker');

    el.appendChild(imgWrap);
    el.appendChild(label);
    stage.appendChild(el);
    avatars.set(userId, el);

    place(el, getPos(userId));
  }
  return el;
}

function markActive(userId, ms = 30000) {
  const el = avatars.get(userId);
  if (!el) return;
  el.classList.remove('inactive');
  el.classList.add('active');
  clearTimeout(el._fadeT);
  el._fadeT = setTimeout(() => {
    el.classList.remove('active');
    el.classList.add('inactive');
  }, ms);
}

(async function boot() {
  await loadPositionConfig();
  avatars.forEach((el, userId) => place(el, getPos(userId)));
})();

if (socket) {
  socket.on('connect', () => console.log('[avatars] socket connected'));
  socket.on('transcript', (payload) => {
    const userId = String(payload.userId || payload.uid || '');
    if (!userId) return;
    const el = ensureAvatar(userId, payload);
    place(el, getPos(userId));
    markActive(userId, Number(getComputedStyle(document.documentElement).getPropertyValue('--fade-ms')) || 30000);
  });
  socket.on('transcript_update', (payload) => {
    // no-op for avatars
  });
}
