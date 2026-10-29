// Drive mode: turn-by-turn directions inside the app. Google and Apple Maps treat every point a link
// hands them as a stop ("You have arrived… Continue?"), so a route is driven here instead, start to
// finish: a car follows the phone's GPS along the route, the banner shows the next turn, and the
// phone's own voice reads it out (Mute silences it). GPS, the voice and the moving car all run on the
// phone and cost nothing. Only a missed turn on an instructor's phone asks the school server for a
// way back, which is one route request.
//
// The app has to stay open on screen: a web app gets no GPS once the phone locks or another app is in
// front, so directions pause until it's back. Nothing here touches the page at load, so the school
// server can import cleanGuide from this file.

import { dist, bearing, turnAngle, shortName } from './geo.js';

const CODES = ['depart', 'left', 'right', 'slight-left', 'slight-right', 'sharp-left', 'sharp-right', 'keep-left', 'keep-right', 'uturn', 'roundabout', 'arrive'];
// The route service's step types worth saying (openrouteservice instruction types).
const ORS_TYPES = { 0: 'left', 1: 'right', 2: 'sharp-left', 3: 'sharp-right', 4: 'slight-left', 5: 'slight-right', 7: 'roundabout', 9: 'uturn', 12: 'keep-left', 13: 'keep-right' };
const VERB = {
  left: 'Turn left', right: 'Turn right', 'slight-left': 'Bear left', 'slight-right': 'Bear right', 'sharp-left': 'Turn sharp left',
  'sharp-right': 'Turn sharp right', 'keep-left': 'Keep left', 'keep-right': 'Keep right', uturn: 'Make a U-turn',
};
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ON_ROUTE_M = 35; // this close to the line (plus some GPS slack) counts as on the route
const OFF_ROUTE_MS = 4000; // this long away from it before it says "Off route"
const REROUTE_GAP_MS = 20000;
const MAX_REROUTES = 12; // per drive: the school's free route key allows 200 requests a day for everyone

// ---------- the turn list ----------

const streetName = (name) => (name && name !== '-' ? String(name).slice(0, 80) : '');

function cumulative(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  return cum;
}

// The index of the last point at or before `s` meters along the line.
function indexAt(cum, s) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function pointAt(path, s) {
  const { line, cum } = path;
  const x = Math.min(Math.max(s, 0), cum.at(-1));
  const i = Math.min(indexAt(cum, x), line.length - 2);
  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? (x - cum[i]) / span : 0;
  return { lat: line[i].lat + (line[i + 1].lat - line[i].lat) * t, lon: line[i].lon + (line[i + 1].lon - line[i].lon) * t };
}

const headingAt = (path, s) => bearing(pointAt(path, s - 10), pointAt(path, s + 15));

// Which way the line turns at point i, judged 25 m either side; null when it doesn't really turn.
function cornerAt(path, i, min) {
  const before = pointAt(path, path.cum[i] - 25);
  const after = pointAt(path, path.cum[i] + 25);
  if (dist(before, path.line[i]) < 8 || dist(path.line[i], after) < 8) return null;
  const angle = turnAngle(bearing(before, path.line[i]), bearing(path.line[i], after));
  return Math.abs(angle) > 150 ? 'uturn' : angle <= -min ? 'left' : angle >= min ? 'right' : null;
}

// The route service's directions, kept with the route as [line index, what, street, roundabout exit].
// The points a route is aimed through split it into pieces; a turn right at one of those shows only in
// the shape of the line, so it's read from that.
export function makeGuide(feature) {
  const line = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const shape = { line, cum: cumulative(line) };
  const segments = feature.properties.segments || [];
  const guide = [[0, 'depart', streetName(segments[0]?.steps?.[0]?.name)]];
  const joins = [];
  segments.forEach((seg, k) => (seg.steps || []).forEach((st) => {
    const i = st.way_points?.[0];
    if (!Number.isInteger(i) || i <= 0 || i >= line.length - 1) return;
    if (st.type === 7) guide.push([i, 'roundabout', streetName(st.name), st.exit_number || 1]);
    else if (ORS_TYPES[st.type]) guide.push([i, ORS_TYPES[st.type], streetName(st.name)]);
    else if (st.type === 11 && k > 0) joins.push([i, streetName(st.name)]);
  }));
  joins.forEach(([i, name]) => {
    const code = cornerAt(shape, i, 35);
    if (code && !guide.some(([j]) => Math.abs(shape.cum[j] - shape.cum[i]) < 40)) guide.push([i, code, name]);
  });
  guide.sort((a, b) => a[0] - b[0]);
  guide.push([line.length - 1, 'arrive', '']);
  return guide;
}

