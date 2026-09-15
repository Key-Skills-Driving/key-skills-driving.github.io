import { db } from './db.js';
import { SECTIONS, buildPrompt, parseReply, looksLikeOurPrompt, shareText } from './ai.js';
import { qrSvg } from './review.js';

// Bump together with CACHE in sw.js on every release.
const VERSION = '1.0.0';

const AI_APPS = {
  claude: { label: 'Claude', url: 'https://claude.ai/new' },
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
};
const LENGTHS = [30, 45, 60, 90, 120];
const TEXT_FIELDS = ['raw', 'practiced', 'wentWell', 'workOn', 'nextTime', 'notes'];
const NOTE_FIELDS = TEXT_FIELDS.slice(1);
const EDIT_FIELDS = ['studentId', 'date', 'minutes', ...TEXT_FIELDS];
const REVIEW_DEFAULTS = {
  reviewUrl: 'https://tinyurl.com/KeySkillsReview',
  schoolName: 'Key Skills Driving School',
  reviewFooter: 'Thank you for supporting a veteran-owned business',
};

const state = {
  students: new Map(),
  lessons: new Map(),
  settings: { lastBackup: null, lastMinutes: 60, ...REVIEW_DEFAULTS },
  query: '',
  showFinished: false,
  editor: null, // the lesson note being written or edited
  restored: false, // editor came back from a saved draft
};

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  star: '<svg class="star-ico" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2 14.25,8.91 21.51,8.91 15.63,13.18 17.88,20.09 12,15.82 6.12,20.09 8.37,13.18 2.49,8.91 9.75,8.91"/></svg>',
};

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- small helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const fromISO = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hours = (mins) => String(Math.round((mins / 60) * 10) / 10);
const hoursLabel = (mins) => (hours(mins) === '1' ? 'hour' : 'hours');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const cleanPhone = (phone) => String(phone || '').replace(/[^\d+]/g, '');
const prettyUrl = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
const currentPath = () => location.hash.replace(/^#/, '') || '/';

function fmtDate(iso, { weekday = true } = {}) {
  const d = fromISO(iso);
  const opts = { month: 'short', day: 'numeric' };
  if (weekday) opts.weekday = 'short';
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

const fmtLongDate = (iso) => fromISO(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

function relDate(iso) {
  const days = Math.round((fromISO(todayISO()) - fromISO(iso)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return `${days} days ago`;
  return fmtDate(iso, { weekday: false });
}

function firstLine(text, max = 90) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, '').trim())
    .find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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

// ---------- data ----------

const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);

function lessonsFor(studentId) {
  return [...state.lessons.values()].filter((l) => l.studentId === studentId).sort(byNewest);
}

function summary(student) {
  const lessons = lessonsFor(student.id);
  const minutes = lessons.reduce((total, l) => total + (Number(l.minutes) || 0), 0);
  const lastActive = Math.max(student.createdAt || 0, ...lessons.map((l) => l.updatedAt || l.createdAt || 0));
  return { lessons, count: lessons.length, minutes, last: lessons[0] || null, first: lessons[lessons.length - 1] || null, lastActive };
}

const activeStudents = () => [...state.students.values()].filter((s) => !s.archived);

async function createStudent(fields) {
  const now = Date.now();
  const student = { id: uid(), name: '', phone: '', notes: '', archived: false, createdAt: now, updatedAt: now, ...fields };
  await db.put('students', student);
  state.students.set(student.id, student);
  askPersist();
  return student;
}

// ---------- routing ----------

function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (p[0]) {
    case 'settings': return { name: 'settings' };
    case 'review': return { name: 'review', studentId: p[1] || null };
    case 'student':
      if (p[1] === 'new') return { name: 'student-edit', id: null };
      if (p[2] === 'edit') return { name: 'student-edit', id: p[1] };
      return { name: 'student', id: p[1], lessonId: p[2] || null };
    case 'note': return { name: 'editor', noteId: p[1] === 'new' ? null : p[1] };
    default: return { name: 'home' };
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
  document.body.classList.remove('typing');
  if (r.name !== 'review') keepAwake(false);
  switch (r.name) {
    case 'settings': renderSettings(); break;
    case 'review': renderReview(r.studentId); break;
    case 'student':
      if (!state.students.has(r.id)) return go('/', true);
      renderStudent(r.id, r.lessonId);
      break;
    case 'student-edit': renderStudentEdit(r.id); break;
    case 'editor': renderEditor(r); break;
    default: renderHome();
  }
  if (!(r.name === 'student' && r.lessonId)) window.scrollTo(0, 0);
}

// ---------- shared pieces ----------

function header({ left = '', title = '', right = '' }) {
  return `<header class="bar"><div class="bar-inner">
    <div class="bar-side">${left}</div>
    <h1 class="bar-title">${esc(title)}</h1>
    <div class="bar-side bar-right">${right}</div>
  </div></header>`;
}

const backLink = (to, label) => `<a class="bar-btn" href="#${esc(to)}">${ICON.back}<span>${esc(label)}</span></a>`;

function installBanner() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone || !ios) return '';
  return `<div class="banner banner-gold"><div><strong>Add this to your Home Screen first.</strong> In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Notes saved here in Safari stay in Safari and won't show up in the installed app.</div></div>`;
}

