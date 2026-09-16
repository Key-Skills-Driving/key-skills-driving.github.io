import { db } from './db.js';
import {
  DEFAULT_MODEL, systemPrompt, userMessage, modifyMessage, copyPrompt, looksLikeOurPrompt, cleanReply,
  writeWithChatGPT, checkKey, writeWithGemini, checkGeminiKey, normalizeStyle, styleIsSet, STYLE_LIMITS,
} from './ai.js';
import { qrSvg } from './review.js';

// Bump together with CACHE in sw.js on every release.
const VERSION = '3.4.0';

const AI_APPS = {
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  claude: { label: 'Claude', url: 'https://claude.ai/new' },
};
const REVIEW_DEFAULTS = {
  reviewUrl: 'https://tinyurl.com/KeySkillsReview',
  schoolName: 'Key Skills Driving School',
  reviewFooter: 'Thank you for supporting a veteran-owned business',
};

// geminiKey: free Google Gemini key. apiKey: optional paid OpenAI key.
// style: how this instructor likes breakdowns written (tone, length, sign-off, examples of their writing).
const defaultSettings = () => ({ lastBackup: null, geminiKey: '', apiKey: '', model: DEFAULT_MODEL, extra: '', style: normalizeStyle({}), ...REVIEW_DEFAULTS });
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const APP_URL = new URL('./', location.href).href;
// Google issues Gemini keys in two shapes: the older AIza… and the newer AQ.… ones.
const GEMINI_KEY = /(?:AIza[\w-]{30,}|AQ\.[\w.-]{25,})/;
const findKey = (text) => text.match(GEMINI_KEY)?.[0].replace(/\.+$/, '') || '';

// The school server (worker/ in this repo). Phones an admin has approved write breakdowns through
// it with the school's Gemini key, so staff never need a key of their own.
const SCHOOL_API = location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://ksds-lessons.ksds-lessons-worker.workers.dev';
// This phone's identity on the school server: made up on this phone, approved by an admin once.
// status: none | pending | approved | removed. adminExists is null until the server's been asked.
const defaultDevice = () => ({ id: '', token: '', status: 'none', name: '', admin: false, adminExists: null });

const state = {
  items: new Map(), // saved breakdowns: the ones you write up, plus prewritten ones
  settings: defaultSettings(),
  device: defaultDevice(),
  phones: null, // the admin's list from the school server
  pendingCount: 0, // phones waiting for an admin's approval (admins only)
  installPrompt: null, // Android's install prompt, held until the Install button is tapped
  justInstalled: false,
  addingExample: false, // the paste-an-example box in Settings is open
  draft: { raw: '', result: '', savedId: null }, // the breakdown in progress on the first tab
  modify: null, // { id, change, result, busy }: asking the AI to change a saved breakdown
  busy: false,
  editingResult: false,
  query: '',
  lastView: '',
};

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  starLine: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2.5 14.25,9.2 21.3,9.2 15.6,13.3 17.7,20 12,15.9 6.3,20 8.4,13.3 2.7,9.2 9.75,9.2"/></svg>',
  star: '<svg class="star-ico" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2 14.25,8.91 21.51,8.91 15.63,13.18 17.88,20.09 12,15.82 6.12,20.09 8.37,13.18 2.49,8.91 9.75,8.91"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  zap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>',
};

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- small helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const prettyUrl = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');

function whenLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function highlight(text, terms) {
  if (!terms.length) return esc(text);
  const re = new RegExp(`(${terms.map(escRe).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Keeps the screen from dimming while something needs it: the review card is up, a breakdown
// is being written, or you're dictating into the notes box. iOS drops the lock whenever the
// app goes to the background, so it's taken again when the app comes back.
const awakeReasons = new Set();
let wakeLock = null;
let wakeChain = Promise.resolve();

function keepAwake(reason, on) {
  if (on) awakeReasons.add(reason);
  else awakeReasons.delete(reason);
  syncWakeLock();
}

function syncWakeLock() {
  wakeChain = wakeChain.then(async () => {
    const want = awakeReasons.size > 0 && document.visibilityState === 'visible';
    if (want && !wakeLock && navigator.wakeLock) {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  }).catch(() => { wakeLock = null; });
}

let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

const saveSettings = () => db.setMeta('settings', { ...state.settings }).catch(() => {});
const saveDevice = () => db.setMeta('device', { ...state.device }).catch(() => {});

// ---------- the school server ----------

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function ensureDevice() {
  const d = state.device;
  if (!d.id || !d.token) {
    d.id = randomId();
    d.token = randomToken();
    await saveDevice();
  }
  return d;
}

// Calls the school server as this phone. Throws an Error with a message fit to show, and .status.
async function school(path, body) {
  const d = await ensureDevice();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let res;
  try {
    res = await fetch(`${SCHOOL_API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Device ${d.id}:${d.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'The school server took too long. Try again.' : "Couldn't reach the school server. Check your signal and try again.");
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `The school server had a problem (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function applyMe(me) {
  Object.assign(state.device, {
    status: me.status || 'none', name: me.name || state.device.name, admin: !!me.admin, adminExists: me.adminExists ?? state.device.adminExists,
  });
  saveDevice();
}

// Asks the school server where this phone stands (and, for admins, who's waiting). Re-renders only
// if something visible changed and nobody's typing, so a background check never eats your words.
let lastSync = 0;
async function syncSchool({ force = false } = {}) {
  if (!force && Date.now() - lastSync < 20000) return;
  lastSync = Date.now();
  const before = JSON.stringify([state.device.status, state.device.admin, state.device.adminExists, state.pendingCount]);
  try {
    applyMe(await school('/me'));
    if (state.device.admin) {
      state.phones = await school('/admin/phones');
      state.pendingCount = state.phones.phones.filter((p) => p.status === 'pending').length;
    }
  } catch {
    return; // offline or server down: keep what we knew
  }
  const after = JSON.stringify([state.device.status, state.device.admin, state.device.adminExists, state.pendingCount]);
  const typing = document.activeElement?.matches?.('input, textarea');
  if (before !== after && !typing && ['write', 'settings'].includes(parseRoute().name)) render();
}

let draftTimer;
function saveDraft(now = false) {
  clearTimeout(draftTimer);
  const write = () => db.setMeta('draft', { ...state.draft }).catch(() => {});
  if (now) write();
  else draftTimer = setTimeout(write, 400);
}

async function saveItem(item) {
  await db.put('items', item);
  state.items.set(item.id, item);
  askPersist();
}

// ---------- routing ----------

function parseRoute() {
  let p;
  try {
    p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    p = []; // a mangled link shouldn't break the app; just show the first tab
  }
  switch (p[0]) {
    case 'saved':
      if (p[1] === 'new') return { name: 'item', id: null };
      if (p[1] && p[2] === 'modify') return { name: 'modify', id: p[1] };
      if (p[1]) return { name: 'item', id: p[1] };
      return { name: 'saved' };
    case 'review': return { name: 'review' };
    case 'settings': return { name: 'settings' };
    case 'modify': return { name: 'modify', id: null }; // the fresh breakdown on the first tab
    case 'phones': return { name: 'phones' };
    default: return { name: 'write' };
  }
}

function go(path, replace = false) {
  const hash = `#${path}`;
  if (replace) {
    history.replaceState(null, '', hash);
    render();
  } else if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
}

function render() {
  const r = parseRoute();
  const key = `${r.name}:${r.id ?? ''}`;
  document.body.classList.remove('typing');
  keepAwake('review', r.name === 'review');
  keepAwake('dictating', false); // re-rendering replaces the notes box, so it's no longer focused
  switch (r.name) {
    case 'saved': renderSaved(); break;
    case 'item': renderItem(r.id); break;
    case 'modify': renderModify(r.id); break;
    case 'review': renderReview(); break;
    case 'settings': renderSettings(); break;
    case 'phones': renderPhones(); break;
    default: renderWrite();
  }
  if (key !== state.lastView) window.scrollTo(0, 0);
  state.lastView = key;
}

// ---------- shared pieces ----------

function header({ left = '', title = '', right = '' }) {
  return `<header class="bar"><div class="bar-inner">
    <div class="bar-side">${left}</div>
    <h1 class="bar-title">${esc(title)}</h1>
    <div class="bar-side bar-right">${right}</div>
  </div></header>`;
}

const settingsLink = `<a class="bar-btn icon-only" href="#/settings" aria-label="Settings">${ICON.gear}</a>`;
const backLink = (to, label) => `<a class="bar-btn" href="#${esc(to)}">${ICON.back}<span>${esc(label)}</span></a>`;

function tabbar(active) {
  const tab = (id, href, icon, label) => `<a class="tab${active === id ? ' on' : ''}" href="${href}"${active === id ? ' aria-current="page"' : ''}>${icon}<span>${label}</span></a>`;
  return `<nav class="tabbar" aria-label="Sections"><div class="tabbar-inner">
    ${tab('write', '#/', ICON.mic, 'Break down')}
    ${tab('saved', '#/saved', ICON.bookmark, 'Saved')}
    ${tab('review', '#/review', ICON.starLine, 'Review')}
  </div></nav>`;
}

// ---------- getting the app onto the phone ----------

function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

const isInstalled = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// On an iPhone, anything set up in a Safari tab stays in Safari, so install first.
const inSafariNotInstalled = () => platform() === 'ios' && !isInstalled();

// The walkthrough takes over the first tab until the app is installed or "Not now" is tapped.
let installDismissed = false;
const showInstallScreen = () => !isInstalled() && !installDismissed && platform() !== 'other';

// Android browsers hand the page an install prompt it can show on its own button.
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  if (parseRoute().name === 'write' && showInstallScreen()) render();
});
addEventListener('appinstalled', () => {
  state.installPrompt = null;
  state.justInstalled = true;
  if (parseRoute().name === 'write') render();
});

