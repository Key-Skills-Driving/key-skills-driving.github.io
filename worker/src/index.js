// KSDS Lessons school server (Cloudflare Worker).
//
// Holds the school's Gemini key and a list of phones the admin has approved, so staff can use
// Break it down without a key of their own. It only writes lesson breakdowns (the prompt is built
// here, not sent by the phone), only answers the app's own web address, and stores no lesson text.
//
// Each phone makes up an id and a secret token the first time it asks to join; this server keeps
// only a hash of the token. The first phone to claim admin becomes the admin, and after that only
// admins can approve, remove or promote phones.
import { systemPrompt, userMessage, modifyMessage, writeWithGemini, checkGeminiKey } from '../../docs/ai.js';

const APP_ORIGINS = new Set(['https://key-skills-driving.github.io', 'http://localhost:5173']);
const MAX = { name: 40, raw: 8000, current: 8000, change: 2000, extra: 800, key: 200 };
const DAILY_LIMIT = 200; // breakdowns per phone per day, so one lost phone can't use up the school's free allowance
const MAX_WAITING = 50;

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = APP_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' },
      });
    }
    try {
      if (!APP_ORIGINS.has(origin)) throw new Refusal(403, 'This server only works from the KSDS Lessons app.');
      const body = await handle(request, env);
      return reply(body, 200, cors);
    } catch (err) {
      if (err instanceof Refusal) return reply({ error: err.message }, err.status, cors);
      return reply({ error: 'Something went wrong on the school server. Try again.' }, 500, cors);
    }
  },
};

function reply(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function handle(request, env) {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  const phone = await identify(request, env);
  const input = request.method === 'POST' ? await readJson(request) : {};

  switch (route) {
    case 'GET /me': return me(phone, env);
    case 'POST /join': return join(phone, input, env);
    case 'POST /breakdown': {
      await allowWriting(phone, env);
      const raw = text(input.raw, MAX.raw, 'notes');
      return { text: await write(env, systemPrompt(text(input.extra, MAX.extra)), userMessage({ raw })) };
    }
    case 'POST /modify': {
      await allowWriting(phone, env);
      const user = modifyMessage({ raw: text(input.raw, MAX.raw), current: text(input.current, MAX.current, 'breakdown'), change: text(input.change, MAX.change, 'change') });
      return { text: await write(env, systemPrompt(text(input.extra, MAX.extra)), user) };
    }
    case 'POST /admin/claim': return claimAdmin(phone, input, env);
    case 'GET /admin/phones': await requireAdmin(phone); return listPhones(env);
    case 'POST /admin/approve': await requireAdmin(phone); return setStatus(env, input.id, 'approved');
    case 'POST /admin/remove': await requireAdmin(phone); return removePhone(env, phone, input.id);
    case 'POST /admin/role': await requireAdmin(phone); return setAdmin(env, phone, input.id, !!input.admin);
    case 'POST /admin/key': await requireAdmin(phone); return saveKey(env, input.key);
    default: throw new Refusal(404, 'Not found.');
  }
}

async function readJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new Refusal(400, "The app sent something the server couldn't read.");
  }
}

// `required` names the field for messages ("notes", "first name"); leave it out for optional fields.
function text(value, max, required) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new Refusal(400, `Nothing to go on: the ${required} came through empty.`);
  if (s.length > max) throw new Refusal(413, `That ${required || 'text'} is too long.`);
  return s;
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every request carries the phone's id and secret token.
async function identify(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Device ([a-f0-9]{32}):([A-Za-z0-9_-]{43})$/);
  if (!m) throw new Refusal(401, 'This phone needs to ask to join first.');
  const [, id, token] = m;
  const hash = await sha256(token);
  const row = await env.DB.prepare('SELECT * FROM phones WHERE id = ?').bind(id).first();
  if (row && row.token_hash !== hash) throw new Refusal(401, "This phone's sign-in doesn't match. Use Wipe App in Settings and ask to join again.");
  return { id, hash, row };
}

async function adminExists(env) {
  return !!(await env.DB.prepare("SELECT 1 FROM phones WHERE admin = 1 AND status = 'approved' LIMIT 1").first());
}

async function me(phone, env) {
  const r = phone.row;
  return { status: r?.status || 'none', name: r?.name || '', admin: !!(r?.admin && r.status === 'approved'), adminExists: await adminExists(env) };
}