function backupBanner() {
  const { lastBackup } = state.settings;
  if (state.lessons.size < 3) return '';
  const changed = [...state.lessons.values()].some((l) => (l.updatedAt || 0) > (lastBackup || 0));
  const days = lastBackup ? Math.floor((Date.now() - lastBackup) / 864e5) : null;
  if (!changed || (days !== null && days < 14)) return '';
  const text = days === null ? "You haven't saved a backup yet." : `Your last backup was ${plural(days, 'day')} ago.`;
  return `<div class="banner banner-gold"><span>${text}</span><button class="btn btn-small" data-action="backup">Back up</button></div>`;
}

// ---------- home ----------

function renderHome() {
  const hasStudents = state.students.size > 0;
  app.innerHTML = `
    ${header({
      left: `<a class="bar-btn" href="#/review">${ICON.star}<span>Review</span></a>`,
      title: 'Lesson Notes',
      right: `<a class="bar-btn icon-only" href="#/settings" aria-label="Settings">${ICON.gear}</a>`,
    })}
    <main class="view">
      ${installBanner()}
      ${backupBanner()}
      ${hasStudents ? `<div class="search"><input id="search" type="search" placeholder="Search students and notes" value="${esc(state.query)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"></div>` : ''}
      <div id="results">${homeResults()}</div>
    </main>
    <div class="bottom-bar"><div class="bottom-inner">
      <a class="btn" href="#/student/new">+ Student</a>
      <button class="btn btn-primary grow" data-action="new-note">New lesson note</button>
    </div></div>`;
}

function homeResults() {
  if (!state.students.size) return welcomeCard();
  if (state.query.trim()) return searchResults(state.query);
  const all = [...state.students.values()].map((s) => ({ s, sum: summary(s) })).sort((a, b) => b.sum.lastActive - a.sum.lastActive);
  const active = all.filter((x) => !x.s.archived);
  const finished = all.filter((x) => x.s.archived);
  let html = active.length
    ? `<div class="list">${active.map(studentRow).join('')}</div>`
    : '<div class="card muted-card">Every student is marked finished.</div>';
  if (finished.length) {
    html += `<button class="link-btn" data-action="toggle-finished">${state.showFinished ? 'Hide' : 'Show'} finished students (${finished.length})</button>`;
    if (state.showFinished) html += `<div class="list finished">${finished.map(studentRow).join('')}</div>`;
  }
  return html;
}

function welcomeCard() {
  return `<section class="card welcome">
    <h2>Welcome</h2>
    <p>Keep every student's lesson notes in one place.</p>
    <ol class="steps">
      <li><strong>Add a student.</strong></li>
      <li>After a lesson, tap <strong>New lesson note</strong> and talk through how it went.</li>
      <li>Let Claude or ChatGPT tidy it into a clean note, check it, and save.</li>
    </ol>
    <a class="btn btn-primary btn-block" href="#/student/new">Add your first student</a>
    <p class="fine">Your notes are saved on this phone only.</p>
  </section>`;
}

function studentRow({ s, sum }) {
  const meta = sum.count ? `${relDate(sum.last.date)} · ${plural(sum.count, 'lesson')} · ${hours(sum.minutes)} ${hoursLabel(sum.minutes)}` : 'No lessons yet';
  const plan = sum.last ? firstLine(sum.last.nextTime || sum.last.workOn) : '';
  return `<a class="card row" href="#/student/${esc(s.id)}">
    <div class="row-main">
      <div class="row-title">${esc(s.name)}</div>
      <div class="row-meta">${esc(meta)}</div>
      ${plan ? `<div class="row-plan"><span class="tag">Next</span><span class="row-plan-text">${esc(plan)}</span></div>` : ''}
    </div>
    <span class="chev" aria-hidden="true">›</span>
  </a>`;
}