const SHARE_GLYPH = '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>';
const PLUS_GLYPH = '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const DOTS_GLYPH = '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="2" fill="currentColor" stroke="none"/></svg>';
const VDOTS_GLYPH = '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="2" fill="currentColor" stroke="none"/></svg>';

function installScreen() {
  const ios = platform() === 'ios';
  const icon = '<img class="install-icon" src="icons/icon-192.png" width="72" height="72" alt="">';
  let body;
  if (state.justInstalled) {
    body = `${icon}
      <h2>Installed</h2>
      <p>From now on, open <strong>KSDS Lessons</strong> from the icon on your Home Screen.</p>
      <button class="btn btn-block" data-action="dismiss-install">Keep going here for now</button>`;
  } else if (ios) {
    body = `${icon}
      <h2>Add this app to your Home Screen</h2>
      <p>Three taps, then it opens like any other app.</p>
      <ol class="install-steps">
        <li><span class="num">1</span><div><strong>Tap Share</strong> in the bar at the bottom of the screen.<span class="fine">It's the square with an arrow. If you see ${DOTS_GLYPH} instead, tap that first, then <strong>Share</strong>.</span></div><span class="key">${SHARE_GLYPH}</span></li>
        <li><span class="num">2</span><div><strong>Tap Add to Home Screen.</strong><span class="fine">It's in the list. Scroll up a little if you don't see it.</span>
          <div class="sheet-demo"><div>Copy</div><div>Add to Reading List</div><div class="hit">Add to Home Screen ${PLUS_GLYPH}</div><div>Print</div></div></div></li>
        <li><span class="num">3</span><div><strong>Tap Add</strong>, top right. Then open the new <strong>KSDS Lessons</strong> icon.</div></li>
      </ol>
      <button class="link-btn" data-action="dismiss-install">Not now, keep using it in Safari</button>
      <p class="fine center">Anything you set up here in Safari stays in Safari and won't carry over.</p>`;
  } else if (state.installPrompt) {
    body = `${icon}
      <h2>Install this app</h2>
      <p>Then it opens from your Home Screen like any other app. It's free and takes a few seconds.</p>
      <button class="btn btn-primary btn-block btn-tall" data-action="install-app">Install</button>
      <button class="link-btn" data-action="dismiss-install">Not now</button>`;
  } else {
    body = `${icon}
      <h2>Add this app to your Home Screen</h2>
      <p>Two taps, then it opens like any other app.</p>
      <ol class="install-steps">
        <li><span class="num">1</span><div><strong>Tap the menu</strong> at the top right of the browser.</div><span class="key">${VDOTS_GLYPH}</span></li>
        <li><span class="num">2</span><div><strong>Tap Add to Home screen</strong> (or <strong>Install app</strong>), then <strong>Install</strong>.<span class="fine">Samsung's browser: tap the ≡ menu, then <strong>Add page to</strong>, then <strong>Home screen</strong>.</span></div></li>
      </ol>
      <p class="fine">Don't see either? Tap the menu and choose <strong>Open in Chrome</strong> first, then try again.</p>
      <button class="link-btn" data-action="dismiss-install">Not now</button>`;
  }
  const arrow = ios && !state.justInstalled
    ? '<div class="install-arrow" aria-hidden="true"><span>Share is down here</span><svg viewBox="0 0 24 24"><path d="M12 3v17M5 13l7 7 7-7"/></svg></div>'
    : '';
  return `${header({ title: 'KSDS Lessons' })}
    <main class="view install"><section class="card install-card">${body}</section></main>
    ${arrow}`;
}

async function installApp() {
  const p = state.installPrompt;
  if (!p) return;
  state.installPrompt = null;
  p.prompt();
  const { outcome } = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
  if (outcome !== 'accepted') render(); // they backed out: back to the instructions
}

// A reminder for anyone who tapped "Not now".
function installBanner() {
  if (isInstalled() || platform() === 'other') return '';
  const how = platform() === 'ios'
    ? 'In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Anything set up here in Safari stays in Safari.'
    : 'Tap the browser menu, then <strong>Add to Home screen</strong>.';
  return `<div class="banner banner-gold"><div><strong>Add this app to your Home Screen.</strong> ${how}</div><button class="btn btn-small" data-action="show-install">Show me</button></div>`;
}

// First-run help for someone new: ask the school's admin to approve this phone, once.
function setupCard() {
  if (aiProvider() || inSafariNotInstalled()) return '';
  const d = state.device;
  if (d.status === 'pending') {
    return `<section class="card setup-card">
      <h2>Waiting for approval</h2>
      <p>You asked to join as <strong>${esc(d.name)}</strong>. As soon as your admin approves this phone, <strong>Break it down</strong> writes breakdowns for you. You only do this once.</p>
      <button class="btn btn-primary btn-block" data-action="check-approval">Check again</button>
    </section>`;
  }
  if (state.settings.setupDismissed) return '';
  const firstAdmin = d.adminExists === false
    ? '<p class="hint">Setting this up for the school? <a href="#/settings">Become the admin</a> in Settings instead.</p>'
    : '';
  return `<section class="card setup-card">
    <h2>Turn on free AI</h2>
    <p>Type your first name and tap <strong>Ask to join</strong>. Your admin approves this phone once, then <strong>Break it down</strong> writes the breakdown for you. It's free.</p>
    <label class="field"><span class="label">First name</span>
      <input id="join-name" value="${esc(d.name)}" maxlength="40" autocomplete="given-name" autocapitalize="words" enterkeyhint="send"></label>
    <button class="btn btn-primary btn-block" data-action="join">Ask to join</button>
    ${firstAdmin}
    <p class="hint">Have your own Gemini key? <button class="link-inline" data-action="paste-gemini-key">Paste key</button></p>
    <button class="link-btn" data-action="dismiss-setup">Not now</button>
  </section>`;
}

function adminBanner() {
  if (!state.device.admin || !state.pendingCount) return '';
  const who = state.pendingCount === 1 ? '1 phone is' : `${state.pendingCount} phones are`;
  return `<div class="banner banner-gold"><span>${who} waiting for your approval.</span><a class="btn btn-small" href="#/phones">Review</a></div>`;
}

async function joinSchool(button) {
  const name = ($('#join-name')?.value || '').trim();
  if (!name) {
    toast('Type your first name first');
    $('#join-name')?.focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    applyMe(await school('/join', { name }));
    toast('Request sent. Your admin needs to approve this phone.');
  } catch (err) {
    toast(err.message);
  }
  render();
}

async function checkApproval(button) {
  button.disabled = true;
  button.textContent = 'Checking…';
  await syncSchool({ force: true });
  toast(state.device.status === 'approved' ? "You're approved. Break it down is ready." : 'Not approved yet. Try again once your admin has approved it.');
  render();
}

function backupBanner() {
  const { lastBackup } = state.settings;
  if (state.items.size < 5) return '';
  const changed = [...state.items.values()].some((i) => (i.updatedAt || 0) > (lastBackup || 0));
  const days = lastBackup ? Math.floor((Date.now() - lastBackup) / 864e5) : null;
  if (!changed || (days !== null && days < 14)) return '';
  const text = days === null ? "You haven't saved a backup yet." : `Your last backup was ${days} days ago.`;
  return `<div class="banner banner-gold"><span>${text}</span><button class="btn btn-small" data-action="backup">Back up</button></div>`;
}

// ---------- tab 1: break down a lesson ----------

function renderWrite() {
  const d = state.draft;
  if (showInstallScreen()) {
    app.innerHTML = installScreen();
    return;
  }
  app.innerHTML = `
    ${header({ title: 'Lesson Breakdown', right: settingsLink })}
    <main class="view with-tabs">
      ${installBanner()}
      ${adminBanner()}
      ${setupCard()}
      <label class="field"><span class="label big-label">What happened in the lesson?</span>
        <textarea id="raw" class="big" rows="6" placeholder="Tap here, then tap the 🎤 on your keyboard and talk it through: what you worked on, how they did, and what needs work.">${esc(d.raw)}</textarea></label>
      <p class="hint">Talk like you would to a coworker. Rambling is fine.</p>
      <div id="write-actions" class="write-actions">${writeActions()}</div>
      <div id="result">${resultCard()}</div>
    </main>
    ${tabbar('write')}`;
  $$('textarea', app).forEach(autosize);
}

