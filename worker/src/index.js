// KSDS Lessons school server (Cloudflare Worker).
//
// Holds the school's Gemini key and a list of phones the admin has approved, so staff can use
// Break it down without a key of their own. It only writes lesson breakdowns (the prompt is built
// here, not sent by the phone) and fetches practice routes, only answers the app's own web address,
// and stores no lesson text.
//
// Each phone makes up an id and a secret token the first time it asks to join; this server keeps
// only a hash of the token. The first phone to claim admin becomes the admin, and after that only
// admins can approve, remove or promote phones.
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { systemPrompt, userMessage, modifyMessage, normalizeStyle, writeWithGemini, checkGeminiKey } from '../../docs/ai.js';

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
  async fetch(request, env, ctx) {
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
      const body = await handle(request, env, ctx);
      if (body instanceof Response) { // a route, passed straight through so the server never has to parse it
        Object.entries(cors).forEach(([k, v]) => body.headers.set(k, v));
        return body;
      }
      return reply(body, 200, cors);
    } catch (err) {
      if (err instanceof Refusal) return reply({ error: err.message }, err.status, cors);
      console.error('school server error:', err?.message || err); // the message only, never the request
      return reply({ error: 'Something went wrong on the school server. Try again.' }, 500, cors);
    }
  },
};