function searchResults(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text) => {
    const t = text.toLowerCase();
    return terms.every((w) => t.includes(w));
  };
  const students = [...state.students.values()]
    .filter((s) => matches(`${s.name} ${s.notes || ''}`))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lessons = [...state.lessons.values()]
    .filter((l) => matches([state.students.get(l.studentId)?.name, ...TEXT_FIELDS.map((f) => l[f])].join(' ')))
    .sort(byNewest)
    .slice(0, 60);
  if (!students.length && !lessons.length) return `<p class="empty-note">Nothing matches “${esc(query)}”.</p>`;
  let html = '';
  if (students.length) {
    html += `<h2 class="list-title">Students</h2><div class="list">${students.map((s) => studentRow({ s, sum: summary(s) })).join('')}</div>`;
  }
  if (lessons.length) html += `<h2 class="list-title">Notes</h2><div class="list">${lessons.map((l) => noteHit(l, terms)).join('')}</div>`;
  return html;
}

function noteHit(lesson, terms) {
  const student = state.students.get(lesson.studentId);
  const text = [...NOTE_FIELDS, 'raw'].map((f) => lesson[f]).filter(Boolean).join(' · ').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at - 40);
  const snippet = `${start > 0 ? '…' : ''}${text.slice(start, start + 150)}${start + 150 < text.length ? '…' : ''}`;
  return `<a class="card row" href="#/student/${esc(lesson.studentId)}/${esc(lesson.id)}">
    <div class="row-main">
      <div class="row-title small">${esc(student?.name || 'Unknown student')}</div>
      <div class="row-meta">${esc(fmtDate(lesson.date))}</div>
      <div class="snippet">${highlight(snippet, terms)}</div>
    </div>
    <span class="chev" aria-hidden="true">›</span>
  </a>`;
}

// ---------- student ----------

function renderStudent(id, focusLessonId) {
  const s = state.students.get(id);
  const sum = summary(s);
  const plan = sum.last && (sum.last.nextTime || sum.last.workOn);
  const planLabel = sum.last?.nextTime ? 'Plan for next lesson' : 'Work on';
  const phone = cleanPhone(s.phone);
  app.innerHTML = `
    ${header({ left: backLink('/', 'Students'), title: s.name, right: `<a class="bar-btn" href="#/student/${esc(id)}/edit">Edit</a>` })}
    <main class="view">
      <div class="stats">
        <div><strong>${sum.count}</strong><span>${sum.count === 1 ? 'lesson' : 'lessons'}</span></div>
        <div><strong>${hours(sum.minutes)}</strong><span>${hoursLabel(sum.minutes)}</span></div>
        <div><strong>${sum.first ? esc(fmtDate(sum.first.date, { weekday: false })) : '–'}</strong><span>first lesson</span></div>
      </div>
      <div class="actions-row">
        ${phone ? `<a class="btn btn-small" href="tel:${esc(phone)}">Call</a><a class="btn btn-small" href="sms:${esc(phone)}">Text</a>` : ''}
        <a class="btn btn-small" href="#/review/${esc(id)}">${ICON.star}<span>Ask for a review</span></a>
      </div>
      ${s.notes ? `<div class="card student-notes">${esc(s.notes)}</div>` : ''}
      ${plan ? `<div class="callout"><div class="callout-label">${planLabel}</div><div class="callout-text">${esc(plan)}</div></div>` : ''}
      ${sum.count
        ? `<h2 class="list-title">Lessons</h2>${sum.lessons.map((l, i) => lessonCard(l, sum.count - i)).join('')}`
        : `<div class="card muted-card">No lessons yet. After your first lesson with ${esc(firstName(s.name))}, tap <strong>New lesson note</strong>.</div>`}
    </main>
    <div class="bottom-bar"><div class="bottom-inner">
      <button class="btn btn-primary grow" data-action="new-note" data-student="${esc(id)}">New lesson note</button>
    </div></div>`;
  if (focusLessonId) {
    const card = document.getElementById(`lesson-${focusLessonId}`);
    if (card) {
      card.scrollIntoView({ block: 'start' });
      card.classList.add('flash');
    }
  }
}

function lessonCard(lesson, number) {
  const sections = SECTIONS.filter((x) => (lesson[x.key] || '').trim());
  const hasNotes = (lesson.notes || '').trim();
  let body = sections.map((x) => `<div class="sec sec-${x.key}"><h3>${x.label}</h3><div class="text">${esc(lesson[x.key])}</div></div>`).join('');
  if (hasNotes) body += `<div class="sec sec-notes"><h3>Other notes</h3><div class="text">${esc(lesson.notes)}</div></div>`;
  const structured = sections.length || hasNotes;
  if (!structured) body = `<div class="text">${esc(lesson.raw)}</div>`;
  const raw = structured && (lesson.raw || '').trim()
    ? `<details class="raw"><summary>What you said</summary><div class="text">${esc(lesson.raw)}</div></details>`
    : '';
  return `<article class="card lesson" id="lesson-${esc(lesson.id)}">
    <div class="lesson-head">
      <div class="lesson-when"><strong>${esc(fmtDate(lesson.date))}</strong><span>${Number(lesson.minutes) || 0} min · Lesson ${number}</span></div>
      <div class="lesson-actions">
        <button class="mini" data-action="share-note" data-id="${esc(lesson.id)}">Share</button>
        <button class="mini" data-action="edit-note" data-id="${esc(lesson.id)}">Edit</button>
      </div>
    </div>
    ${body}${raw}
  </article>`;
}