// A phone's own Gemini key wins, then the school's AI once this phone is approved, then ChatGPT.
function aiProvider() {
  if (state.settings.geminiKey) return 'gemini';
  if (state.device.status === 'approved') return 'school';
  if (state.settings.apiKey) return 'chatgpt';
  return null;
}

const PROVIDER_NOTE = { gemini: 'Free, with Google Gemini', school: 'Free, through Key Skills', chatgpt: 'Using ChatGPT (paid)' };

// Writes a breakdown (or a modified one) with whichever AI this phone uses.
async function askAI({ raw, current, change }) {
  const { geminiKey, apiKey, model, extra, style } = state.settings;
  const modifying = current !== undefined;
  if (aiProvider() === 'school') {
    try {
      const data = await school(modifying ? '/modify' : '/breakdown', { raw, current, change, extra, style });
      return data.text;
    } catch (err) {
      // Approval can be taken away; find out so the join card comes back.
      if (err.status === 401 || err.status === 403) await syncSchool({ force: true });
      throw err;
    }
  }
  const system = systemPrompt(extra, style);
  const user = modifying ? modifyMessage({ raw, current, change }) : userMessage({ raw });
  return aiProvider() === 'gemini'
    ? writeWithGemini({ apiKey: geminiKey, system, user })
    : writeWithChatGPT({ apiKey, model: model || DEFAULT_MODEL, system, user });
}

function writeActions() {
  const provider = aiProvider();
  if (provider) {
    return `<button class="btn btn-primary btn-block btn-tall" data-action="generate"${state.busy ? ' disabled' : ''}>
      ${state.busy ? '<span class="spinner" aria-hidden="true"></span> Writing the breakdown…' : `${ICON.zap} Break it down`}
    </button>
    <p class="hint center">${PROVIDER_NOTE[provider]}</p>`;
  }
  return `<div class="two">
      <button class="btn btn-primary" data-action="copy-ai" data-ai="chatgpt">Copy for ChatGPT</button>
      <button class="btn" data-action="copy-ai" data-ai="claude">Copy for Claude</button>
    </div>
    <div id="ai-next" class="ai-next" hidden></div>
    <button class="btn btn-block btn-outline" data-action="paste-reply">Paste the reply</button>
    <div id="paste-wrap" class="paste-wrap" hidden>
      <textarea id="f-paste" rows="3" placeholder="Press and hold here, then tap Paste"></textarea>
      <button class="btn btn-block" data-action="use-paste">Use this reply</button>
    </div>
    <p class="hint center">Turn on free AI above to skip the copying and pasting.</p>`;
}

function resultCard() {
  const d = state.draft;
  if (!d.result) return '';
  const body = state.editingResult
    ? `<textarea id="result-text" class="result-edit" rows="10">${esc(d.result)}</textarea>`
    : `<div class="text result-text">${esc(d.result)}</div>`;
  return `<section class="card result">
    <div class="result-head"><h2>Breakdown</h2>${d.savedId ? '<span class="pill">Saved</span>' : ''}</div>
    <button class="btn btn-primary btn-block btn-tall result-copy" data-action="copy-result">${ICON.copy} Copy</button>
    ${body}
    <div class="two">
      <button class="btn" data-action="save-result"${d.savedId ? ' disabled' : ''}>${d.savedId ? 'Saved ✓' : `${ICON.bookmark} Save`}</button>
      <button class="btn" data-action="modify-result">${ICON.zap} Modify</button>
    </div>
    <div class="two">
      <button class="btn" data-action="edit-result">${state.editingResult ? 'Done editing' : 'Edit'}</button>
      <button class="btn btn-outline" data-action="start-over">New lesson</button>
    </div>
  </section>`;
}

function refreshWrite({ scrollToResult = false } = {}) {
  if (parseRoute().name !== 'write') return;
  $('#write-actions').innerHTML = writeActions();
  $('#result').innerHTML = resultCard();
  $$('#result textarea').forEach(autosize);
  if (scrollToResult) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A fresh breakdown isn't kept unless the instructor taps Save.
function setResult(text) {
  const d = state.draft;
  d.result = text;
  d.aiText = text; // what the AI wrote, so a hand edit can be told apart later
  d.savedId = null;
  state.editingResult = false;
  saveDraft(true);
  refreshWrite({ scrollToResult: true });
}

async function saveResult() {
  const d = state.draft;
  if (!d.result.trim() || d.savedId) return;
  const now = Date.now();
  const item = { id: uid(), title: '', text: d.result, raw: d.raw, pinned: false, createdAt: now, updatedAt: now };
  try {
    await saveItem(item);
  } catch {
    toast("Couldn't save it. Try again.");
    return;
  }
  d.savedId = item.id;
  saveDraft(true);
  refreshWrite();
  toast('Saved. Find it on the Saved tab.');
}

function needRaw() {
  if (state.draft.raw.trim()) return false;
  toast('First, say or type what happened in the lesson');
  $('#raw')?.focus();
  return true;
}

async function generate() {
  if (state.busy || needRaw()) return;
  state.busy = true;
  // If the screen locked mid-request, iOS would pause the app and the answer could be lost.
  keepAwake('writing', true);
  refreshWrite();
  try {
    const text = await askAI({ raw: state.draft.raw });
    state.busy = false;
    await setResult(cleanReply(text));
    toast('Done. Tap Copy to paste it anywhere.');
  } catch (err) {
    state.busy = false;
    if (aiProvider()) refreshWrite();
    else render(); // lost school approval: bring the join card back
    toast(err.message);
  } finally {
    keepAwake('writing', false);
  }
}

async function copyForAI(which) {
  if (needRaw()) return;
  const ai = AI_APPS[which];
  const prompt = copyPrompt({ raw: state.draft.raw, extra: state.settings.extra, style: state.settings.style });
  const copied = await copyText(prompt);
  saveDraft(true);
  const box = $('#ai-next');
  box.hidden = false;
  box.innerHTML = copied
    ? `<p><strong>Copied.</strong> Open ${ai.label}, paste into a new chat and send. When it answers, copy the reply, come back here and tap <strong>Paste the reply</strong>.</p>
       <a class="btn btn-primary btn-block" href="${ai.url}" target="_blank" rel="noopener">Open ${ai.label}</a>`
    : `<p>Couldn't copy automatically. Press and hold the text below, tap <strong>Select All</strong>, then <strong>Copy</strong>.</p>
       <textarea class="prompt-box" readonly rows="6">${esc(prompt)}</textarea>
       <a class="btn btn-primary btn-block" href="${ai.url}" target="_blank" rel="noopener">Open ${ai.label}</a>`;
}

async function pasteReply() {
  let text = '';
  try {
    if (navigator.clipboard?.readText) text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }
  if (text.trim()) {
    useReply(text);
    return;
  }
  $('#paste-wrap').hidden = false;
  $('#f-paste').focus();
  toast('Press and hold in the box, then tap Paste');
}

function useFallbackPaste() {
  const box = $('#f-paste');
  const text = box.value;
  if (!text.trim()) {
    toast('Paste the reply into the box first');
    box.focus();
    return;
  }
  box.value = '';
  $('#paste-wrap').hidden = true;
  useReply(text);
}

function useReply(text) {
  if (looksLikeOurPrompt(text)) {
    toast("That's still the question. Copy the AI's reply first.");
    return;
  }
  // Pasted text is saved, so check before keeping something that was on the clipboard by accident.
  if (!/covered today|how it went|next lesson/i.test(text) && !confirm("That doesn't look like a lesson breakdown. Use it anyway?")) return;
  setResult(cleanReply(text));
}

async function copyResult() {
  toast((await copyText(state.draft.result)) ? 'Copied. Paste it anywhere.' : "Couldn't copy. Press and hold the text instead.");
}

function toggleEditResult() {
  const d = state.draft;
  state.editingResult = !state.editingResult;
  refreshWrite();
  if (state.editingResult) {
    $('#result-text')?.focus();
    return;
  }
  // Finished fixing it by hand: their wording is a good sample of how they like it written.
  if (d.aiText && d.result.trim() && d.result.trim() !== d.aiText.trim()) offerStyleExample(d.result, d.savedId || '');
}

// ---------- my style: examples of the instructor's own writing ----------

function addStyleExample(text, itemId = '') {
  const s = state.settings.style;
  const examples = s.examples.filter((e) => !(itemId && e.itemId === itemId) && e.text !== text.trim());
  examples.push({ text: text.trim().slice(0, STYLE_LIMITS.exampleChars), itemId, addedAt: Date.now() });
  state.settings.style = normalizeStyle({ ...s, examples }); // keeps only the newest few
  saveSettings();
}

function removeStyleExample(keep) {
  const s = state.settings.style;
  state.settings.style = normalizeStyle({ ...s, examples: s.examples.filter(keep) });
  saveSettings();
}

function offerStyleExample(text, itemId) {
  const s = state.settings.style;
  if (s.examples.some((e) => e.text === text.trim())) return;
  const n = STYLE_LIMITS.examples;
  if (!confirm(`Use this as an example of your writing style?\n\nThe app keeps your newest ${n} and uses them to make future breakdowns sound like you. You can change them in Settings.`)) return;
  addStyleExample(text, itemId);
  toast('Kept as a style example');
}

let resultTimer;
function onResultEdit(value) {
  const d = state.draft;
  d.result = value;
  saveDraft();
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    const item = d.savedId && state.items.get(d.savedId);
    if (item) saveItem({ ...item, text: value, updatedAt: Date.now() }).catch(() => {});
  }, 500);
}