async function join(phone, input, env) {
  const name = text(input.name, MAX.name, 'first name');
  const now = Date.now();
  const r = phone.row;
  if (r?.status === 'approved') return me(phone, env);
  if (!r) {
    const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM phones WHERE status = 'pending'").first();
    if (waiting.n >= MAX_WAITING) throw new Refusal(429, 'Too many phones are waiting for approval. Ask your admin to clear the list.');
    await env.DB.prepare("INSERT INTO phones (id, token_hash, name, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(phone.id, phone.hash, name, now).run();
  } else {
    await env.DB.prepare("UPDATE phones SET name = ?, status = 'pending', created_at = ? WHERE id = ?").bind(name, now, phone.id).run();
  }
  return { status: 'pending', name, admin: false, adminExists: await adminExists(env) };
}

async function allowWriting(phone, env) {
  const r = phone.row;
  if (!r) throw new Refusal(403, "This phone hasn't joined yet. Ask to join first.");
  if (r.status === 'removed') throw new Refusal(403, 'This phone was removed. Ask to join again.');
  if (r.status !== 'approved') throw new Refusal(403, 'Still waiting for your admin to approve this phone.');
  const today = new Date().toISOString().slice(0, 10);
  const used = r.day === today ? r.day_count : 0;
  if (used >= DAILY_LIMIT) throw new Refusal(429, "This phone has hit today's limit. Try again tomorrow.");
  await env.DB.prepare('UPDATE phones SET day = ?, day_count = ?, last_seen = ? WHERE id = ?').bind(today, used + 1, Date.now(), phone.id).run();
}

async function schoolKey(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE name = 'gemini_key'").first();
  return row?.value || env.GEMINI_KEY || '';
}

async function write(env, system, user) {
  const apiKey = await schoolKey(env);
  if (!apiKey) throw new Refusal(503, "The school's AI isn't set up yet. Ask your admin to add the key.");
  try {
    return await writeWithGemini({ apiKey, system, user });
  } catch (err) {
    // Messages about the key are for the admin, not for whoever is dictating.
    const message = /key/i.test(err.message) ? "The school's AI key isn't working. Let your admin know." : err.message;
    throw new Refusal(502, message);
  }
}

async function claimAdmin(phone, input, env) {
  if (await adminExists(env)) throw new Refusal(403, 'This school already has an admin.');
  const name = text(input.name, MAX.name) || 'Admin';
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO phones (id, token_hash, name, status, admin, created_at, approved_at) VALUES (?, ?, ?, 'approved', 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'approved', admin = 1, name = excluded.name, approved_at = excluded.approved_at`)
    .bind(phone.id, phone.hash, name, now, now).run();
  return { status: 'approved', name, admin: true, adminExists: true };
}

async function requireAdmin(phone) {
  if (!phone.row?.admin || phone.row.status !== 'approved') throw new Refusal(403, 'Only an admin can do that.');
}

async function listPhones(env) {
  const { results } = await env.DB.prepare("SELECT id, name, status, admin, created_at, approved_at, last_seen FROM phones WHERE status != 'removed' ORDER BY status = 'pending' DESC, created_at DESC").all();
  return { phones: results.map((p) => ({ ...p, admin: !!p.admin })), keySet: !!(await schoolKey(env)) };
}

async function setStatus(env, id, status) {
  const res = await env.DB.prepare('UPDATE phones SET status = ?, approved_at = ? WHERE id = ?').bind(status, Date.now(), String(id)).run();
  if (!res.meta.changes) throw new Refusal(404, 'That phone is no longer on the list.');
  return listPhones(env);
}

async function otherAdmins(env, id) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM phones WHERE admin = 1 AND status = 'approved' AND id != ?").bind(String(id)).first()).n;
}

async function removePhone(env, phone, id) {
  const target = await env.DB.prepare('SELECT admin FROM phones WHERE id = ?').bind(String(id)).first();
  if (target?.admin && !(await otherAdmins(env, id))) throw new Refusal(409, "You can't remove the only admin. Make someone else an admin first.");
  await env.DB.prepare("UPDATE phones SET status = 'removed', admin = 0 WHERE id = ?").bind(String(id)).run();
  return listPhones(env);
}

async function setAdmin(env, phone, id, admin) {
  if (!admin && !(await otherAdmins(env, id))) throw new Refusal(409, "There has to be at least one admin.");
  const res = await env.DB.prepare("UPDATE phones SET admin = ? WHERE id = ? AND status = 'approved'").bind(admin ? 1 : 0, String(id)).run();
  if (!res.meta.changes) throw new Refusal(404, 'Approve that phone first.');
  return listPhones(env);
}

async function saveKey(env, key) {
  const value = text(key, MAX.key, 'key');
  const check = await checkGeminiKey(value);
  if (!check.ok) throw new Refusal(400, check.message);
  await env.DB.prepare("INSERT INTO settings (name, value) VALUES ('gemini_key', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").bind(value).run();
  return listPhones(env);
}