function renderStudentEdit(id) {
  const s = id ? state.students.get(id) : null;
  if (id && !s) return go('/', true);
  const back = s ? `/student/${s.id}` : '/';
  const count = s ? lessonsFor(s.id).length : 0;
  const idAttr = s ? esc(s.id) : '';
  app.innerHTML = `
    ${header({
      left: `<a class="bar-btn" href="#${esc(back)}">Cancel</a>`,
      title: s ? 'Edit student' : 'New student',
      right: `<button class="bar-btn strong" data-action="save-student" data-id="${idAttr}">Save</button>`,
    })}
    <main class="view">
      <label class="field"><span class="label">Name</span>
        <input id="s-name" value="${esc(s?.name)}" autocomplete="off" autocapitalize="words" enterkeyhint="done"></label>
      <label class="field"><span class="label">Phone <span class="optional">optional</span></span>
        <input id="s-phone" type="tel" value="${esc(s?.phone)}" autocomplete="off"></label>
      <label class="field"><span class="label">Notes <span class="optional">optional</span></span>
        <textarea id="s-notes" rows="3" placeholder="Permit date, parent's name and number, goals…">${esc(s?.notes)}</textarea></label>
      ${s ? `<label class="check"><input id="s-archived" type="checkbox" ${s.archived ? 'checked' : ''}><span>Finished (hide from the main list)</span></label>
        <button class="btn btn-block btn-danger" data-action="delete-student" data-id="${idAttr}">Delete ${esc(firstName(s.name))}${count ? ` and ${plural(count, 'note')}` : ''}</button>` : ''}
    </main>
    <div class="bottom-bar"><div class="bottom-inner">
      <button class="btn btn-primary grow" data-action="save-student" data-id="${idAttr}">Save</button>
    </div></div>`;
  $$('textarea', app).forEach(autosize);
}

async function saveStudent(id) {
  const name = $('#s-name').value.trim();
  if (!name) {
    toast('Enter a name');
    $('#s-name').focus();
    return;
  }
  const existing = id ? state.students.get(id) : null;
  const fields = { name, phone: $('#s-phone').value.trim(), notes: $('#s-notes').value.trim() };
  let student;
  if (existing) {
    student = { ...existing, ...fields, archived: $('#s-archived').checked, updatedAt: Date.now() };
    await db.put('students', student);
    state.students.set(student.id, student);
  } else {
    student = await createStudent(fields);
  }
  toast(existing ? 'Saved' : `${firstName(name)} added`);
  go(`/student/${student.id}`, true);
}

async function deleteStudent(id) {
  const s = state.students.get(id);
  if (!s) return;
  const lessons = lessonsFor(id);
  const question = lessons.length
    ? `Delete ${s.name} and all ${plural(lessons.length, 'lesson note')}? This can't be undone.`
    : `Delete ${s.name}?`;
  if (!confirm(question)) return;
  await db.deleteStudent(id, lessons.map((l) => l.id));
  state.students.delete(id);
  lessons.forEach((l) => state.lessons.delete(l.id));
  toast('Student deleted');
  go('/', true);
}

// ---------- lesson note editor ----------

function blankNote(studentId) {
  return {
    noteId: null, id: uid(), studentId, date: todayISO(), minutes: state.settings.lastMinutes || 60,
    raw: '', practiced: '', wentWell: '', workOn: '', nextTime: '', notes: '', createdAt: Date.now(),
  };
}

const snapshot = (ed) => JSON.stringify(EDIT_FIELDS.map((f) => ed[f] ?? ''));

function startEditor(ed, from) {
  ed.from = from;
  ed.base = snapshot(ed);
  state.editor = ed;
  state.restored = false;
  return ed;
}

function isDirty(ed) {
  if (!ed) return false;
  if (!ed.noteId) return TEXT_FIELDS.some((f) => (ed[f] || '').trim());
  return snapshot(ed) !== ed.base;
}

function editorFor(route) {
  const ed = state.editor;
  if (route.noteId) {
    if (ed && ed.noteId === route.noteId) return ed;
    const lesson = state.lessons.get(route.noteId);
    return lesson ? startEditor({ ...lesson, noteId: lesson.id }, `/student/${lesson.studentId}`) : null;
  }
  if (ed && !ed.noteId) return ed;
  return startEditor(blankNote(''), '/');
}

let draftTimer;
function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
}