function startOver() {
  state.draft = { raw: '', result: '', aiText: '', savedId: null };
  state.editingResult = false;
  saveDraft(true);
  renderWrite();
  $('#raw').focus();
}

// ---------- tab 2: saved and prewritten breakdowns ----------

function renderSaved() {
  app.innerHTML = `
    ${header({ title: 'Saved', right: '<a class="bar-btn strong" href="#/saved/new">+ New</a>' })}
    <main class="view with-tabs">
      ${backupBanner()}
      ${state.items.size ? `<div class="search"><input id="search" type="search" placeholder="Search saved breakdowns" value="${esc(state.query)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"></div>` : ''}
      <div id="results">${savedResults()}</div>
    </main>
    ${tabbar('saved')}`;
}

function savedResults() {
  if (!state.items.size) {
    return `<section class="card welcome">
      <h2>Nothing saved yet</h2>
      <p>When a breakdown is worth keeping, tap <strong>Save</strong> under it on the <strong>Break down</strong> tab.</p>
      <p>Tap <strong>+ New</strong> to add prewritten breakdowns you use a lot. Tap any of them to copy it, or <strong>Modify</strong> to have the AI tweak it.</p>
    </section>`;
  }
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = [...state.items.values()].filter((i) => {
    const hay = `${i.title} ${i.text}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const pinned = list.filter((i) => i.pinned).sort((a, b) => itemTitle(a).localeCompare(itemTitle(b)));
  const recent = list.filter((i) => !i.pinned).sort((a, b) => b.createdAt - a.createdAt);
  if (!pinned.length && !recent.length) return `<p class="empty-note">Nothing matches “${esc(state.query)}”.</p>`;
  let html = '<p class="hint top-hint">Tap a breakdown to copy it.</p>';
  if (pinned.length) html += `<h2 class="list-title">Prewritten</h2><div class="list">${pinned.map((i) => itemCard(i, terms)).join('')}</div>`;
  if (recent.length) html += `<h2 class="list-title">Saved</h2><div class="list">${recent.map((i) => itemCard(i, terms)).join('')}</div>`;
  return html;
}

function itemTitle(item) {
  return item.title || String(item.text).split('\n').find((l) => l.trim())?.trim() || 'Untitled';
}

function itemCard(item, terms) {
  // Written-up breakdowns have no title of their own, so they're headed by when they were written.
  // Untitled prewritten ones use their first line (and don't repeat it in the preview).
  const text = String(item.text);
  let title = item.title;
  let preview = text;
  let when = item.pinned ? '' : whenLabel(item.createdAt);
  if (!title && !item.pinned) {
    title = when;
    when = '';
  } else if (!title) {
    const lines = text.split('\n');
    const first = lines.findIndex((l) => l.trim());
    title = lines[first]?.trim() || 'Untitled';
    preview = lines.slice(first + 1).join('\n').trim();
  }
  return `<div class="card item" role="button" tabindex="0" data-action="copy-item" data-id="${esc(item.id)}">
    <div class="item-head">
      <div class="item-title">${highlight(title, terms)}</div>
      <div class="item-actions">
        <a class="mini" href="#/saved/${esc(item.id)}/modify">Modify</a>
        <a class="mini" href="#/saved/${esc(item.id)}">Edit</a>
      </div>
    </div>
    ${preview ? `<div class="item-text">${highlight(preview, terms)}</div>` : ''}
    <div class="item-foot">${when ? `<span>${esc(when)}</span>` : ''}<span class="copy-hint">${ICON.copy}<span>Tap to copy</span></span></div>
  </div>`;
}

// ---------- modify: ask the AI to tweak a breakdown ----------

// What Modify is working on: a saved breakdown, or (no id) the fresh one on the Break down tab.
function modifyTarget(id) {
  if (!id) {
    const d = state.draft;
    return d.result ? { text: d.result, raw: d.raw, back: '/', keep: 'Use this version', pending: 'Not used yet' } : null;
  }
  const item = state.items.get(id);
  return item ? { text: item.text, raw: item.raw, back: '/saved', keep: 'Save changes', pending: 'Not saved yet' } : null;
}

function renderModify(id) {
  const target = modifyTarget(id);
  if (!target) return go(id ? '/saved' : '/', true);
  if (!state.modify || state.modify.id !== id) state.modify = { id, change: '', result: '', busy: false };
  const m = state.modify;
  const byHand = id
    ? `use <a href="#/saved/${esc(id)}">Edit</a> to change it by hand`
    : 'tap Edit under the breakdown to change it by hand';
  const action = aiProvider()
    ? `<button class="btn btn-primary btn-block btn-tall" data-action="run-modify"${m.busy ? ' disabled' : ''}>
        ${m.busy ? '<span class="spinner" aria-hidden="true"></span> Making the changes…' : `${ICON.zap} Modify it`}
      </button>
      <p class="hint center">Uses your original notes and only changes what you ask.</p>`
    : `<p class="hint">Modify needs one-tap AI. <a href="#/settings">Turn it on in Settings</a> (it's free), or ${byHand}.</p>`;
  app.innerHTML = `
    ${header({ left: '<button class="bar-btn" data-action="leave-modify">Done</button>', title: 'Modify' })}
    <main class="view modify">
      <section class="card result">
        <div class="result-head"><h2>${m.result ? 'New version' : 'Breakdown'}</h2>${m.result ? `<span class="pill pill-gold">${target.pending}</span>` : ''}</div>
        <button class="btn btn-primary btn-block btn-tall result-copy" data-action="copy-modify">${ICON.copy} Copy</button>
        <div class="text result-text">${esc(m.result || target.text)}</div>
        ${m.result ? `<div class="two">
          <button class="btn" data-action="save-modify">${target.keep}</button>
          <button class="btn" data-action="undo-modify">Undo changes</button>
        </div>` : ''}
      </section>
      <section class="step">
        <label class="field"><span class="label big-label">${m.result ? 'Anything else to change?' : 'What should change?'}</span>
          <textarea id="mod-change" rows="3" placeholder="e.g. Make it shorter. Add that the student needs to check mirrors before braking.">${esc(m.change)}</textarea></label>
        ${action}
      </section>
    </main>`;
  $$('textarea', app).forEach(autosize);
}

async function runModify() {
  const m = state.modify;
  const target = m && modifyTarget(m.id);
  if (!target || m.busy) return;
  if (!m.change.trim()) {
    toast('First, say or type what should change');
    $('#mod-change')?.focus();
    return;
  }
  m.busy = true;
  keepAwake('writing', true);
  render();
  try {
    const text = await askAI({ raw: target.raw, current: m.result || target.text, change: m.change });
    m.result = cleanReply(text);
    m.change = '';
    toast(`Done. Tap ${target.keep} to keep it.`);
  } catch (err) {
    toast(err.message);
  } finally {
    m.busy = false;
    keepAwake('writing', false);
    if (parseRoute().name === 'modify' && state.modify === m) {
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
}

async function saveModify() {
  const m = state.modify;
  if (!m?.result) return;
  if (!m.id) {
    // The fresh breakdown takes the new version, and so does its saved copy if it has one,
    // the same as editing it by hand.
    const d = state.draft;
    const saved = d.savedId && state.items.get(d.savedId);
    if (saved) {
      try {
        await saveItem({ ...saved, text: m.result, updatedAt: Date.now() });
      } catch {
        toast("Couldn't update the saved copy. Try again.");
        return;
      }
    }
    d.result = m.result;
    d.aiText = m.result;
    saveDraft(true);
    state.modify = null;
    toast('Using the new version');
    backToBreakdown();
    return;
  }
  const item = state.items.get(m.id);
  if (!item) return;
  try {
    await saveItem({ ...item, text: m.result, updatedAt: Date.now() });
  } catch {
    toast("Couldn't save the changes. Try again.");
    return;
  }
  if (state.draft.savedId === item.id) {
    state.draft.result = m.result;
    saveDraft(true);
  }
  state.modify = null;
  toast('Changes saved');
  go('/saved', true);
}

function leaveModify() {
  const m = state.modify;
  if (m?.result && !confirm(m.id ? 'Leave without saving the new version?' : 'Leave without using the new version?')) return;
  state.modify = null;
  if (m?.id) go('/saved', true);
  else backToBreakdown();
}

function backToBreakdown() {
  go('/', true);
  $('#result')?.scrollIntoView({ block: 'start' });
}

async function copyItem(el) {
  const item = state.items.get(el.dataset.id);
  if (!item) return;
  const ok = await copyText(item.text);
  toast(ok ? 'Copied. Paste it anywhere.' : "Couldn't copy");
  if (ok && el.classList.contains('item')) {
    el.classList.add('copied');
    const hint = el.querySelector('.copy-hint span');
    if (hint) hint.textContent = 'Copied';
    setTimeout(() => {
      el.classList.remove('copied');
      if (hint) hint.textContent = 'Tap to copy';
    }, 1500);
  }
}

function renderItem(id) {
  const item = id ? state.items.get(id) : null;
  if (id && !item) return go('/saved', true);
  const idAttr = item ? esc(item.id) : '';
  app.innerHTML = `
    ${header({
      left: '<a class="bar-btn" href="#/saved">Cancel</a>',
      title: item ? 'Edit' : 'New prewritten',
      right: `<button class="bar-btn strong" data-action="save-item" data-id="${idAttr}">Save</button>`,
    })}
    <main class="view">
      <label class="field"><span class="label">Title <span class="optional">optional</span></span>
        <input id="i-title" value="${esc(item?.title)}" placeholder="e.g. First lesson: the basics" autocomplete="off"></label>
      <label class="field"><span class="label">Breakdown</span>
        <textarea id="i-text" class="big" rows="10" placeholder="Type or dictate a breakdown you use often.">${esc(item?.text)}</textarea></label>
      <label class="check"><input id="i-pinned" type="checkbox"${!item || item.pinned ? ' checked' : ''}><span>Prewritten (keep it at the top)</span></label>
      <button class="btn btn-block" data-action="copy-edit">${ICON.copy} Copy</button>
      ${item ? `<button class="btn btn-block btn-danger" data-action="delete-item" data-id="${idAttr}">Delete</button>` : ''}
    </main>`;
  $$('textarea', app).forEach(autosize);
}

async function saveItemForm(id) {
  const text = $('#i-text').value.trim();
  if (!text) {
    toast('Type the breakdown first');
    $('#i-text').focus();
    return;
  }
  const existing = id ? state.items.get(id) : null;
  const now = Date.now();
  const item = {
    ...(existing || { id: uid(), raw: '', createdAt: now }),
    title: $('#i-title').value.trim(),
    text,
    pinned: $('#i-pinned').checked,
    updatedAt: now,
  };
  await saveItem(item);
  if (state.draft.savedId === item.id) {
    state.draft.result = item.text;
    saveDraft(true);
  }
  toast('Saved');
  go('/saved', true);
}

async function deleteItem(id) {
  if (!state.items.has(id) || !confirm("Delete this breakdown? This can't be undone.")) return;
  await db.del('items', id);
  state.items.delete(id);
  if (state.draft.savedId === id) {
    state.draft.savedId = null;
    saveDraft(true);
  }
  toast('Deleted');
  go('/saved', true);
}

// ---------- tab 3: review card ----------

function reviewMessage() {
  const { schoolName, reviewUrl } = state.settings;
  return `Thanks for choosing ${schoolName || 'us'}! If you have a minute, a quick review would mean a lot and helps other families find us: ${reviewUrl}`;
}

function schoolBrand(name) {
  if (!name) return '';
  const m = name.match(/^(.*\S)\s+(driving school)$/i);
  return `<div class="rv-brand">
    <div class="rv-name">${esc(m ? m[1] : name)}</div>
    <div class="rv-road" aria-hidden="true"></div>
    ${m ? `<div class="rv-school">${esc(m[2])}</div>` : ''}
  </div>`;
}

// With the school's own link, show Eli's full review card (its QR code was replaced with one
// that scans). With any other link, fall back to a drawn card with a QR code for that link.
function renderReview() {
  const { reviewUrl } = state.settings;
  const card = reviewUrl === REVIEW_DEFAULTS.reviewUrl
    ? `<div class="rv-image-wrap">
        <img src="review-card.webp" width="1023" height="1537" alt="Please leave a review. Scan the QR code or go to tinyurl.com/KeySkillsReview. Key Skills Driving School, a veteran-owned business.">
        <button class="rv-link-hit" data-action="copy-review" aria-label="Copy the review link"></button>
      </div>`
    : drawnReviewCard();
  app.innerHTML = `
    ${header({ title: 'Review', right: `<button class="bar-btn strong" data-action="share-review">${ICON.send}<span>Send</span></button>` })}
    <main class="view with-tabs review-view">${card}</main>
    ${tabbar('review')}`;
}

function drawnReviewCard() {
  const { reviewUrl, reviewFooter, schoolName } = state.settings;
  let qr;
  try {
    qr = qrSvg(reviewUrl);
  } catch {
    qr = '<p class="rv-error">That review link is too long for a QR code. Change it in Settings.</p>';
  }
  return `<div class="review-card">
      <h2 class="rv-title">Please leave a review</h2>
      <div class="rv-stars" aria-label="Five stars">${ICON.star.repeat(5)}</div>
      <p class="rv-sub">Help other families find a trusted school</p>
      <div class="rv-qr">${qr}</div>
      <button class="rv-link" data-action="copy-review" aria-label="Copy the review link">${esc(prettyUrl(reviewUrl))}</button>
      <p class="rv-hint">Scan with your phone's camera</p>
      ${schoolBrand(schoolName)}
      ${reviewFooter ? `<p class="rv-thanks">${esc(reviewFooter)}</p>` : ''}
    </div>`;
}

async function shareReview() {
  const text = reviewMessage();
  if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* cancelled */ }
    return;
  }
  toast((await copyText(text)) ? 'Review message copied' : "Couldn't copy");
}

// ---------- settings, backup, restore ----------

function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 3)}…${key.slice(-4)}` : 'saved';
}

function renderSettings() {
  const st = state.settings;
  const last = st.lastBackup ? new Date(st.lastBackup).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never';
  app.innerHTML = `
    ${header({ left: backLink('/', 'Back'), title: 'Settings' })}
    <main class="view settings">
      <section class="card">
        <h2>Invite a coworker</h2>
        <p>Texts them the link. They ask to join from the app, and an admin approves their phone.</p>
        <button class="btn btn-primary btn-block" data-action="invite">${ICON.send} Invite a coworker</button>
      </section>

      ${schoolSection()}

      <details class="card advanced-card"${st.geminiKey ? ' open' : ''}>
        <summary>Use your own Gemini key</summary>
        <p class="fine">Not needed if this phone is approved for the school's AI. Your own key is used instead when it's set.</p>
        ${st.geminiKey
          ? `<p class="ok-line">Connected to Google Gemini (key ${esc(maskKey(st.geminiKey))}). <strong>Break it down</strong> now writes the breakdown right in the app, free.</p>
             <button class="btn btn-block" data-action="remove-gemini-key">Remove key</button>`
          : `<p>Lets <strong>Break it down</strong> write the breakdown right in the app, free, using Google's Gemini.</p>
             <ol class="steps">
               <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with your Google account.</li>
               <li>Tap <strong>Create API key</strong> and copy it. Accept Google's terms if it asks.</li>
               <li>Paste it here.</li>
             </ol>
             <label class="field"><span class="label">Gemini API key</span>
               <input id="st-gemini-key" type="password" placeholder="AIza…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
             <button class="btn btn-primary btn-block" data-action="save-gemini-key">Save key</button>
             <button class="btn btn-block" data-action="paste-gemini-key">Paste key</button>`}
        <p class="fine"><strong>Why it's free:</strong> you never give Google a card, so it can't charge you. If you ever hit the free daily limit, it just asks you to wait. Don't turn on billing in AI Studio.</p>
        <p class="fine"><strong>Privacy:</strong> on the free tier, Google may use what you send to improve its products. Breakdowns never include names, but what you dictate is sent as you said it, so leave out last names.</p>
        <p class="fine">The key stays on this phone and isn't included in backups.</p>
      </details>

      <details class="card advanced-card">
        <summary>Use ChatGPT instead (costs a little)</summary>
        ${st.geminiKey ? '<p class="fine">Gemini is set up, so it\'s used instead. Remove the Gemini key to use ChatGPT.</p>' : ''}
        ${st.apiKey
          ? `<p class="ok-line">ChatGPT key saved (${esc(maskKey(st.apiKey))}).</p>
             <button class="btn btn-block" data-action="remove-key">Remove ChatGPT key</button>`
          : `<p class="fine">Uses OpenAI's API, which is billed separately from a ChatGPT subscription: about a tenth of a cent per breakdown, with a $5 minimum top-up.</p>
             <ol class="steps">
               <li>Go to <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener">platform.openai.com</a>, sign in, and add $5 of credit with auto-recharge off.</li>
               <li>Open <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">API keys</a>, tap <strong>Create new secret key</strong>, and copy it.</li>
               <li>Paste it here.</li>
             </ol>
             <label class="field"><span class="label">OpenAI API key</span>
               <input id="st-key" type="password" placeholder="sk-…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
             <button class="btn btn-block" data-action="save-key">Save ChatGPT key</button>`}
        <label class="field model-field"><span class="label">ChatGPT model</span>
          <input id="st-model" value="${esc(st.model || DEFAULT_MODEL)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <button class="btn btn-block" data-action="save-model">Save model</button>
      </details>

      ${styleSection()}

      <section class="card">
        <h2>Review card</h2>
        <p class="fine">With the Key Skills link, the Review tab shows your full card. Change the link and it shows a simpler card with a QR code for the new link.</p>
        <label class="field"><span class="label">Review link</span>
          <input id="st-url" type="url" value="${esc(st.reviewUrl)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="field"><span class="label">School name</span>
          <input id="st-school" value="${esc(st.schoolName)}" autocomplete="off"></label>
        <label class="field"><span class="label">Bottom line</span>
          <input id="st-footer" value="${esc(st.reviewFooter)}" autocomplete="off"></label>
        <button class="btn btn-block" data-action="save-review-settings">Save review card</button>
      </section>

      <section class="card">
        <h2>Backup</h2>
        <p>Saved breakdowns live on this phone only. Save a backup to Files or iCloud Drive now and then.</p>
        <p class="fine">Last backup: ${esc(last)} · ${state.items.size} saved</p>
        <button class="btn btn-block" data-action="backup">Save a backup</button>
        <button class="btn btn-block" data-action="restore">Restore from a backup</button>
        <input id="restore-file" type="file" accept=".json,application/json" hidden>
      </section>

      <section class="card">
        <h2>Privacy &amp; security</h2>
        <ul class="steps">
          <li>This app can't see anything else on your phone: no contacts, photos, location or other apps. It doesn't ask for any permissions.</li>
          <li>Breakdowns, keys and settings are stored only on this phone. The only thing that leaves it is what you dictate, sent to Gemini when you tap <strong>Break it down</strong> (through the school's server if you joined).</li>
          <li>If you joined the school's AI, the school's server keeps your first name and when you last used the app, so an admin can approve or remove phones. It doesn't keep anything you dictate.</li>
          <li>Your own AI key, if you add one, is only ever sent to Google or OpenAI, and isn't included in backups.</li>
          <li>Backup files contain your breakdowns in plain text, so keep them private.</li>
        </ul>
        <label class="check wipe-check"><input id="wipe-ok" type="checkbox"><span>I understand <strong>Wipe App</strong> deletes this app's saved breakdowns, AI key, settings and school approval. Nothing else on my phone is touched.</span></label>
        <button id="wipe-btn" class="btn btn-block btn-danger" data-action="wipe-app" disabled>Wipe App</button>
      </section>

      <p class="fine center">KSDS Lesson Breakdown ${VERSION}</p>
    </main>`;
  $$('textarea', app).forEach(autosize);
  if (state.device.adminExists === null) syncSchool({ force: true });
}

function schoolSection() {
  const d = state.device;
  const as = d.name ? ` as <strong>${esc(d.name)}</strong>` : '';
  const line = {
    approved: `This phone is approved${as}. <strong>Break it down</strong> uses the school's free AI.`,
    pending: `This phone asked to join${as} and is waiting for an admin to approve it.`,
    removed: 'This phone was removed. You can ask to join again on the Break down tab.',
    none: "This phone hasn't joined yet. Ask to join on the Break down tab.",
  }[d.status] || '';
  let actions = '';
  if (d.admin) {
    actions = `<a class="btn btn-primary btn-block" href="#/phones">Manage phones${state.pendingCount ? ` (${state.pendingCount} waiting)` : ''}</a>`;
  } else if (d.adminExists === false) {
    actions = `<p class="fine">Nobody manages this school's phones yet. If that's your job, tap below on your own phone. The first phone to do it becomes the admin, and the button disappears for everyone else.</p>
      <button class="btn btn-block" data-action="claim-admin">Become the admin</button>`;
  }
  return `<section class="card"><h2>School AI</h2><p>${line}</p>${actions}</section>`;
}

