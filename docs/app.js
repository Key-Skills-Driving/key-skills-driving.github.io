import { db } from './db.js';
import {
  DEFAULT_MODEL, systemPrompt, userMessage, copyPrompt, looksLikeOurPrompt, cleanReply, writeWithChatGPT, checkKey,
} from './ai.js';
import { qrSvg } from './review.js';

// Bump together with CACHE in sw.js on every release.
const VERSION = '2.1.0';

const AI_APPS = {
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  claude: { label: 'Claude', url: 'https://claude.ai/new' },
};
const REVIEW_DEFAULTS = {
  reviewUrl: 'https://tinyurl.com/KeySkillsReview',
  schoolName: 'Key Skills Driving School',
  reviewFooter: 'Thank you for supporting a veteran-owned business',
};

const state = {
  items: new Map(), // saved breakdowns: the ones you write up, plus prewritten ones
  settings: { lastBackup: null, apiKey: '', model: DEFAULT_MODEL, extra: '', ...REVIEW_DEFAULTS },
  draft: { raw: '', result: '', savedId: null }, // the breakdown in progress on the first tab
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
const longDate = (d = new Date()) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

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
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
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

let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

const saveSettings = () => db.setMeta('settings', { ...state.settings }).catch(() => {});

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
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (p[0]) {
    case 'saved':
      if (p[1] === 'new') return { name: 'item', id: null };
      if (p[1]) return { name: 'item', id: p[1] };
      return { name: 'saved' };
    case 'review': return { name: 'review' };
    case 'settings': return { name: 'settings' };
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
  if (r.name !== 'review') keepAwake(false);
  switch (r.name) {
    case 'saved': renderSaved(); break;
    case 'item': renderItem(r.id); break;
    case 'review': renderReview(); break;
    case 'settings': renderSettings(); break;
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

function installBanner() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone || !ios) return '';
  return `<div class="banner banner-gold"><div><strong>Add this to your Home Screen first.</strong> In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Breakdowns saved here in Safari stay in Safari and won't show up in the installed app.</div></div>`;
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
  app.innerHTML = `
    ${header({ title: 'Lesson Breakdown', right: settingsLink })}
    <main class="view with-tabs">
      ${installBanner()}
      <label class="field"><span class="label big-label">What happened in the lesson?</span>
        <textarea id="raw" class="big" rows="6" placeholder="Tap here, then tap the 🎤 on your keyboard and talk it through: what you worked on, how they did, and what needs work.">${esc(d.raw)}</textarea></label>
      <p class="hint">Talk like you would to a coworker. Rambling is fine.</p>
      <div id="write-actions" class="write-actions">${writeActions()}</div>
      <div id="result">${resultCard()}</div>
    </main>
    ${tabbar('write')}`;
  $$('textarea', app).forEach(autosize);
}

function writeActions() {
  if (state.settings.apiKey) {
    return `<button class="btn btn-primary btn-block btn-tall" data-action="generate"${state.busy ? ' disabled' : ''}>
      ${state.busy ? '<span class="spinner" aria-hidden="true"></span> Writing the breakdown…' : `${ICON.zap} Break it down`}
    </button>`;
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
    <p class="hint center"><a href="#/settings">Set up ChatGPT</a> to do this in one tap.</p>`;
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
      <button class="btn" data-action="edit-result">${state.editingResult ? 'Done editing' : 'Edit'}</button>
      <button class="btn" data-action="start-over">New lesson</button>
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

async function setResult(text) {
  const d = state.draft;
  const now = Date.now();
  const existing = d.savedId && state.items.get(d.savedId);
  const item = existing
    ? { ...existing, text, raw: d.raw, updatedAt: now }
    : { id: uid(), title: '', text, raw: d.raw, pinned: false, createdAt: now, updatedAt: now };
  d.result = text;
  d.savedId = item.id;
  state.editingResult = false;
  saveDraft(true);
  try {
    await saveItem(item);
  } catch {
    toast("Couldn't save it to Saved, but you can still copy it.");
  }
  refreshWrite({ scrollToResult: true });
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
  refreshWrite();
  try {
    const text = await writeWithChatGPT({
      apiKey: state.settings.apiKey,
      model: state.settings.model || DEFAULT_MODEL,
      system: systemPrompt(state.settings.extra),
      user: userMessage({ dateLabel: longDate(), raw: state.draft.raw }),
    });
    state.busy = false;
    await setResult(cleanReply(text));
    toast('Done. Tap Copy to paste it anywhere.');
  } catch (err) {
    state.busy = false;
    refreshWrite();
    toast(err.message);
  }
}

async function copyForAI(which) {
  if (needRaw()) return;
  const ai = AI_APPS[which];
  const prompt = copyPrompt({ dateLabel: longDate(), raw: state.draft.raw, extra: state.settings.extra });
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
  setResult(cleanReply(text));
}

async function copyResult() {
  toast((await copyText(state.draft.result)) ? 'Copied. Paste it anywhere.' : "Couldn't copy. Press and hold the text instead.");
}

function toggleEditResult() {
  state.editingResult = !state.editingResult;
  refreshWrite();
  if (state.editingResult) $('#result-text')?.focus();
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
  state.draft = { raw: '', result: '', savedId: null };
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
      <p>Every breakdown you write up on the <strong>Break down</strong> tab is saved here automatically.</p>
      <p>Tap <strong>+ New</strong> to add prewritten breakdowns you use a lot. Tap any of them to copy it.</p>
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
  if (recent.length) html += `<h2 class="list-title">Recent</h2><div class="list">${recent.map((i) => itemCard(i, terms)).join('')}</div>`;
  return html;
}

function itemTitle(item) {
  return item.title || String(item.text).split('\n').find((l) => l.trim())?.trim() || 'Untitled';
}

function itemCard(item, terms) {
  const title = itemTitle(item);
  // Don't repeat the first line in the preview when it's being used as the title.
  const lines = String(item.text).split('\n');
  const preview = (item.title ? lines : lines.slice(lines.findIndex((l) => l.trim()) + 1)).join('\n').trim();
  return `<div class="card item" role="button" tabindex="0" data-action="copy-item" data-id="${esc(item.id)}">
    <div class="item-head">
      <div class="item-title">${highlight(title, terms)}</div>
      <a class="mini" href="#/saved/${esc(item.id)}">Edit</a>
    </div>
    ${preview ? `<div class="item-text">${highlight(preview, terms)}</div>` : ''}
    <div class="item-foot">${item.pinned ? '' : `<span>${esc(whenLabel(item.createdAt))}</span>`}<span class="copy-hint">${ICON.copy}<span>Tap to copy</span></span></div>
  </div>`;
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

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

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
  keepAwake(true);
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
        <h2>One-tap ChatGPT</h2>
        ${st.apiKey
          ? `<p class="ok-line">Connected (key ${esc(maskKey(st.apiKey))}). <strong>Break it down</strong> now writes the breakdown right in the app.</p>
             <button class="btn btn-block" data-action="remove-key">Remove key</button>`
          : `<p>Lets <strong>Break it down</strong> write the breakdown right in the app, without copying and pasting.</p>
             <p class="fine">This uses OpenAI's API, which is billed separately from a ChatGPT subscription. It costs about a tenth of a cent per breakdown, so $5 of credit lasts a very long time.</p>
             <ol class="steps">
               <li>Go to <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener">platform.openai.com</a> and sign in (your ChatGPT login works). Add $5 of credit.</li>
               <li>Open <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">API keys</a>, tap <strong>Create new secret key</strong>, and copy it.</li>
               <li>Paste it here.</li>
             </ol>
             <label class="field"><span class="label">OpenAI API key</span>
               <input id="st-key" type="password" placeholder="sk-…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
             <button class="btn btn-primary btn-block" data-action="save-key">Save key</button>
             <p class="fine">The key stays on this phone. It isn't included in backups.</p>`}
        <details class="advanced">
          <summary>Advanced</summary>
          <label class="field"><span class="label">ChatGPT model</span>
            <input id="st-model" value="${esc(st.model || DEFAULT_MODEL)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
          <button class="btn btn-block" data-action="save-model">Save model</button>
        </details>
      </section>

      <section class="card">
        <h2>How it writes</h2>
        <label class="field"><span class="label">Your own instructions <span class="optional">optional</span></span>
          <textarea id="st-extra" rows="3" placeholder="e.g. Sign it “Coach Eli”. Always mention the student's permit hours when I say them.">${esc(st.extra)}</textarea></label>
        <button class="btn btn-block" data-action="save-extra">Save instructions</button>
      </section>

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

      <p class="fine center">KSDS Lesson Breakdown ${VERSION}</p>
    </main>`;
  $$('textarea', app).forEach(autosize);
}

async function saveKey(button) {
  const key = $('#st-key').value.trim();
  if (!key) {
    toast('Paste your OpenAI API key first');
    $('#st-key').focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Checking…';
  const result = await checkKey(key, state.settings.model || DEFAULT_MODEL);
  if (!result.ok) {
    button.disabled = false;
    button.textContent = 'Save key';
    toast(result.message);
    return;
  }
  state.settings.apiKey = key;
  saveSettings();
  toast(result.note || 'Connected to ChatGPT');
  render();
}

function removeKey() {
  if (!confirm('Remove your OpenAI key from this phone? You can still use Copy for ChatGPT.')) return;
  state.settings.apiKey = '';
  saveSettings();
  toast('Key removed');
  render();
}

function saveModel() {
  state.settings.model = $('#st-model').value.trim() || DEFAULT_MODEL;
  saveSettings();
  toast('Model saved');
}

function saveExtra() {
  state.settings.extra = $('#st-extra').value.trim();
  saveSettings();
  toast('Instructions saved');
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
  const data = { app: 'lesson-notes', version: 2, exportedAt: new Date().toISOString(), items: [...state.items.values()] };
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
  if (!items.length) {
    toast('Everything in that backup is already here');
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
  'edit-result': () => toggleEditResult(),
  'start-over': () => startOver(),
  'copy-item': (el) => copyItem(el),
  'copy-edit': async () => toast((await copyText($('#i-text').value)) ? 'Copied' : "Couldn't copy"),
  'save-item': (el) => saveItemForm(el.dataset.id || null),
  'delete-item': (el) => deleteItem(el.dataset.id),
  'share-review': () => shareReview(),
  'copy-review': async () => toast((await copyText(state.settings.reviewUrl)) ? 'Review link copied' : "Couldn't copy"),
  'save-key': (el) => saveKey(el),
  'remove-key': () => removeKey(),
  'save-model': () => saveModel(),
  'save-extra': () => saveExtra(),
  'save-review-settings': () => saveReviewSettings(),
  backup: () => backup(),
  restore: () => $('#restore-file').click(),
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
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.tagName === 'TEXTAREA') autosize(t);
  if (t.id === 'raw') {
    state.draft.raw = t.value;
    saveDraft();
  } else if (t.id === 'result-text') {
    onResultEdit(t.value);
  } else if (t.id === 'search') {
    state.query = t.value;
    $('#results').innerHTML = savedResults();
  } else if (t.id === 'f-paste' && e.inputType === 'insertFromPaste') {
    useFallbackPaste();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'restore-file') restoreFrom(e.target);
});

// Hide the tab bar while the keyboard is up so it doesn't float over what you're typing.
const TYPING = 'textarea, select, input:not([type=checkbox]):not([type=file])';
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.(TYPING)) document.body.classList.add('typing');
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!document.activeElement?.matches?.(TYPING)) document.body.classList.remove('typing');
  }, 60);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveDraft(true);
  else if (parseRoute().name === 'review') keepAwake(true);
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
  try {
    const [items, settings, draft] = await Promise.all([db.all('items'), db.getMeta('settings'), db.getMeta('draft')]);
    items.forEach((i) => state.items.set(i.id, i));
    Object.assign(state.settings, settings || {});
    if (draft && typeof draft.raw === 'string') state.draft = { raw: draft.raw, result: draft.result || '', savedId: draft.savedId || null };
  } catch (err) {
    app.innerHTML = `<main class="view"><div class="card"><h2>Couldn't open your saved breakdowns</h2>
      <p>${esc(err?.message || err)}</p><p>Close the app completely and open it again.</p></div></main>`;
    return;
  }
  addEventListener('hashchange', render);
  render();
  registerServiceWorker();
}

start();