// The draft survives iOS closing the app while you're over in Claude or ChatGPT.
function saveDraftNow() {
  clearTimeout(draftTimer);
  const ed = state.editor;
  if (!ed) return;
  (isDirty(ed) ? db.setMeta('draft', { ...ed }) : db.delMeta('draft')).catch(() => {});
}

function clearEditor() {
  clearTimeout(draftTimer);
  state.editor = null;
  state.restored = false;
  return db.delMeta('draft').catch(() => {});
}

function renderEditor(route) {
  const ed = editorFor(route);
  if (!ed) return go('/', true);
  const students = [...state.students.values()]
    .filter((s) => !s.archived || s.id === ed.studentId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const minutes = Number(ed.minutes);
  const lengths = LENGTHS.includes(minutes) ? LENGTHS : [...LENGTHS, minutes].sort((a, b) => a - b);
  app.innerHTML = `
    ${header({
      left: '<button class="bar-btn" data-action="editor-cancel">Cancel</button>',
      title: ed.noteId ? 'Edit note' : 'New note',
      right: '<button class="bar-btn strong" data-action="editor-save">Save</button>',
    })}
    <main class="view editor">
      ${state.restored ? '<div class="banner">Your unfinished note is still here. Pick up where you left off.</div>' : ''}
      <label class="field"><span class="label">Student</span>
        <select id="f-student">
          <option value="" disabled ${ed.studentId ? '' : 'selected'}>Choose a student…</option>
          ${students.map((s) => `<option value="${esc(s.id)}" ${s.id === ed.studentId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          <option value="__new">+ Add a new student…</option>
        </select></label>
      <label class="field"><span class="label">Date</span>
        <input id="f-date" type="date" data-field="date" value="${esc(ed.date)}"></label>
      <div class="field"><span class="label">Length (minutes)</span>
        <div class="chips">
          ${lengths.map((m) => `<button type="button" class="chip${m === minutes ? ' on' : ''}" data-action="set-minutes" data-min="${m}">${m}</button>`).join('')}
          <button type="button" class="chip" data-action="custom-minutes">Other</button>
        </div>
      </div>

      <section class="step">
        <h2><span class="num">1</span>What happened?</h2>
        <textarea id="f-raw" class="big" data-field="raw" rows="5" placeholder="Tap here, then tap the 🎤 on your keyboard and talk through the lesson.">${esc(ed.raw)}</textarea>
        <p class="hint">Just talk. Rambling and typos are fine; the AI tidies it up.</p>
      </section>

      <section class="step">
        <h2><span class="num">2</span>Tidy it up with AI <span class="optional">optional</span></h2>
        <div class="two">
          <button class="btn" data-action="copy-ai" data-ai="claude">Copy for Claude</button>
          <button class="btn" data-action="copy-ai" data-ai="chatgpt">Copy for ChatGPT</button>
        </div>
        <div id="ai-next" class="ai-next" hidden></div>
        <button class="btn btn-block btn-outline" data-action="paste-reply">Paste AI reply</button>
        <div id="paste-wrap" class="paste-wrap" hidden>
          <textarea id="f-paste" rows="3" placeholder="Press and hold here, then tap Paste"></textarea>
          <button class="btn btn-block" data-action="use-paste">Fill in the note</button>
        </div>
      </section>

      <section class="step" id="step-note">
        <h2><span class="num">3</span>Lesson note</h2>
        <p class="hint first">Filled in from the AI reply, or type your own.</p>
        ${SECTIONS.map((x) => `<label class="field sec-field sec-${x.key}"><span class="label">${x.label}</span><textarea data-field="${x.key}" rows="2">${esc(ed[x.key])}</textarea></label>`).join('')}
        <label class="field sec-field sec-notes"><span class="label">Other notes</span><textarea data-field="notes" rows="2">${esc(ed.notes)}</textarea></label>
      </section>

      ${ed.noteId ? '<button class="btn btn-block btn-danger" data-action="delete-note">Delete this note</button>' : ''}
    </main>
    <div class="bottom-bar"><div class="bottom-inner">
      <button class="btn btn-primary grow" data-action="editor-save">Save note</button>
    </div></div>`;
  $$('textarea', app).forEach(autosize);
}

async function onStudentPick(select) {
  const ed = state.editor;
  if (select.value !== '__new') {
    ed.studentId = select.value;
    queueDraft();
    return;
  }
  const name = (prompt("New student's name") || '').trim();
  if (!name) {
    select.value = ed.studentId || '';
    return;
  }
  const student = await createStudent({ name });
  ed.studentId = student.id;
  queueDraft();
  render();
}

async function copyForAI(which) {
  const ed = state.editor;
  const ai = AI_APPS[which];
  const student = state.students.get(ed.studentId);
  if (!student) {
    toast('Choose a student first');
    $('#f-student').focus();
    return;
  }
  if (!ed.raw.trim()) {
    toast('First, say or type what happened in the lesson');
    $('#f-raw').focus();
    return;
  }
  const earlier = lessonsFor(student.id).filter((l) => l.id !== ed.noteId && l.date <= ed.date);
  const previous = earlier[0];
  const prompt = buildPrompt({
    studentName: student.name,
    lessonNumber: earlier.length + 1,
    dateLabel: fmtLongDate(ed.date),
    minutes: ed.minutes,
    previous: previous ? { dateLabel: fmtDate(previous.date), nextTime: previous.nextTime, workOn: previous.workOn } : null,
    raw: ed.raw,
  });
  const copied = await copyText(prompt);
  saveDraftNow();
  const box = $('#ai-next');
  box.hidden = false;
  box.innerHTML = copied
    ? `<p><strong>Copied.</strong> Open ${ai.label}, paste into a new chat and send. When it answers, copy the reply, come back here and tap <strong>Paste AI reply</strong>.</p>
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
    applyReply(text);
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
    toast('Paste the AI reply into the box first');
    box.focus();
    return;
  }
  box.value = '';
  $('#paste-wrap').hidden = true;
  applyReply(text);
}

function applyReply(text) {
  const ed = state.editor;
  if (looksLikeOurPrompt(text)) {
    toast("That's still the question. Copy the AI's reply first.");
    return;
  }
  const parsed = parseReply(text);
  const hasNote = NOTE_FIELDS.some((f) => (ed[f] || '').trim());
  if (hasNote && !confirm('Replace the lesson note with the AI reply?')) return;
  for (const f of NOTE_FIELDS) {
    ed[f] = parsed[f];
    const ta = app.querySelector(`[data-field="${f}"]`);
    if (ta) {
      ta.value = parsed[f];
      autosize(ta);
    }
  }
  saveDraftNow();
  $('#ai-next').hidden = true;
  $('#step-note').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(parsed.matched ? 'Note filled in. Check it over, then Save.' : 'Pasted into Other notes');
}

async function saveEditor() {
  const ed = state.editor;
  if (!ed) return;
  if (!state.students.has(ed.studentId)) {
    toast('Choose a student first');
    $('#f-student')?.focus();
    return;
  }
  if (!TEXT_FIELDS.some((f) => (ed[f] || '').trim())) {
    toast('The note is empty');
    return;
  }
  const now = Date.now();
  const lesson = {
    id: ed.noteId || ed.id,
    studentId: ed.studentId,
    date: ed.date || todayISO(),
    minutes: Number(ed.minutes) || 60,
    ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, (ed[f] || '').trim()])),
    createdAt: ed.createdAt || now,
    updatedAt: now,
  };
  try {
    await db.put('lessons', lesson);
  } catch {
    toast("Couldn't save. Try again.");
    return;
  }
  state.lessons.set(lesson.id, lesson);
  state.settings.lastMinutes = lesson.minutes;
  saveSettings();
  await clearEditor();
  askPersist();
  toast('Note saved');
  go(`/student/${lesson.studentId}`, true);
}