async function claimAdmin(button) {
  const name = (prompt('Your first name, as it should show on the phones list') || '').trim();
  if (!name) return;
  button.disabled = true;
  button.textContent = 'Setting up…';
  try {
    applyMe(await school('/admin/claim', { name }));
    toast("You're the admin. Add the school's key, then approve phones here.");
    go('/phones');
  } catch (err) {
    toast(err.message);
    render();
  }
}

// ---------- phones: the admin's approval list ----------

function renderPhones() {
  if (!state.device.admin) return go('/settings', true);
  app.innerHTML = `
    ${header({ left: backLink('/settings', 'Settings'), title: 'Phones' })}
    <main class="view phones"><div id="phones-body">${state.phones ? phonesBody() : '<p class="empty-note">Loading…</p>'}</div></main>`;
  loadPhones();
}

function showPhones(data) {
  state.phones = data;
  state.pendingCount = data.phones.filter((p) => p.status === 'pending').length;
  if (parseRoute().name === 'phones') $('#phones-body').innerHTML = phonesBody();
}

async function loadPhones() {
  try {
    showPhones(await school('/admin/phones'));
  } catch (err) {
    if (parseRoute().name === 'phones' && !state.phones) $('#phones-body').innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

async function phoneAction(path, body, done) {
  try {
    showPhones(await school(path, body));
    toast(done);
  } catch (err) {
    toast(err.message);
  }
}

function phonesBody() {
  const { phones, keySet } = state.phones;
  const waiting = phones.filter((p) => p.status === 'pending');
  const approved = phones.filter((p) => p.status === 'approved');
  const me = state.device.id;
  const tags = (p) => `${p.admin ? '<span class="pill pill-gold">Admin</span>' : ''}${p.id === me ? '<span class="pill">This phone</span>' : ''}`;
  const waitingCard = (p) => `<div class="card phone-card">
      <div class="phone-name">${esc(p.name)}</div>
      <div class="phone-meta">Asked ${esc(whenLabel(p.created_at))}</div>
      <div class="two">
        <button class="btn btn-primary" data-action="approve-phone" data-id="${esc(p.id)}">Approve</button>
        <button class="btn" data-action="remove-phone" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-pending="1">Decline</button>
      </div>
    </div>`;
  const approvedCard = (p) => `<div class="card phone-card">
      <div class="phone-name">${esc(p.name)} ${tags(p)}</div>
      <div class="phone-meta">${p.last_seen ? `Last used ${esc(whenLabel(p.last_seen))}` : 'Not used yet'}</div>
      ${p.id === me ? '' : `<div class="two">
        <button class="btn" data-action="toggle-admin" data-id="${esc(p.id)}" data-admin="${p.admin ? '0' : '1'}">${p.admin ? 'Remove admin' : 'Make admin'}</button>
        <button class="btn btn-danger-soft" data-action="remove-phone" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Remove</button>
      </div>`}
    </div>`;
  return `
    <section class="card">
      <h2 class="card-title">School AI key</h2>
      ${keySet ? '<p class="ok-line">Set. Approved phones use it.</p>' : "<p>Not set yet. Approved phones can't write breakdowns until it is.</p>"}
      ${state.settings.geminiKey ? '<button class="btn btn-block" data-action="school-key-mine">Use this phone\'s Gemini key</button>' : ''}
      <button class="btn btn-block" data-action="school-key-paste">${keySet ? 'Replace it with a key from the clipboard' : 'Paste a Gemini key'}</button>
      <p class="fine">It's kept on the school's server and never sent back to any phone.</p>
    </section>
    <h2 class="list-title">Waiting for approval</h2>
    ${waiting.length ? `<div class="list">${waiting.map(waitingCard).join('')}</div>` : '<p class="empty-note">Nobody is waiting right now.</p>'}
    <h2 class="list-title">Approved phones</h2>
    <div class="list">${approved.map(approvedCard).join('')}</div>`;
}

async function pasteSchoolKey() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }
  const key = findKey(text);
  if (!key) {
    toast("There's no Gemini key on the clipboard. Copy one first.");
    return;
  }
  phoneAction('/admin/key', { key }, 'School key saved. Approved phones can write breakdowns now.');
}