// Routes saved before Drive mode have no turn list, so their turns are read off the line's shape.
// Gentle bends don't count; the streets go unnamed.
function guideFromLine(shape) {
  const guide = [[0, 'depart', '']];
  let last = -Infinity;
  for (let i = 1; i < shape.line.length - 1; i++) {
    if (shape.cum[i] - last < 50) continue;
    const code = cornerAt(shape, i, 55);
    if (code) {
      guide.push([i, code, '']);
      last = shape.cum[i];
    }
  }
  guide.push([shape.line.length - 1, 'arrive', '']);
  return guide;
}

// Only well-formed steps, so a bad backup or a tampered test route can't break the screen.
export function cleanGuide(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, 600)
    .filter((g) => Array.isArray(g) && Number.isInteger(g[0]) && g[0] >= 0 && CODES.includes(g[1]))
    .map((g) => (g[1] === 'roundabout'
      ? [g[0], g[1], String(g[2] || '').slice(0, 80), Math.min(Math.max(Math.round(Number(g[3]) || 1), 1), 8)]
      : [g[0], g[1], String(g[2] || '').slice(0, 80)]));
  return out.length ? out : null;
}

// ---------- what's being followed ----------

// The route itself, or a way back to it joined onto the rest of the route. `join` says where the rest
// begins on this path (at) and on the route (base), so reminders and rerouting can find their place.
function makePath(line, guide, marks, join = { at: 0, base: 0 }) {
  const cum = cumulative(line);
  return {
    line, cum, total: cum.at(-1), join, marks,
    turns: guide.filter(([i]) => i < line.length).map(([i, code, name, exit]) => ({ s: cum[i], code, name, exit })),
  };
}

const baseS = (path, s) => (s >= path.join.at ? s - path.join.at + path.join.base : path.join.base);

// The nearest place on the path to p, between fromS and toS. With a heading, a stretch going the
// other way loses, so a road driven out and back isn't mixed up.
function locate(path, p, fromS, toS, heading) {
  const { line, cum } = path;
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
  let best = null;
  for (let i = indexAt(cum, Math.max(0, fromS)); i < line.length - 1 && cum[i] <= toS; i++) {
    const a = line[i];
    const b = line[i + 1];
    const ax = (a.lon - p.lon) * kx;
    const ay = (a.lat - p.lat) * 111320;
    const dx = (b.lon - p.lon) * kx - ax;
    const dy = (b.lat - p.lat) * 111320 - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const raw = Math.hypot(ax + dx * t, ay + dy * t);
    const score = raw + (heading !== null && len2 > 1 && Math.abs(turnAngle(heading, bearing(a, b))) > 100 ? 60 : 0);
    if (!best || score < best.score) best = { score, raw, s: cum[i] + (cum[i + 1] - cum[i]) * t };
  }
  return best;
}

// Reminders along the way: a test route's notes ("Parallel park on the right") are said just after
// their turn; a practice route's stops show as the car nears them.
function makeMarks(route, path) {
  const marks = [];
  let from = 0;
  route.stops.forEach((stop, k) => {
    const near = locate(path, stop.at, from, path.total, null);
    if (!near || near.raw > 120) return;
    from = near.s;
    if (route.fromTurns) {
      const notes = String(stop.label || '').split(' · ').slice(1);
      if (k > 0 && notes.length) marks.push({ from: near.s + 15, to: near.s + 600, text: notes.join(' · '), say: true });
    } else {
      marks.push({ from: near.s - 250, to: near.s + 40, text: `Stop ${k + 1}: ${stop.label}`, say: false });
    }
  });
  return marks;
}

// ---------- words ----------

function sayName(name) {
  const words = String(name || '').split(' ');
  if (words.length > 1 && /^(North|South|East|West|[NSEW])$/.test(words[0])) words.shift();
  return words.join(' ');
}

function turnText(t, spoken) {
  const name = spoken ? sayName(t.name) : shortName(t.name);
  const onto = name ? ` onto ${name}` : '';
  switch (t.code) {
    case 'depart': return name ? `Head out on ${name}` : 'Follow the yellow line';
    case 'arrive': return spoken ? "You're back at the start" : 'Back at the start';
    case 'roundabout': return spoken
      ? `At the roundabout, take the ${ORDINAL[(t.exit || 1) - 1] || `number ${t.exit}`} exit${onto}`
      : `Roundabout, exit ${t.exit || 1}${onto}`;
    default: return `${VERB[t.code]}${onto}`;
  }
}

const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