function reply(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function handle(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  const phone = await identify(request, env);
  const input = request.method === 'POST' ? await readJson(request) : {};

  switch (route) {
    case 'GET /me': return me(phone, env);
    case 'POST /join': return join(phone, input, env, ctx);
    case 'POST /admin/push': await requireAdmin(phone); return setPush(env, phone, input.subscription);
    case 'POST /breakdown': {
      await allowWriting(phone, env);
      const raw = text(input.raw, MAX.raw, 'notes');
      // normalizeStyle drops anything unknown and caps the examples, so a phone can't pad the prompt.
      return { text: await write(env, systemPrompt(text(input.extra, MAX.extra), normalizeStyle(input.style)), userMessage({ raw })) };
    }
    case 'POST /modify': {
      await allowWriting(phone, env);
      const user = modifyMessage({ raw: text(input.raw, MAX.raw), current: text(input.current, MAX.current, 'breakdown'), change: text(input.change, MAX.change, 'change') });
      return { text: await write(env, systemPrompt(text(input.extra, MAX.extra), normalizeStyle(input.style)), user) };
    }
    case 'POST /route': await allowWriting(phone, env); return drivingRoute(env, input);
    case 'GET /test-routes': requireApproved(phone); return listTestRoutes(env);
    case 'POST /test-routes': await requireAdmin(phone); return addTestRoute(env, phone, input);
    case 'POST /test-routes/delete': await requireAdmin(phone); return deleteTestRoute(env, input.id);
    case 'POST /admin/claim': return claimAdmin(phone, input, env);
    case 'GET /admin/phones': await requireAdmin(phone); return listPhones(env);
    case 'POST /admin/approve': await requireAdmin(phone); return setStatus(env, input.id, 'approved');
    case 'POST /admin/remove': await requireAdmin(phone); return removePhone(env, phone, input.id);
    case 'POST /admin/role': await requireAdmin(phone); return setAdmin(env, phone, input.id, !!input.admin);
    case 'POST /admin/transfer': await requireAdmin(phone); return transferOwner(env, phone, input.id, input.confirm);
    case 'POST /admin/key': await requireAdmin(phone); return saveKey(env, input.key);
    default:
      // A student's link to one test route: no approval needed, the random id is the key.
      if (request.method === 'GET' && pathname.startsWith('/shared/')) return sharedRoute(env, pathname.slice('/shared/'.length));
      throw new Refusal(404, 'Not found.');
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
  return { status: r?.status || 'none', name: r?.name || '', admin: !!(r?.admin && r.status === 'approved'), owner: !!(r?.owner && r.status === 'approved'), adminExists: await adminExists(env), push: !!r?.push };
}

async function join(phone, input, env, ctx) {
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
  ctx.waitUntil(notifyAdmins(env, name)); // after the reply goes out, so a slow push never delays the join
  return { status: 'pending', name, admin: false, adminExists: await adminExists(env) };
}

// ---------- notifications to admins ----------

async function setPush(env, phone, subscription) {
  let value = null;
  if (subscription) {
    const s = subscription;
    const ok = typeof s?.endpoint === 'string' && s.endpoint.startsWith('https://') && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
    if (!ok) throw new Refusal(400, "That notification setup didn't look right. Try turning it on again.");
    value = JSON.stringify({ endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    if (value.length > 2000) throw new Refusal(413, 'That notification setup is too long.');
  }
  await env.DB.prepare('UPDATE phones SET push = ? WHERE id = ?').bind(value, phone.id).run();
  return { push: !!value };
}

// Tells every admin who turned notifications on. A failure here must never break the join.
async function notifyAdmins(env, name) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return;
  const { results } = await env.DB.prepare("SELECT id, push FROM phones WHERE admin = 1 AND status = 'approved' AND push IS NOT NULL").all();
  const vapid = { subject: env.VAPID_SUBJECT || 'https://key-skills-driving.github.io/', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const message = {
    data: JSON.stringify({ title: 'KSDS Lessons', body: `${name} asked to join. Tap to approve.`, url: './#/phones', tag: 'join-request' }),
    options: { ttl: 86400 },
  };
  await Promise.all(results.map(async (row) => {
    try {
      const sub = JSON.parse(row.push);
      const res = await fetch(sub.endpoint, await buildPushPayload(message, sub, vapid));
      // 404 or 410 means the phone let the subscription go; forget it rather than keep trying.
      if (res.status === 404 || res.status === 410) await env.DB.prepare('UPDATE phones SET push = NULL WHERE id = ?').bind(row.id).run();
    } catch (err) {
      console.error('push failed:', err?.message || err);
    }
  }));
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

// ---------- practice routes ----------
// The Routes tab sends the points it picked (start, practice spots, back to start) and this asks the free
// OpenRouteService for the driving route with the school's key (the ORS_KEY secret), so no phone ever
// holds it. Only coordinates go out: no names, no notes.
const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
const MAX_POINTS = 40;

async function drivingRoute(env, input) {
  if (!env.ORS_KEY) throw new Refusal(503, "Routes aren't set up on the school server yet. Let your admin know.");
  const points = Array.isArray(input.points) ? input.points : [];
  if (points.length < 2 || points.length > MAX_POINTS) throw new Refusal(400, `A route needs 2 to ${MAX_POINTS} points.`);
  const coordinates = points.map((p) => {
    const lat = Number(p?.[0]);
    const lon = Number(p?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Refusal(400, 'One of the route points is off the map.');
    return [lon, lat];
  });
  // How far each point may be moved to reach a road (GPS in a driveway needs more room than a spot on a street).
  const radiuses = coordinates.map((_, i) => Math.min(Math.max(Number(input.radiuses?.[i]) || 60, 10), 1000));
  // Which way to be heading at a point ([] for any), so a left at a light is driven toward the light.
  const bearings = coordinates.map((_, i) => {
    const b = input.bearings?.[i];
    return Array.isArray(b) && b.length === 2 && b.every(Number.isFinite) ? [((b[0] % 360) + 360) % 360, Math.min(Math.max(b[1], 10), 180)] : [];
  });
  const body = { coordinates, radiuses, instructions: true, continue_straight: true, units: 'm', elevation: false };
  if (bearings.some((b) => b.length)) body.bearings = bearings;
  if (input.avoidFreeways) body.options = { avoid_features: ['highways'] };
  const res = await fetch(ORS_URL, {
    method: 'POST',
    headers: { Authorization: env.ORS_KEY, 'Content-Type': 'application/json', Accept: 'application/json, application/geo+json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return new Response(res.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  let detail = '';
  try {
    detail = (await res.json())?.error?.message || '';
  } catch {
    // not JSON; the status says enough
  }
  if (res.status === 401 || res.status === 403) throw new Refusal(502, "The school's route key isn't working. Let your admin know.");
  if (res.status === 429) throw new Refusal(429, 'The free route service is busy or used up for today. Try again in a minute.');
  // ORS names the point it couldn't reach ("coordinate 3"), which the app uses to swap that spot out.
  throw new Refusal(422, detail || "Couldn't find a driving route through those spots.");
}

// ---------- test routes ----------
// Routes the school uses for road-test days. Admins add them from a route they built; every approved
// phone sees them; a student gets one through its link. Only what the app drew is stored: no names.
const MAX_TEST_ROUTES = 50;
const MAX_ROUTE_BYTES = 60000;
const SHARE_ID = /^[A-Za-z0-9]{12}$/;

function requireApproved(phone) {
  if (phone.row?.status !== 'approved') throw new Refusal(403, 'Still waiting for your admin to approve this phone.');
}

function shareId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => chars[b % chars.length]).join('');
}

async function listTestRoutes(env) {
  const { results } = await env.DB.prepare('SELECT id, name, data, created_at FROM test_routes ORDER BY created_at').all();
  return { routes: results.map((r) => ({ ...JSON.parse(r.data), id: r.id, name: r.name, createdAt: r.created_at })) };
}

async function addTestRoute(env, phone, input) {
  const name = text(input.name, 80, 'route name');
  const route = input.route;
  // Built routes have up to 9 stops; one typed in as a list of turns can have up to 39.
  const ok = route && typeof route === 'object' && typeof route.line === 'string' && Array.isArray(route.stops)
    && route.stops.length <= 39 && Number.isFinite(route.start?.lat) && Number.isFinite(route.start?.lon);
  if (!ok) throw new Refusal(400, "That route didn't come through right. Build it again and retry.");
  const { line, start, startKind, minutes, level, seconds, meters, stops } = route;
  const data = JSON.stringify({ line, start, startKind, minutes, level, seconds, meters, stops, fromTurns: route.fromTurns === true });
  if (data.length > MAX_ROUTE_BYTES) throw new Refusal(413, 'That route is too long to share.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM test_routes').first();
  if (count.n >= MAX_TEST_ROUTES) throw new Refusal(409, `There are already ${MAX_TEST_ROUTES} test routes. Delete one first.`);
  const id = shareId();
  await env.DB.prepare('INSERT INTO test_routes (id, name, data, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, data, phone.row?.name || '', Date.now()).run();
  return { id, ...(await listTestRoutes(env)) };
}

async function deleteTestRoute(env, id) {
  await env.DB.prepare('DELETE FROM test_routes WHERE id = ?').bind(String(id)).run();
  return listTestRoutes(env);
}

async function sharedRoute(env, id) {
  const row = SHARE_ID.test(id) ? await env.DB.prepare('SELECT id, name, data FROM test_routes WHERE id = ?').bind(id).first() : null;
  if (!row) throw new Refusal(404, "This practice route isn't available any more. Ask your instructor for a new link.");
  return { ...JSON.parse(row.data), id: row.id, name: row.name };
}

async function claimAdmin(phone, input, env) {
  if (await adminExists(env)) throw new Refusal(403, 'This school already has an admin.');
  const name = text(input.name, MAX.name) || 'Admin';
  const now = Date.now();
  // The first admin is also the master admin.
  await env.DB.prepare(`INSERT INTO phones (id, token_hash, name, status, admin, owner, created_at, approved_at) VALUES (?, ?, ?, 'approved', 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'approved', admin = 1, owner = 1, name = excluded.name, approved_at = excluded.approved_at`)
    .bind(phone.id, phone.hash, name, now, now).run();
  return { status: 'approved', name, admin: true, owner: true, adminExists: true };
}

// Passing on master admin: only the master admin can, only to an approved phone, and only with
// the confirm flag the app sets after the tick box and the confirmation. Both rows change together.
async function transferOwner(env, phone, id, confirmed) {
  if (!phone.row?.owner) throw new Refusal(403, 'Only the master admin can pass it on.');
  if (confirmed !== true) throw new Refusal(400, 'Tick the box to confirm first.');
  if (String(id) === phone.id) throw new Refusal(400, "You're already the master admin.");
  const target = await env.DB.prepare('SELECT id, status FROM phones WHERE id = ?').bind(String(id)).first();
  if (!target || target.status !== 'approved') throw new Refusal(404, 'Approve that phone first.');
  await env.DB.batch([
    env.DB.prepare('UPDATE phones SET owner = 0 WHERE id = ?').bind(phone.id),
    env.DB.prepare('UPDATE phones SET owner = 1, admin = 1 WHERE id = ?').bind(target.id),
  ]);
  return listPhones(env);
}

async function requireAdmin(phone) {
  if (!phone.row?.admin || phone.row.status !== 'approved') throw new Refusal(403, 'Only an admin can do that.');
}

async function listPhones(env) {
  const { results } = await env.DB.prepare("SELECT id, name, status, admin, owner, created_at, approved_at, last_seen FROM phones WHERE status != 'removed' ORDER BY status = 'pending' DESC, owner DESC, created_at DESC").all();
  return { phones: results.map((p) => ({ ...p, admin: !!p.admin, owner: !!p.owner })), keySet: !!(await schoolKey(env)) };
}

async function isOwner(env, id) {
  return !!(await env.DB.prepare('SELECT 1 FROM phones WHERE id = ? AND owner = 1').bind(String(id)).first());
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
  if (await isOwner(env, id)) throw new Refusal(403, "The master admin can't be removed. They can pass the role on from their own phone.");
  const target = await env.DB.prepare('SELECT admin FROM phones WHERE id = ?').bind(String(id)).first();
  if (target?.admin && !(await otherAdmins(env, id))) throw new Refusal(409, "You can't remove the only admin. Make someone else an admin first.");
  await env.DB.prepare("UPDATE phones SET status = 'removed', admin = 0 WHERE id = ?").bind(String(id)).run();
  return listPhones(env);
}

async function setAdmin(env, phone, id, admin) {
  if (!admin && (await isOwner(env, id))) throw new Refusal(403, 'The master admin is always an admin.');
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