// Checks a pasted key before keeping it, so a typo shows up now rather than after a lesson.
async function storeKey(button, { input, setting, check, success }) {
  const key = $(input).value.trim();
  if (!key) {
    toast('Paste the key first');
    $(input).focus();
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';
  const result = await check(key);
  if (!result.ok) {
    button.disabled = false;
    button.textContent = label;
    toast(result.message);
    return;
  }
  state.settings[setting] = key;
  saveSettings();
  toast(result.note || success);
  render();
}

// Reads a Gemini key off the clipboard: either a key someone copied from AI Studio, or a
// coworker's whole invite message with the key in it.
async function pasteGeminiKey(button) {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = '';
  }
  const key = findKey(text);
  if (!key) {
    toast(text.trim() ? "There's no Gemini key on the clipboard. Copy the key first." : 'Copy the key first, then tap Paste key.');
    return;
  }
  button.disabled = true;
  button.textContent = 'Checking…';
  const result = await checkGeminiKey(key);
  if (!result.ok) {
    button.disabled = false;
    button.textContent = 'Paste key';
    toast(result.message);
    return;
  }
  state.settings.geminiKey = key;
  saveSettings();
  toast('Free AI is on. Break it down writes the breakdown for you now.');
  render();
}

// No key in the invite any more: new people ask to join and an admin approves their phone.
async function inviteCoworker() {
  const text = [
    "Here's the KSDS lesson breakdown app:",
    APP_URL,
    '',
    '1. Open the link in Safari.',
    '2. Tap Share, then Add to Home Screen.',
    `3. Open the app from your Home Screen, type your first name and tap Ask to join. ${state.device.admin ? "I'll approve it." : 'An admin approves it.'}`,
  ].join('\n');
  if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* cancelled */ }
    return;
  }
  toast((await copyText(text)) ? 'Invite copied. Paste it into a text message.' : "Couldn't copy the invite");
}