function shownDistance(m) {
  const feet = m * 3.28084;
  if (feet < 528) return `${Math.max(10, Math.round(feet / (feet < 100 ? 10 : 50)) * (feet < 100 ? 10 : 50))} ft`;
  const mi = m / 1609.34;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

function spokenDistance(m) {
  const mi = m / 1609.34;
  if (mi < 0.15) return `${Math.max(100, Math.round((m * 3.28084) / 100) * 100)} feet`;
  if (mi < 0.35) return 'a quarter mile';
  if (mi < 0.65) return 'half a mile';
  if (mi < 0.9) return 'three quarters of a mile';
  const r = Math.round(mi * 2) / 2;
  return r === 1 ? '1 mile' : `${r} miles`;
}

const timeLabel = (secs) => {
  const m = Math.max(1, Math.round(secs / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
};

// ---------- pictures ----------

const icon = (body, extra = '') => `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</g></svg>`;
const MIRROR = ' transform="translate(48 0) scale(-1 1)"';
const STRAIGHT = '<path d="M24 42V8"/><path d="M14 18l10-10 10 10"/>';
const RIGHT = '<path d="M16 42V28q0-10 10-10h12"/><path d="M30 10l8 8-8 8"/>';
const SLIGHT = '<path d="M18 42V30l14-16"/><path d="M23 12h10v10"/>';
const SHARP = '<path d="M16 42V12l18 22"/><path d="M34 24v10H24"/>';
const ARROWS = {
  depart: icon(STRAIGHT),
  back: icon(STRAIGHT),
  right: icon(RIGHT),
  left: icon(RIGHT, MIRROR),
  'slight-right': icon(SLIGHT),
  'keep-right': icon(SLIGHT),
  'slight-left': icon(SLIGHT, MIRROR),
  'keep-left': icon(SLIGHT, MIRROR),
  'sharp-right': icon(SHARP),
  'sharp-left': icon(SHARP, MIRROR),
  uturn: icon('<path d="M32 42V20a8 8 0 0 0-16 0v14"/><path d="M8 26l8 8 8-8"/>'),
  roundabout: icon('<circle cx="24" cy="20" r="9"/><path d="M24 42V29"/><path d="M30 14l8-8"/><path d="M31 6h7v7"/>'),
  arrive: icon('<path d="M14 44V6"/><path d="M14 8h20l-5 7 5 7H14"/>'),
};
const SPEAKER = '<svg viewBox="0 0 48 48" width="26" height="26" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 18h8l10-8v28l-10-8H8z"/><path d="M33 18q4 6 0 12"/><path d="M38 13q8 11 0 22"/></g></svg>';
const MUTED = '<svg viewBox="0 0 48 48" width="26" height="26" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 18h8l10-8v28l-10-8H8z"/><path d="M34 19l10 10M44 19L34 29"/></g></svg>';
// Seen from above, front at the top, so it can turn with the road.
const CAR = '<svg viewBox="0 0 32 48" width="36" height="54" aria-hidden="true"><rect x="5" y="3" width="22" height="42" rx="8" fill="#ffffff" stroke="#0f1d45" stroke-width="2.5"/><rect x="8.5" y="13" width="15" height="8" rx="2.5" fill="#0f1d45"/><rect x="8.5" y="31" width="15" height="6" rx="2" fill="#0f1d45"/><rect x="7.5" y="4.5" width="5" height="3" rx="1.5" fill="#f5b400"/><rect x="19.5" y="4.5" width="5" height="3" rx="1.5" fill="#f5b400"/></svg>';

// ---------- the screen ----------

let deps; // esc, toast, school, device, db, keepAwake (from app.js, through routes.js)
let dv = null; // the drive on screen

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function show(id, on) {
  const el = $(id);
  if (el && el.hidden === on) el.hidden = !on;
}

// opts: { route, mode, deps, loadMapLib, mapStyle, onClose }. mode is new | saved | test | student.
export function startDrive(opts) {
  if (dv) return;
  deps = opts.deps;
  const { route } = opts;
  const line = route.line.map(([lat, lon]) => ({ lat, lon }));
  if (line.length < 2) {
    deps.toast("This route can't be driven here. Use Google Maps.");
    return;
  }
  const shape = { line, cum: cumulative(line) };
  const guide = route.guide || guideFromLine(shape);
  const base = makePath(line, guide, []);
  base.marks = makeMarks(route, base);
  dv = {
    route, opts, guide, base, path: base, pathId: 0, s: 0, started: false, ready: false, off: false, offSince: 0,
    fix: null, said: new Set(), muted: false, follow: true, shown: null, shownS: null, map: null, car: null,
    canReroute: opts.mode !== 'student' && deps.device().status === 'approved',
    reroutes: 0, lastReroute: -Infinity, rerouting: false, driven: 0, startedAt: 0, endArmed: 0,
    speed: route.seconds > 0 ? route.meters / route.seconds : 11, // the route's own average, for time left
  };
  const el = document.createElement('div');
  el.className = 'dv';
  el.id = 'dv';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Driving directions');
  el.innerHTML = screen(route, !route.guide, opts.mode === 'student');
  document.body.append(el);
  document.documentElement.classList.add('dv-open');
  // Android's back button ends the drive instead of leaving the route.
  history.pushState({ drive: true }, '');
  addEventListener('popstate', onPop);
  addEventListener('resize', setPadding);
  document.addEventListener('visibilitychange', onVisible);
  deps.db.getMeta('driveMuted').then((m) => { if (dv && m) setMuted(true, false); }).catch(() => {});
  setupMap();
}

function screen(route, noNames, student) {
  const esc = deps.esc;
  const name = route.name || 'Practice route';
  const warn = student
    ? 'Drive with a licensed adult in the front seat. Road signs and signals come first: the map can be out of date.'
    : 'Set it up before you move. Road signs and signals come first: the map can be out of date.';
  return `
    <div id="dv-map" class="dv-map"></div>
    <div class="dv-top" id="dv-top" hidden>
      <div class="dv-banner" id="dv-banner">
        <span class="dv-arrow" id="dv-arrow">${ARROWS.depart}</span>
        <div class="dv-next"><p class="dv-dist" id="dv-dist"></p><p class="dv-what" id="dv-what">Getting your location…</p></div>
      </div>
      <p class="dv-then" id="dv-then" hidden></p>
      <p class="dv-note" id="dv-note" hidden></p>
      <div class="dv-links" id="dv-links" hidden>
        <a class="btn btn-small" id="dv-google" target="_blank" rel="noopener">Google Maps to the start</a>
        ${deps.platform() !== 'android' ? '<a class="btn btn-small" id="dv-apple" target="_blank" rel="noopener">Apple Maps</a>' : ''}
      </div>
    </div>
    <button type="button" class="btn btn-small dv-recenter" id="dv-recenter" data-action="dv-recenter" hidden>Re-center</button>
    <section class="card dv-sheet" id="dv-sheet">
      <h2 class="card-title">${esc(name)}</h2>
      <p>Voice directions for every turn, start to finish, with no stops along the way. Mute is at the bottom left.</p>
      <p class="hint">Keep KS Glovebox open on screen with the phone in its mount: directions pause if the phone locks or you switch apps. ${noNames ? 'This route was saved before Drive mode, so the directions won\'t name the streets. ' : ''}${esc(warn)}</p>
      <div class="two"><button type="button" class="btn" data-action="dv-cancel">Cancel</button><button type="button" class="btn btn-primary" data-action="dv-start">Start</button></div>
    </section>
    <div class="dv-bottom">
      <button type="button" class="dv-round" id="dv-mute" data-action="dv-mute" aria-pressed="false" aria-label="Mute the voice">${SPEAKER}</button>
      <div class="dv-left"><b id="dv-time">${esc(timeLabel(route.seconds || 0))}</b><span id="dv-miles">${esc((route.meters / 1609.34).toFixed(1))} mi</span></div>
      <button type="button" class="dv-end" id="dv-end" data-action="dv-end">End</button>
    </div>`;
}

async function setupMap() {
  const d = dv;
  let ml;
  try {
    ml = await d.opts.loadMapLib();
  } catch {
    if (dv === d) mapOff();
    return;
  }
  if (dv !== d) return;
  const bounds = new ml.LngLatBounds();
  d.base.line.forEach((p) => bounds.extend([p.lon, p.lat]));
  const map = new ml.Map({
    container: 'dv-map',
    style: d.opts.mapStyle,
    bounds,
    fitBoundsOptions: { padding: { top: 40, right: 30, left: 30, bottom: 300 } },
    attributionControl: { compact: true },
    pitchWithRotate: false,
  });
  d.map = map;
  map.setMissingStyleImageResolver((id) => {
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  map.on('error', () => {}); // a tile that fails mid-drive just stays blank; the directions carry on
  map.on('load', () => {
    const coords = d.base.line.map((p) => [p.lon, p.lat]);
    map.addSource('dv-all', { type: 'geojson', data: lineFeature(coords) });
    map.addSource('dv-ahead', { type: 'geojson', data: lineFeature(coords) });
    map.addLayer({ id: 'dv-all', type: 'line', source: 'dv-all', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f5b400', 'line-opacity': 0.3, 'line-width': 5 } });
    map.addLayer({ id: 'dv-ahead-edge', type: 'line', source: 'dv-ahead', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0a0f1d', 'line-width': 10 } });
    map.addLayer({ id: 'dv-ahead', type: 'line', source: 'dv-ahead', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f5b400', 'line-width': 6 } });
    updateAhead();
  });
  // Dragging or pinching the map stops it following the car until Re-center.
  const stopFollowing = (e) => {
    if (!e.originalEvent || !dv?.started) return;
    dv.follow = false;
    show('dv-recenter', true);
  };
  map.on('dragstart', stopFollowing);
  map.on('zoomstart', stopFollowing);
  const pinEl = document.createElement('div');
  pinEl.className = 'rt-pin rt-pin-start';
  pinEl.textContent = 'S';
  new ml.Marker({ element: pinEl }).setLngLat([d.route.start.lon, d.route.start.lat]).addTo(map);
  const carEl = document.createElement('div');
  carEl.className = 'dv-car';
  carEl.innerHTML = CAR;
  d.car = new ml.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([d.base.line[0].lon, d.base.line[0].lat]);
  setPadding();
}

const lineFeature = (coordinates) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coordinates.length > 1 ? coordinates : [...coordinates, ...coordinates] } });

function mapOff() {
  const el = $('dv-map');
  if (!el) return;
  el.classList.add('rt-map-off');
  el.textContent = "The map couldn't load. The voice and the next turn still work.";
}

// Keeps the car in the lower part of the screen, with the road ahead above it.
function setPadding() {
  if (!dv?.map) return;
  const h = $('dv-map')?.clientHeight || 700;
  dv.map.setPadding({ top: Math.round(h * 0.42), bottom: 90, left: 0, right: 0 });
}

function updateAhead() {
  const src = dv?.map?.getSource?.('dv-ahead');
  if (!src) return;
  const { path } = dv;
  const from = dv.started ? dv.s : 0;
  const first = pointAt(path, from);
  const rest = path.line.slice(indexAt(path.cum, from) + 1);
  src.setData(lineFeature([first, ...rest].map((p) => [p.lon, p.lat])));
}

// ---------- starting, GPS and the moving car ----------

function begin() {
  if (!dv || dv.ready) return;
  dv.ready = true;
  // Speech has to start from a tap on iPhones; a silent word now lets the directions talk later.
  if ('speechSynthesis' in window) {
    const hush = new SpeechSynthesisUtterance(' ');
    hush.volume = 0;
    speechSynthesis.speak(hush);
  }
  $('dv-sheet')?.remove();
  show('dv-top', true);
  deps.keepAwake('driving', true);
  if (!navigator.geolocation) {
    problem("This phone can't share its location here, so Drive mode can't follow the car. Use Google Maps instead.");
    return;
  }
  dv.watch = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  dv.raf = requestAnimationFrame(frame);
  dv.gpsTimer = setInterval(checkGps, 2000);
  dv.waitFrom = performance.now();
}

function onGpsError(err) {
  if (!dv) return;
  if (err.code === 1) problem("Location is turned off for this app. Allow it in the phone's settings (Privacy › Location), then tap End and start again.");
}

function problem(text) {
  show('dv-top', true);
  setText('dv-dist', '');
  setText('dv-what', text);
  $('dv-banner')?.classList.add('dv-warn');
}

function checkGps() {
  if (!dv) return;
  const stale = !dv.fix || performance.now() - dv.fix.t > 10000;
  if (!stale) return;
  if (!dv.fix && performance.now() - dv.waitFrom < 4000) return;
  setText('dv-dist', '');
  setText('dv-what', dv.started ? 'GPS signal lost. Keep following the road.' : 'Waiting for GPS… Step outside or move away from tall buildings.');
}

function onFix(pos) {
  if (!dv) return;
  const c = pos.coords;
  const p = { lat: c.latitude, lon: c.longitude };
  const now = performance.now();
  const last = dv.fix;
  const moved = last ? dist(last, p) : 0;
  let speed = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
  if (speed === null) speed = last ? moved / Math.max(0.5, (now - last.t) / 1000) : 0;
  // GPS heading is only good when moving; otherwise the way the car went since the last fix.
  let heading = Number.isFinite(c.heading) && speed > 2 ? c.heading : null;
  if (heading === null && last && moved > 4) heading = bearing(last, p);
  if (heading === null && last) heading = last.heading;
  if (dv.started && moved < 200) dv.driven += moved;
  dv.fix = { ...p, acc: c.accuracy || 30, speed, heading, t: now };
  track();
  if (!dv) return; // the drive finished
  banner();
  updateAhead();
}

function track() {
  const f = dv.fix;
  const path = dv.path;
  const heading = f.speed > 2 ? f.heading : null;
  const slack = ON_ROUTE_M + Math.min(25, Math.max(0, f.acc - 10));
  if (!dv.started) {
    // Starts as soon as the car is on the route, at the start or wherever it joins.
    const m = locate(path, f, 0, path.total - 150, heading);
    if (m && m.raw <= slack) {
      dv.started = true;
      dv.s = m.s;
      dv.startedAt = Date.now();
      show('dv-links', false);
      const first = path.turns.find((t) => t.s > dv.s + 3 && t.code !== 'depart');
      const depart = path.turns[0]?.code === 'depart' && dv.s < 40 ? path.turns[0] : null;
      say(`Starting the route. ${depart ? `${turnText(depart, true)}.` : ''}${first && first.s - dv.s < 300 ? ` Then ${lowerFirst(turnText(first, true))}.` : ''}`);
      if (first && first.s - dv.s < 300) dv.said.add(`${dv.pathId}:${Math.round(first.s)}e`);
    } else if (!dv.toldStart && dist(f, dv.route.start) > 300) {
      dv.toldStart = true;
      say('Head to the start of the route, the S pin on the map.');
    }
    return;
  }
  const look = Math.max(250, f.speed * 10);
  const m = locate(path, f, dv.s - 30, dv.s + look, heading);
  if (m && m.raw <= slack) {
    if (dv.off) backOn();
    dv.offSince = 0;
    if (m.s > dv.s) dv.s = m.s;
  } else {
    // Further along the route (the app was in the background, or a shortcut back onto it) counts too.
    const later = locate(path, f, dv.s - 150, path.total, heading);
    if (later && later.raw <= Math.min(slack, 30)) {
      dv.s = later.s;
      if (dv.off) backOn();
      dv.offSince = 0;
    } else if (dv.off) {
      if (dv.canReroute) reroute();
    } else {
      dv.offSince ||= performance.now();
      if (performance.now() - dv.offSince > OFF_ROUTE_MS && f.speed > 1) goOff();
    }
  }
  if (dv.s >= path.total - 25) finish();
  else if (!dv.off) announce();
}

function goOff() {
  dv.off = true;
  if (dv.canReroute) {
    say('Off route. Finding a way back.');
    reroute();
  } else {
    say('Off route. Head back to the yellow line.');
  }
}

function backOn() {
  dv.off = false;
  dv.offSince = 0;
  say('Back on the route.');
}

// A missed turn on an instructor's phone: the school server finds a way back to the route a little
// past where the car left it, and the rest of the route carries on from there.
async function reroute() {
  const d = dv;
  const now = performance.now();
  if (!d.canReroute || d.rerouting || d.reroutes >= MAX_REROUTES || now - d.lastReroute < REROUTE_GAP_MS) return;
  d.rerouting = true;
  d.lastReroute = now;
  d.reroutes += 1;
  banner();
  const f = d.fix;
  const { base } = d;
  const left = baseS(d.path, d.s);
  const joinS = base.total - left < 600 ? base.total - 1 : Math.min(left + 300, base.total - 1);
  const join = pointAt(base, joinS);
  try {
    const data = await deps.school('/route', {
      points: [[f.lat, f.lon], [join.lat, join.lon]],
      radiuses: [80, 40],
      bearings: [f.heading !== null && f.speed > 2 ? [f.heading, 60] : [], [headingAt(base, joinS), 60]],
      avoidFreeways: d.route.level === 'beginner',
    });
    const feature = data.features?.[0];
    if (dv !== d || !d.off || !feature) return;
    d.path = detour(d, feature, joinS);
    d.pathId += 1;
    d.s = 0;
    d.off = false;
    d.offSince = 0;
    const next = d.path.turns.find((t) => t.s > 3 && t.code !== 'depart');
    say(next ? `New route. ${next.s < 300 ? turnText(next, true) : `In ${spokenDistance(next.s)}, ${lowerFirst(turnText(next, true))}`}.` : 'New route.');
    if (next) d.said.add(`${d.pathId}:${Math.round(next.s)}e`); // it's said again as it comes up
    updateAhead();
    banner();
  } catch {
    if (dv === d && d.off && !d.toldBack) {
      d.toldBack = true;
      say('Head back to the yellow line.');
    }
  } finally {
    d.rerouting = false;
  }
}

function detour(d, feature, joinS) {
  const { base } = d;
  const way = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const wayGuide = makeGuide(feature).filter(([, code]) => code !== 'depart' && code !== 'arrive');
  const bi = Math.min(indexAt(base.cum, joinS) + 1, base.line.length - 1);
  const line = [...way, ...base.line.slice(bi)];
  const rest = d.guide.filter(([i]) => i >= bi).map(([i, ...more]) => [i - bi + way.length, ...more]);
  const path = makePath(line, [...wayGuide, ...rest], []);
  path.join = { at: path.cum[way.length], base: base.cum[bi] };
  const shift = path.join.at - path.join.base;
  path.marks = base.marks.filter((m) => m.from >= path.join.base).map((m) => ({ ...m, from: m.from + shift, to: m.to + shift }));
  return path;
}

// The next turn is said early (about 20 seconds ahead, by speed) and again as it comes up.
function announce() {
  const { path } = dv;
  const v = Math.max(dv.fix.speed, 8);
  const next = path.turns.find((t) => t.s > dv.s + 3 && t.code !== 'depart');
  if (next) {
    const d = next.s - dv.s;
    const key = `${dv.pathId}:${Math.round(next.s)}`;
    const soon = Math.min(110, Math.max(30, v * 4.5));
    const early = Math.min(800, Math.max(160, v * 22));
    if (next.code === 'arrive') {
      if (d <= early && d > soon + 60 && once(`${key}e`)) say(`In ${spokenDistance(d)}, you're back at the start.`);
    } else if (d <= soon) {
      if (once(`${key}n`)) {
        const then = path.turns.find((t) => t.s > next.s + 3 && t.s - next.s < 120 && t.code !== 'arrive');
        say(`${turnText(next, true)}${then ? `, then ${lowerFirst(turnText(then, true))}` : ''}.`);
        if (then) dv.said.add(`${dv.pathId}:${Math.round(then.s)}e`);
      }
    } else if (d <= early && d > soon + 50 && once(`${key}e`)) {
      say(`In ${spokenDistance(d)}, ${lowerFirst(turnText(next, true))}.`);
    }
  }
  path.marks.forEach((m, i) => {
    if (m.say && dv.s >= m.from && dv.s < m.to && once(`${dv.pathId}:m${i}`)) say(m.text);
  });
}

const once = (key) => {
  if (dv.said.has(key)) return false;
  dv.said.add(key);
  return true;
};

function say(text) {
  if (!dv || dv.muted || !text || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel(); // the newest direction wins over one still being read
  const u = new SpeechSynthesisUtterance(text.trim());
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

function setMuted(on, save) {
  if (!dv) return;
  dv.muted = on;
  const btn = $('dv-mute');
  if (btn) {
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Turn the voice back on' : 'Mute the voice');
    btn.innerHTML = on ? MUTED : SPEAKER;
  }
  if (on && 'speechSynthesis' in window) speechSynthesis.cancel();
  if (save) {
    deps.db.setMeta('driveMuted', on).catch(() => {});
    deps.toast(on ? 'Voice off. The banner still shows every turn.' : 'Voice on');
    if (!on && dv.started) say('Voice on.');
  }
}

// The banner: the next turn and how far, or where to head when off the route or not there yet.
function banner() {
  const f = dv.fix;
  const { path } = dv;
  const bannerEl = $('dv-banner');
  bannerEl?.classList.remove('dv-warn');
  const arrow = (kind, angle = null) => {
    const el = $('dv-arrow');
    if (!el) return;
    if (el.dataset.kind !== kind) {
      el.dataset.kind = kind;
      el.innerHTML = ARROWS[kind] || ARROWS.depart;
    }
    const svg = el.firstElementChild;
    if (svg) svg.style.transform = angle === null ? '' : `rotate(${Math.round(angle)}deg)`;
  };
  const facing = dv.shown?.heading ?? f.heading ?? 0;
  bannerEl?.classList.toggle('dv-off', dv.off);
  if (!dv.started) {
    const start = dv.route.start;
    arrow('back', turnAngle(facing, bearing(f, start)));
    setText('dv-dist', shownDistance(dist(f, start)));
    setText('dv-what', 'Head to the start (the S pin). Directions begin when you reach the route.');
    show('dv-then', false);
    show('dv-note', false);
    const g = $('dv-google');
    if (g && !g.href) {
      const at = `${start.lat.toFixed(5)},${start.lon.toFixed(5)}`;
      g.href = `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination: at, travelmode: 'driving', dir_action: 'navigate' })}`;
      const a = $('dv-apple');
      if (a) a.href = `https://maps.apple.com/directions?destination=${at}&mode=driving`;
    }
    show('dv-links', dist(f, start) > 300);
    timeLeft(path.total);
    return;
  }
  if (dv.off) {
    const back = locate(path, f, dv.s - 150, path.total, null);
    const target = back ? pointAt(path, back.s) : pointAt(path, dv.s);
    arrow('back', turnAngle(facing, bearing(f, target)));
    setText('dv-dist', dv.rerouting ? '' : shownDistance(dist(f, target)));
    setText('dv-what', dv.rerouting ? 'Off route. Finding a way back…' : 'Off route. Head back to the yellow line.');
    show('dv-then', false);
    show('dv-note', false);
    timeLeft(path.total - dv.s);
    return;
  }
  const next = path.turns.find((t) => t.s > dv.s + 3 && (t.code !== 'depart' || dv.s < 30)) || path.turns.at(-1);
  arrow(next.code);
  setText('dv-dist', shownDistance(Math.max(0, next.s - dv.s)));
  setText('dv-what', turnText(next, false));
  const then = path.turns.find((t) => t.s > next.s + 3 && t.s - next.s < 150);
  show('dv-then', !!then);
  if (then) setText('dv-then', `Then ${lowerFirst(turnText(then, false))}`);
  const mark = path.marks.find((m) => dv.s >= m.from && dv.s < m.to);
  show('dv-note', !!mark);
  if (mark) setText('dv-note', mark.text);
  timeLeft(path.total - dv.s);
}

function timeLeft(meters) {
  const secs = Math.max(0, meters) / dv.speed;
  const at = new Date(Date.now() + secs * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  setText('dv-time', timeLabel(secs));
  setText('dv-miles', `${(Math.max(0, meters) / 1609.34).toFixed(1)} mi · back ${at}`);
}

// Every frame: the car glides along the road between GPS fixes (about one a second), at the speed
// the GPS gave, and the map turns with it.
function frame(now) {
  if (!dv) return;
  dv.raf = requestAnimationFrame(frame);
  const f = dv.fix;
  if (!dv.map || !dv.car || !f) return;
  const dt = Math.min(0.25, (now - (dv.lastFrame ?? now)) / 1000);
  dv.lastFrame = now;
  let target;
  const onRoute = dv.started && !dv.off;
  if (onRoute) {
    const want = Math.min(dv.s + f.speed * Math.min(1.5, (now - f.t) / 1000), dv.path.total);
    dv.shownS = dv.shownS === null ? want : dv.shownS + (want - dv.shownS) * Math.min(1, dt * 4);
    target = { ...pointAt(dv.path, dv.shownS), heading: headingAt(dv.path, dv.shownS) };
  } else {
    dv.shownS = null;
    target = { lat: f.lat, lon: f.lon, heading: f.heading ?? dv.shown?.heading ?? 0 };
  }
  if (!dv.shown) {
    dv.shown = { ...target, zoom: 16 };
    dv.car.addTo(dv.map);
  }
  const sh = dv.shown;
  const k = onRoute ? 1 : Math.min(1, dt * 5);
  sh.lat += (target.lat - sh.lat) * k;
  sh.lon += (target.lon - sh.lon) * k;
  sh.heading = (sh.heading + turnAngle(sh.heading, target.heading) * Math.min(1, dt * 3) + 360) % 360;
  const zoom = dv.started ? 17.3 - Math.min(1, Math.max(0, (f.speed - 12) / 14)) * 1.6 : 15.5;
  sh.zoom += (zoom - sh.zoom) * Math.min(1, dt * 1.5);
  dv.car.setLngLat([sh.lon, sh.lat]).setRotation(sh.heading);
  if (!dv.follow) return;
  // Nothing to redraw while the car sits at a light.
  const cam = dv.cam;
  if (cam && Math.abs(cam.lat - sh.lat) < 1e-7 && Math.abs(cam.lon - sh.lon) < 1e-7 && Math.abs(turnAngle(cam.heading, sh.heading)) < 0.05 && Math.abs(cam.zoom - sh.zoom) < 0.002) return;
  dv.cam = { ...sh };
  dv.map.jumpTo({ center: [sh.lon, sh.lat], bearing: sh.heading, zoom: sh.zoom, pitch: 50 });
}

function finish() {
  const d = dv;
  stopWatching(d);
  const mins = Math.max(1, Math.round((Date.now() - d.startedAt) / 60000));
  say("You're back at the start. Route complete.");
  show('dv-top', false);
  show('dv-recenter', false);
  setText('dv-time', '');
  setText('dv-miles', '');
  const sheet = document.createElement('section');
  sheet.className = 'card dv-sheet';
  sheet.innerHTML = `<h2 class="card-title">Route complete</h2>
    <p>${deps.esc(timeLabel(mins * 60))} · ${deps.esc((d.driven / 1609.34).toFixed(1))} mi driven</p>
    <button type="button" class="btn btn-primary btn-block" data-action="dv-done">Done</button>`;
  $('dv')?.append(sheet);
  d.finished = true;
}

function stopWatching(d) {
  if (d.watch !== undefined) navigator.geolocation.clearWatch(d.watch);
  d.watch = undefined;
  clearInterval(d.gpsTimer);
  deps.keepAwake('driving', false);
}

function close(fromBack) {
  const d = dv;
  if (!d) return;
  dv = null;
  stopWatching(d);
  cancelAnimationFrame(d.raf);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  d.map?.remove();
  $('dv')?.remove();
  document.documentElement.classList.remove('dv-open');
  removeEventListener('popstate', onPop);
  removeEventListener('resize', setPadding);
  document.removeEventListener('visibilitychange', onVisible);
  if (!fromBack) history.back(); // takes off the entry added on the way in
  d.opts.onClose?.();
}

const onPop = () => close(true);

// iPhones can leave speech stuck after the app was in the background.
function onVisible() {
  if (document.visibilityState === 'visible' && 'speechSynthesis' in window) speechSynthesis.cancel();
}

// End needs a second tap, so a bump on the screen doesn't stop the directions.
function endTap(el) {
  if (!dv) return;
  if (!dv.started || dv.finished || Date.now() - dv.endArmed < 3000) {
    close(false);
    return;
  }
  dv.endArmed = Date.now();
  el.textContent = 'Tap to end';
  el.classList.add('armed');
  setTimeout(() => {
    if (!el.isConnected) return;
    el.textContent = 'End';
    el.classList.remove('armed');
  }, 3000);
}

export const driveActions = {
  'dv-start': () => begin(),
  'dv-cancel': () => close(false),
  'dv-done': () => close(false),
  'dv-end': (el) => endTap(el),
  'dv-mute': () => setMuted(!dv?.muted, true),
  'dv-recenter': () => {
    if (!dv) return;
    dv.follow = true;
    dv.cam = null;
    show('dv-recenter', false);
  },
};