async function cancelEditor() {
  const ed = state.editor;
  if (isDirty(ed) && !confirm(ed.noteId ? 'Discard your changes?' : 'Discard this note?')) return;
  const back = ed?.from || '/';
  await clearEditor();
  go(back, true);
}

async function deleteNote() {
  const ed = state.editor;
  const lesson = ed?.noteId && state.lessons.get(ed.noteId);
  if (!lesson || !confirm("Delete this lesson note? This can't be undone.")) return;
  await db.del('lessons', lesson.id);
  state.lessons.delete(lesson.id);
  await clearEditor();
  toast('Note deleted');
  go(state.students.has(lesson.studentId) ? `/student/${lesson.studentId}` : '/', true);
}

async function shareNote(id) {
  const lesson = state.lessons.get(id);
  if (!lesson) return;
  const text = shareText({ studentName: state.students.get(lesson.studentId)?.name || '', dateLabel: fmtDate(lesson.date), lesson });
  if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* cancelled */ }
    return;
  }
  toast((await copyText(text)) ? 'Note copied' : "Couldn't copy the note");
}

// ---------- review card ----------

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

function renderReview(studentId) {
  const s = studentId ? state.students.get(studentId) : null;
  const { reviewUrl, reviewFooter, schoolName } = state.settings;
  const phone = cleanPhone(s?.phone);
  let qr;
  try {
    qr = qrSvg(reviewUrl);
  } catch {
    qr = '<p class="rv-error">That review link is too long for a QR code. Change it in Settings.</p>';
  }
  const smsHref = `sms:${phone}&body=${encodeURIComponent(reviewMessage())}`;
  app.innerHTML = `
    ${header({ left: backLink(s ? `/student/${s.id}` : '/', s ? firstName(s.name) : 'Back'), title: 'Review' })}
    <main class="view review-view">
      <div class="review-card">
        <h2 class="rv-title">Please leave a review</h2>
        <div class="rv-stars" aria-label="Five stars">${ICON.star.repeat(5)}</div>
        <p class="rv-sub">Help other families find a trusted school</p>
        <div class="rv-qr">${qr}</div>
        <div class="rv-link">${esc(prettyUrl(reviewUrl))}</div>
        <p class="rv-hint">Scan with your phone's camera</p>
        ${schoolBrand(schoolName)}
        ${reviewFooter ? `<p class="rv-thanks">${esc(reviewFooter)}</p>` : ''}
      </div>
      <div class="rv-actions">
        ${s && phone ? `<a class="btn btn-primary btn-block" href="${esc(smsHref)}">Text the link to ${esc(firstName(s.name))}</a>` : ''}
        <button class="btn btn-block${s && phone ? '' : ' btn-primary'}" data-action="share-review">Send the link…</button>
      </div>
    </main>`;
  keepAwake(true);
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

function renderSettings() {
  const st = state.settings;
  const last = st.lastBackup ? new Date(st.lastBackup).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never';
  app.innerHTML = `
    ${header({ left: backLink('/', 'Students'), title: 'Settings' })}
    <main class="view settings">
      <section class="card">
        <h2>Backup</h2>
        <p>Your notes are saved on this phone only. If the app is deleted or the phone is lost, they're gone, so save a backup to Files or iCloud Drive now and then.</p>
        <p class="fine">Last backup: ${esc(last)} · ${plural(state.students.size, 'student')}, ${plural(state.lessons.size, 'note')}</p>
        <button class="btn btn-primary btn-block" data-action="backup">Save a backup</button>
        <button class="btn btn-block" data-action="restore">Restore from a backup</button>
        <input id="restore-file" type="file" accept=".json,application/json" hidden>
      </section>
      <section class="card">
        <h2>Review card</h2>
        <label class="field"><span class="label">Review link</span>
          <input id="st-url" type="url" value="${esc(st.reviewUrl)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="field"><span class="label">School name</span>
          <input id="st-school" value="${esc(st.schoolName)}" autocomplete="off"></label>
        <label class="field"><span class="label">Bottom line</span>
          <input id="st-footer" value="${esc(st.reviewFooter)}" autocomplete="off"></label>
        <button class="btn btn-block" data-action="save-review-settings">Save review card</button>
      </section>
      <section class="card">
        <h2>How to use</h2>
        <ol class="steps">
          <li>After a lesson, tap <strong>New lesson note</strong>, pick the student, and tap the box under <em>What happened?</em></li>
          <li>Tap the 🎤 on the keyboard and talk. Tap it again when you're done.</li>
          <li>Tap <strong>Copy for Claude</strong> (or ChatGPT), then <strong>Open Claude</strong>. Paste, send, and copy its reply.</li>
          <li>Come back, tap <strong>Paste AI reply</strong>, check the note, and tap <strong>Save</strong>.</li>
        </ol>
        <p class="fine">No 🎤 on your keyboard? Turn on Settings › General › Keyboard › Enable Dictation.</p>
      </section>
      <p class="fine center">Lesson Notes ${VERSION}</p>
    </main>`;
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
  const data = {
    app: 'lesson-notes',
    version: 1,
    exportedAt: new Date().toISOString(),
    students: [...state.students.values()],
    lessons: [...state.lessons.values()],
  };
  const name = `lesson-notes-backup-${todayISO()}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Lesson Notes backup' });
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
  if (data?.app !== 'lesson-notes' || !Array.isArray(data.students) || !Array.isArray(data.lessons)) {
    toast("That file isn't a Lesson Notes backup");
    return;
  }
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const students = data.students
    .filter((s) => s && str(s.id) && str(s.name))
    .map((s) => ({
      id: s.id, name: s.name, phone: str(s.phone), notes: str(s.notes), archived: !!s.archived,
      createdAt: num(s.createdAt), updatedAt: num(s.updatedAt),
    }));
  const lessons = data.lessons
    .filter((l) => l && str(l.id) && str(l.studentId) && /^\d{4}-\d{2}-\d{2}$/.test(str(l.date)))
    .map((l) => ({
      id: l.id, studentId: l.studentId, date: l.date, minutes: num(l.minutes, 60),
      ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, str(l[f])])),
      createdAt: num(l.createdAt), updatedAt: num(l.updatedAt),
    }));
  const newer = (item, map) => !map.has(item.id) || item.updatedAt > (map.get(item.id).updatedAt || 0);
  const studentsIn = students.filter((s) => newer(s, state.students));
  const knownIds = new Set([...state.students.keys(), ...students.map((s) => s.id)]);
  const lessonsIn = lessons.filter((l) => knownIds.has(l.studentId) && newer(l, state.lessons));
  if (!studentsIn.length && !lessonsIn.length) {
    toast('Everything in that backup is already here');
    return;
  }
  if (!confirm(`Restore ${plural(studentsIn.length, 'student')} and ${plural(lessonsIn.length, 'lesson note')} from this backup?`)) return;
  await db.putMany('students', studentsIn);
  await db.putMany('lessons', lessonsIn);
  studentsIn.forEach((s) => state.students.set(s.id, s));
  lessonsIn.forEach((l) => state.lessons.set(l.id, l));
  toast('Backup restored');
  go('/');
}

// ---------- events ----------

const actions = {
  'new-note': (el) => {
    const ed = state.editor;
    if (ed && !ed.noteId && isDirty(ed)) {
      state.restored = true;
      go('/note/new');
      return;
    }
    const active = activeStudents();
    const studentId = el.dataset.student || (active.length === 1 ? active[0].id : '');
    startEditor(blankNote(studentId), currentPath());
    go('/note/new');
  },
  'edit-note': (el) => {
    const lesson = state.lessons.get(el.dataset.id);
    if (!lesson) return;
    startEditor({ ...lesson, noteId: lesson.id }, currentPath());
    go(`/note/${lesson.id}`);
  },
  'toggle-finished': () => {
    state.showFinished = !state.showFinished;
    $('#results').innerHTML = homeResults();
  },
  'set-minutes': (el) => {
    state.editor.minutes = Number(el.dataset.min);
    $$('.chip', app).forEach((chip) => chip.classList.toggle('on', chip === el));
    queueDraft();
  },
  'custom-minutes': () => {
    const value = Math.round(Number(prompt('Lesson length in minutes', state.editor.minutes)));
    if (value > 0 && value < 1000) {
      state.editor.minutes = value;
      queueDraft();
      render();
    }
  },
  'copy-ai': (el) => copyForAI(el.dataset.ai),
  'paste-reply': () => pasteReply(),
  'use-paste': () => useFallbackPaste(),
  'editor-save': () => saveEditor(),
  'editor-cancel': () => cancelEditor(),
  'delete-note': () => deleteNote(),
  'save-student': (el) => saveStudent(el.dataset.id || null),
  'delete-student': (el) => deleteStudent(el.dataset.id),
  'share-note': (el) => shareNote(el.dataset.id),
  'share-review': () => shareReview(),
  backup: () => backup(),
  restore: () => $('#restore-file').click(),
  'save-review-settings': () => saveReviewSettings(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  actions[el.dataset.action](el, e);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'search') {
    state.query = t.value;
    $('#results').innerHTML = homeResults();
    return;
  }
  if (t.id === 'f-paste') {
    if (e.inputType === 'insertFromPaste') useFallbackPaste();
    return;
  }
  if (t.tagName === 'TEXTAREA') autosize(t);
  if (state.editor && t.dataset.field) {
    state.editor[t.dataset.field] = t.value;
    queueDraft();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'f-student') onStudentPick(t);
  else if (t.id === 'restore-file') restoreFrom(t);
  else if (state.editor && t.dataset.field) {
    state.editor[t.dataset.field] = t.value;
    queueDraft();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 's-name') {
    e.preventDefault();
    saveStudent($('[data-action="save-student"]').dataset.id || null);
  }
});

// Hide the bottom button while the keyboard is up so it doesn't float over what you're typing.
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
  if (document.hidden) saveDraftNow();
  else if (parseRoute().name === 'review') keepAwake(true);
});
addEventListener('pagehide', saveDraftNow);

// ---------- start ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new version took over: reload so it's in use, unless you're mid-note.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !isDirty(state.editor)) location.reload();
  });
}

async function start() {
  try {
    const [students, lessons, settings, draft] = await Promise.all([
      db.all('students'), db.all('lessons'), db.getMeta('settings'), db.getMeta('draft'),
    ]);
    students.forEach((s) => state.students.set(s.id, s));
    lessons.forEach((l) => state.lessons.set(l.id, l));
    Object.assign(state.settings, settings || {});
    if (draft) {
      if (draft.noteId && !state.lessons.has(draft.noteId)) draft.noteId = null;
      state.editor = draft;
      state.restored = true;
      history.replaceState(null, '', draft.noteId ? `#/note/${draft.noteId}` : '#/note/new');
    }
  } catch (err) {
    app.innerHTML = `<main class="view"><div class="card"><h2>Couldn't open your notes</h2>
      <p>${esc(err?.message || err)}</p><p>Close the app completely and open it again.</p></div></main>`;
    return;
  }
  addEventListener('hashchange', render);
  render();
  registerServiceWorker();
}

start();