function forgetKey(setting, question) {
  if (!confirm(question)) return;
  state.settings[setting] = '';
  saveSettings();
  toast('Key removed');
  render();
}

function saveModel() {
  state.settings.model = $('#st-model').value.trim() || DEFAULT_MODEL;
  saveSettings();
  toast('Model saved');
}

function styleSection() {
  const s = state.settings.style;
  const chip = (key, value, label) => `<button type="button" class="chip${s[key] === value ? ' on' : ''}" data-action="style-pick" data-key="${key}" data-value="${value}">${label}</button>`;
  const examples = s.examples.length
    ? `<div class="style-examples">${s.examples.map((e, i) => `<div class="style-example"><span class="snip">${esc(e.text.split('\n').find((l) => l.trim()) || '')}</span><button class="mini" data-action="style-remove-example" data-index="${i}">Remove</button></div>`).join('')}</div>`
    : '';
  let adder;
  if (state.addingExample) {
    adder = `<label class="field"><span class="label">A breakdown you wrote yourself</span>
        <textarea id="st-example" rows="6" placeholder="Paste or dictate one of your own write-ups here."></textarea></label>
      <div class="two">
        <button class="btn btn-primary" data-action="style-keep-example">Keep it</button>
        <button class="btn" data-action="style-cancel-example">Cancel</button>
      </div>`;
  } else if (s.examples.length >= STYLE_LIMITS.examples) {
    adder = `<p class="fine">That's the ${STYLE_LIMITS.examples} it uses. Remove one to add another.</p>`;
  } else {
    adder = '<button class="btn btn-block" data-action="style-add-example">Add an example</button>';
  }
  return `<section class="card">
    <h2>My style</h2>
    <p class="fine">Breakdowns stay professional and in the same format. This makes them sound like you.</p>
    <div class="style-row"><span class="label">Tone</span>
      <div class="chips">${chip('tone', 'warm', 'Warm')}${chip('tone', 'plain', 'Matter-of-fact')}${chip('tone', '', 'Either')}</div></div>
    <div class="style-row"><span class="label">Length</span>
      <div class="chips">${chip('length', 'short', 'Short')}${chip('length', 'detailed', 'Detailed')}${chip('length', '', 'Either')}</div></div>
    <label class="field"><span class="label">Sign-off <span class="optional">optional</span></span>
      <input id="st-signoff" value="${esc(s.signoff)}" maxlength="${STYLE_LIMITS.signoff}" placeholder="e.g. Coach Eli, Key Skills Driving School" autocomplete="off"></label>
    <div class="style-row"><span class="label">Examples of my writing</span>
      ${examples}
      ${adder}
      <p class="fine">Paste up to ${STYLE_LIMITS.examples} breakdowns you wrote yourself, so it can match your voice. The app also offers to keep your version whenever you fix a breakdown by hand (<strong>Edit</strong>, change it, <strong>Done editing</strong>).</p>
    </div>
    ${s.examples.length ? `<div class="style-row"><span class="label">How closely to follow them</span>
      <div class="chips">${chip('polish', 'tidy', 'Tidy me up')}${chip('polish', 'close', 'Close to how I write')}</div></div>` : ''}
    <label class="field"><span class="label">Anything else <span class="optional">optional</span></span>
      <textarea id="st-extra" rows="2" placeholder="e.g. Always mention the student's permit hours when I say them.">${esc(state.settings.extra)}</textarea></label>
    <button class="btn btn-block" data-action="save-style">Save style</button>
  </section>`;
}

// The chips save themselves; this keeps the typed fields.
function saveStyleText() {
  state.settings.extra = $('#st-extra')?.value.trim() ?? state.settings.extra;
  const signoff = $('#st-signoff')?.value;
  if (signoff !== undefined) state.settings.style = normalizeStyle({ ...state.settings.style, signoff });
  saveSettings();
}

function saveReviewSettings() {
  const url = $('#st-url').value.trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) {
    toast('Enter the full link, starting with https://');
    return;
  }
  state.settings.reviewUrl = url;
  state.settings.schoolName = $('#st-school').value.trim();
  state.settings.reviewFooter = $('#st-footer').value.trim();
  saveSettings();
  toast('Review card saved');
}

async function backup() {
  const data = { app: 'lesson-notes', version: 2, exportedAt: new Date().toISOString(), items: [...state.items.values()], style: state.settings.style };
  const name = `ksds-breakdowns-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Lesson breakdowns backup' });
    } else {
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') toast("Couldn't save the backup");
    return;
  }
  state.settings.lastBackup = Date.now();
  saveSettings();
  toast('Backup saved');
  render();
}

// For a phone that's changing hands or someone leaving the school. Only this app's data goes;
// its own files stay cached so it still opens.
function wipeWarning() {
  const lines = [
    'Wipe App?',
    '',
    'This deletes, from KSDS Lessons only:',
    '• All saved and prewritten breakdowns',
    '• Your AI key',
    '• Your settings and review card changes',
    '• Any breakdown you were in the middle of',
    "• This phone's approval for the school's AI (you'd ask to join again)",
    '',
    "Nothing else on your phone is touched. This can't be undone.",
  ];
  // An admin who wipes their phone can't manage phones any more, so say so while there's time.
  if (state.device.admin) lines.push('', "You're an admin. Make someone else an admin first, or nobody will be able to approve phones.");
  return lines.join('\n');
}

async function wipeApp() {
  if (!$('#wipe-ok')?.checked) return;
  if (!confirm(wipeWarning())) return;
  try {
    await db.clear('items');
    await db.clear('meta');
  } catch {
    toast("Couldn't wipe the app. Try again.");
    return;
  }
  state.items.clear();
  state.settings = defaultSettings();
  state.device = defaultDevice();
  state.phones = null;
  state.pendingCount = 0;
  state.draft = { raw: '', result: '', aiText: '', savedId: null };
  state.editingResult = false;
  state.query = '';
  toast('App wiped. Nothing else on your phone was touched.');
  go('/', true);
}

// Backups from version 1 (students and lesson notes) are turned into saved breakdowns.
function itemsFromOldBackup(data) {
  const names = new Map((data.students || []).map((s) => [s.id, s.name]));
  const sections = [['practiced', 'Practiced'], ['wentWell', 'Went well'], ['workOn', 'Work on'], ['nextTime', 'Next time'], ['notes', 'Notes']];
  return (data.lessons || []).map((l) => {
    const parts = sections.filter(([k]) => typeof l[k] === 'string' && l[k].trim()).map(([k, label]) => `${label}:\n${l[k].trim()}`);
    return {
      id: String(l.id), title: `${names.get(l.studentId) || 'Lesson'} – ${l.date}`, text: parts.join('\n\n') || String(l.raw || ''),
      raw: String(l.raw || ''), pinned: false, createdAt: Number(l.createdAt) || Date.now(), updatedAt: Number(l.updatedAt) || Date.now(),
    };
  });
}

async function restoreFrom(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) {
    toast("That file is too big to be a backup from this app");
    return;
  }
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    data = null;
  }
  if (data?.app !== 'lesson-notes') {
    toast("That file isn't a backup from this app");
    return;
  }
  const raw = Array.isArray(data.items) ? data.items : itemsFromOldBackup(data);
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const items = raw
    .filter((i) => i && str(i.id) && str(i.text).trim())
    .map((i) => ({
      id: i.id, title: str(i.title), text: i.text, raw: str(i.raw), pinned: !!i.pinned,
      createdAt: num(i.createdAt), updatedAt: num(i.updatedAt),
    }))
    .filter((i) => !state.items.has(i.id) || i.updatedAt > (state.items.get(i.id).updatedAt || 0));
  // A style only comes back if this phone hasn't set one, so a restore never overwrites yours.
  let styleRestored = false;
  if (styleIsSet(data.style) && !styleIsSet(state.settings.style)) {
    state.settings.style = normalizeStyle(data.style);
    saveSettings();
    styleRestored = true;
  }
  if (!items.length) {
    toast(styleRestored ? 'Your style was restored. The breakdowns were already here.' : 'Everything in that backup is already here');
    return;
  }
  if (!confirm(`Restore ${items.length} breakdown${items.length === 1 ? '' : 's'} from this backup?`)) return;
  await db.putMany('items', items);
  items.forEach((i) => state.items.set(i.id, i));
  toast('Backup restored');
  go('/saved');
}

// ---------- events ----------

const actions = {
  generate: () => generate(),
  'copy-ai': (el) => copyForAI(el.dataset.ai),
  'paste-reply': () => pasteReply(),
  'use-paste': () => useFallbackPaste(),
  'copy-result': () => copyResult(),
  'save-result': () => saveResult(),
  'run-modify': () => runModify(),
  'save-modify': () => saveModify(),
  'undo-modify': () => {
    if (!state.modify) return;
    state.modify.result = '';
    render();
  },
  'copy-modify': async () => {
    const target = state.modify && modifyTarget(state.modify.id);
    if (target) toast((await copyText(state.modify.result || target.text)) ? 'Copied. Paste it anywhere.' : "Couldn't copy");
  },
  'modify-result': () => {
    state.editingResult = false;
    state.modify = { id: null, change: '', result: '', busy: false };
    go('/modify');
  },
  'leave-modify': () => leaveModify(),
  'paste-gemini-key': (el) => pasteGeminiKey(el),
  'dismiss-setup': () => {
    state.settings.setupDismissed = true;
    saveSettings();
    render();
  },
  invite: () => inviteCoworker(),
  'install-app': () => installApp(),
  'dismiss-install': () => {
    installDismissed = true;
    state.justInstalled = false;
    render();
  },
  'show-install': () => {
    installDismissed = false;
    go('/');
  },
  join: (el) => joinSchool(el),
  'check-approval': (el) => checkApproval(el),
  'claim-admin': (el) => claimAdmin(el),
  'approve-phone': (el) => phoneAction('/admin/approve', { id: el.dataset.id }, 'Approved. They can use it now.'),
  'remove-phone': (el) => {
    const pending = !!el.dataset.pending;
    const question = pending ? `Decline ${el.dataset.name}'s request?` : `Remove ${el.dataset.name}'s phone? They'll have to ask to join again.`;
    if (confirm(question)) phoneAction('/admin/remove', { id: el.dataset.id }, pending ? 'Request declined' : 'Phone removed');
  },
  'toggle-admin': (el) => {
    const admin = el.dataset.admin === '1';
    phoneAction('/admin/role', { id: el.dataset.id, admin }, admin ? "They're an admin now" : 'No longer an admin');
  },
  'school-key-mine': () => phoneAction('/admin/key', { key: state.settings.geminiKey }, 'School key saved. Approved phones can write breakdowns now.'),
  'school-key-paste': () => pasteSchoolKey(),
  'edit-result': () => toggleEditResult(),
  'start-over': () => startOver(),
  'copy-item': (el) => copyItem(el),
  'copy-edit': async () => toast((await copyText($('#i-text').value)) ? 'Copied' : "Couldn't copy"),
  'save-item': (el) => saveItemForm(el.dataset.id || null),
  'delete-item': (el) => deleteItem(el.dataset.id),
  'share-review': () => shareReview(),
  'copy-review': async () => toast((await copyText(state.settings.reviewUrl)) ? 'Review link copied' : "Couldn't copy"),
  'save-gemini-key': (el) => storeKey(el, {
    input: '#st-gemini-key', setting: 'geminiKey', check: checkGeminiKey, success: 'Connected to Gemini. Break it down is free now.',
  }),
  'remove-gemini-key': () => forgetKey('geminiKey', 'Remove your Gemini key from this phone? You can still use Copy for ChatGPT.'),
  'save-key': (el) => storeKey(el, {
    input: '#st-key', setting: 'apiKey', check: (key) => checkKey(key, state.settings.model || DEFAULT_MODEL), success: 'ChatGPT key saved',
  }),
  'remove-key': () => forgetKey('apiKey', 'Remove your OpenAI key from this phone?'),
  'save-model': () => saveModel(),
  'save-style': () => {
    saveStyleText();
    toast('Style saved');
  },
  'style-pick': (el) => {
    state.settings.style = normalizeStyle({ ...state.settings.style, [el.dataset.key]: el.dataset.value });
    saveSettings();
    $$('.chip', el.parentElement).forEach((c) => c.classList.toggle('on', c === el));
  },
  'style-add-example': () => {
    saveStyleText();
    state.addingExample = true;
    render();
    $('#st-example')?.focus();
  },
  'style-cancel-example': () => {
    saveStyleText();
    state.addingExample = false;
    render();
  },
  'style-keep-example': () => {
    const text = ($('#st-example')?.value || '').trim();
    if (!text) {
      toast('Paste or type the example first');
      $('#st-example')?.focus();
      return;
    }
    saveStyleText();
    addStyleExample(text);
    state.addingExample = false;
    render();
    toast('Kept as a style example');
  },
  'style-remove-example': (el) => {
    saveStyleText(); // don't lose what's typed in the boxes when the section redraws
    const index = Number(el.dataset.index);
    removeStyleExample((_, i) => i !== index);
    render();
  },
  'save-review-settings': () => saveReviewSettings(),
  backup: () => backup(),
  restore: () => $('#restore-file').click(),
  'wipe-app': () => wipeApp(),
};

document.addEventListener('click', (e) => {
  // A link inside a tappable card (like Edit) wins over the card itself.
  const el = e.target.closest('[data-action], a[href]');
  if (!el || !el.dataset.action || !actions[el.dataset.action]) return;
  e.preventDefault();
  actions[el.dataset.action](el, e);
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.item[data-action]')) {
    e.preventDefault();
    copyItem(e.target);
  }
  if (e.key === 'Enter' && e.target.id === 'join-name') {
    e.preventDefault();
    joinSchool($('[data-action=join]'));
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.tagName === 'TEXTAREA') autosize(t);
  if (t.id === 'raw') {
    state.draft.raw = t.value;
    saveDraft();
  } else if (t.id === 'result-text') {
    onResultEdit(t.value);
  } else if (t.id === 'mod-change' && state.modify) {
    state.modify.change = t.value;
  } else if (t.id === 'search') {
    state.query = t.value;
    $('#results').innerHTML = savedResults();
  } else if (t.id === 'f-paste' && e.inputType === 'insertFromPaste') {
    useFallbackPaste();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'restore-file') restoreFrom(e.target);
  // Wipe App stays greyed out until the box is ticked.
  if (e.target.id === 'wipe-ok') $('#wipe-btn').disabled = !e.target.checked;
});

// Hide the tab bar while the keyboard is up so it doesn't float over what you're typing.
const TYPING = 'textarea, select, input:not([type=checkbox]):not([type=file])';
const DICTATION_BOXES = new Set(['raw', 'mod-change', 'st-example']);
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.(TYPING)) document.body.classList.add('typing');
  // Dictating is hands-off, so without this the screen can lock mid-sentence.
  if (DICTATION_BOXES.has(e.target.id)) keepAwake('dictating', true);
});
document.addEventListener('focusout', (e) => {
  if (DICTATION_BOXES.has(e.target.id)) keepAwake('dictating', false);
  setTimeout(() => {
    if (!document.activeElement?.matches?.(TYPING)) document.body.classList.remove('typing');
  }, 60);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveDraft(true);
  // Coming back to the app: see whether this phone was approved, or who's waiting for an admin.
  else if (state.device.status === 'pending' || state.device.admin) syncSchool();
  syncWakeLock();
});
addEventListener('pagehide', () => saveDraft(true));

// ---------- start ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new version took over: reload so it's in use, unless ChatGPT is mid-answer.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !state.busy) location.reload();
  });
}

async function start() {
  // Refuse to run inside another website's frame, where taps could be tricked or spied on.
  if (window.top !== window.self) {
    app.innerHTML = '<main class="view"><div class="card"><h2>Open this app directly</h2><p>For your security it only runs on its own page: key-skills-driving.github.io</p></div></main>';
    return;
  }
  try {
    const [items, settings, draft, device] = await Promise.all([db.all('items'), db.getMeta('settings'), db.getMeta('draft'), db.getMeta('device')]);
    items.forEach((i) => state.items.set(i.id, i));
    Object.assign(state.settings, settings || {});
    state.settings.style = normalizeStyle(state.settings.style); // phones from before styles existed
    Object.assign(state.device, device || {});
    if (draft && typeof draft.raw === 'string') state.draft = { raw: draft.raw, result: draft.result || '', aiText: draft.aiText || '', savedId: draft.savedId || null };
  } catch (err) {
    app.innerHTML = `<main class="view"><div class="card"><h2>Couldn't open your saved breakdowns</h2>
      <p>${esc(err?.message || err)}</p><p>Close the app completely and open it again.</p></div></main>`;
    return;
  }
  addEventListener('hashchange', render);
  render();
  registerServiceWorker();
  syncSchool({ force: true });
}

start();
