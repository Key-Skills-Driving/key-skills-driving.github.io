// Routes tab: a practice-route maker. Pick a start (the office, or Here from the phone's GPS), a length,
// the student's level and the skills to practice; it builds a loop that leaves from the start, passes
// real spots for those skills and comes back, sized to the time. Drive it hands the loop to Google Maps
// or Apple Maps for voice directions. Everything is set up before the car moves.
//
// The spots come from OpenStreetMap, prepared ahead of time by tools/route-spots into docs/route-spots/
// (one small file per area, cached by the service worker), so a build only waits on the road route.
// That comes from OpenRouteService through the school server, which holds the key.

// 6909 W Ray Rd, Chandler. Test-ready loops lean toward here, where road tests happen.
const OFFICE = { lat: 33.31922, lon: -111.96155 };
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const LENGTHS = [[30, '30 min'], [45, '45 min'], [60, '1 hr'], [90, '1½ hr'], [120, '2 hr'], [150, '2½ hr']];
const LEVELS = [['beginner', 'Beginner'], ['building', 'Building'], ['test', 'Test-ready']];
const SKILLS = [
  ['lt', 'Lefts at lights'],
  ['ul', 'Unprotected lefts'],
  ['rb', 'Roundabouts'],
  ['sz', 'School zones'],
  ['ml', 'Lane changes'],
  ['fw', 'Freeway merging'],
  ['rr', 'Railroad crossings'],
  ['qs', 'Quiet streets'],
  ['pl', 'Parking lots'],
];
const MAX_STOPS = 9; // the most Google Maps takes from a link
const MAX_TURNS = 38; // a typed-in test route: the route request takes 40 points, start and finish included
const TOLERANCE_MIN = 5; // a route counts as fitting the lesson within this many minutes
const MAX_TRIES = 4; // route requests per build; the school's free key allows 200 a day for everyone
const SNAP_M = 35; // a spot counts as passed when the route goes within this many meters of it

let deps; // what app.js shares: app, header, backLink, tabbar, esc, toast, copyText, school, db, go, platform, device, appUrl
const rs = {
  start: 'office',
  minutes: 60,
  level: 'building',
  skills: new Set(['lt', 'rb', 'ml']),
  route: null, // the one just built (not saved until Save is tapped)
  saved: [],
  loaded: false,
  tests: [], // the school's test routes, shared by every phone (a copy stays on the phone for no-signal days)
  testsLoaded: false,
  testsFetched: 0,
  view: null, // { route, mode } on screen; mode is new | saved | test | student
  building: null, // { status, controller } while a build runs
  naming: null, // the name box is open: 'save' (on this phone) or 'test' (for the school)
  turnsText: '', // a test route typed in as turns, kept while you go back and fix a line
  turnsStart: 'office',
};

export function setupRoutes(shared) {
  deps = shared;
}

// ---------- small helpers ----------

const esc = (v) => deps.esc(v);
const rad = (d) => (d * Math.PI) / 180;

function dist(a, b) {
  const kx = 111320 * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * kx);
}

function bearing(a, b) {
  return ((Math.atan2((b.lon - a.lon) * Math.cos(rad(a.lat)), b.lat - a.lat) * 180) / Math.PI + 360) % 360;
}

function offset(p, meters, deg) {
  return { lat: p.lat + (meters * Math.cos(rad(deg))) / 111320, lon: p.lon + (meters * Math.sin(rad(deg))) / (111320 * Math.cos(rad(p.lat))) };
}

// Same seed, same route, so Shuffle is the only thing that changes it.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const minutesLabel = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`);
const miles = (meters) => (meters / 1609.34).toFixed(1);
const lengthLabel = (m) => LENGTHS.find(([v]) => v === m)?.[1] || minutesLabel(m);
const levelLabel = (id) => LEVELS.find(([v]) => v === id)?.[1] || '';

// Google's polyline format keeps saved routes small.
function encodeLine(points) {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const put = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lon * 1e5);
    put(a - pLat);
    put(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

function decodeLine(str) {
  const pts = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const take = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += take();
    lon += take();
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

// ---------- spots ----------

let spotIndex = null;
const spotCells = new Map();

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the map spots (${res.status}). Check your signal and try again.`);
  return res.json();
}

const cellKey = (lat, lon) => `${(Math.floor(lat * 10 + 1e-9) / 10).toFixed(2)}_${(Math.floor(lon * 10 + 1e-9) / 10).toFixed(2)}`;

const turnLabel = (what, from, to) => `${what}${from && to ? `: ${from} onto ${to}` : to ? ` onto ${to}` : from ? ` from ${from}` : ''}`;

// The route service's names are long ("East Chandler Boulevard"); say them the way the spots do.
const SUFFIX = { Street: 'St', Road: 'Rd', Avenue: 'Ave', Boulevard: 'Blvd', Drive: 'Dr', Parkway: 'Pkwy', Lane: 'Ln', Place: 'Pl', Court: 'Ct', Circle: 'Cir', Trail: 'Trl' };
function shortName(name) {
  if (!name || name === '-') return '';
  const words = name.split(' ');
  if (words.length > 1 && /^(North|South|East|West|[NSEW])$/.test(words[0])) words.shift();
  if (words.length > 1 && SUFFIX[words.at(-1)]) words[words.length - 1] = SUFFIX[words.at(-1)];
  return words.join(' ');
}

// Turns the compact arrays from tools/route-spots into stops with labels, the points the route must go
// through (via), and the points handed to Google or Apple Maps (drive).
function toSpot(kind, a) {
  const P = (lat, lon) => ({ lat, lon });
  switch (kind) {
    case 'lt':
    case 'ul': {
      const at = P(a[0], a[1]);
      const approach = P(a[2], a[3]);
      const exit = P(a[4], a[5]);
      const what = kind === 'lt' ? 'Left at the light' : 'Unprotected left';
      // Heading toward the light at the first point and away from it at the second, so the router
      // can't pass them the other way round and loop the block instead of turning.
      return {
        kind, at, via: [approach, exit], heading: [[bearing(approach, at), 45], [bearing(at, exit), 45]], drive: [exit],
        what, from: a[6], to: a[7], label: turnLabel(what, a[6], a[7]),
      };
    }
    case 'rb': {
      const at = P(a[0], a[1]);
      const approach = P(a[2], a[3]);
      return { kind, at, via: [approach], heading: [[bearing(approach, at), 60]], drive: [approach], label: `Roundabout${a[4] ? ` from ${a[4]}` : ''}` };
    }
    case 'sz': return { kind, at: P(a[0], a[1]), via: [P(a[0], a[1])], drive: [P(a[0], a[1])], label: `School zone: ${a[2]}${a[3] ? `, ${a[3]}` : ''}` };
    case 'ml': {
      const from = P(a[0], a[1]);
      const to = P(a[2], a[3]);
      const way = bearing(from, to);
      return {
        kind, at: from, via: [from, to], heading: [[way, 70], [way, 70]], drive: [to], meters: a[6],
        label: `Lane changes: ${a[4]}, ${miles(a[6])} mi with ${a[5]} lanes each way`,
      };
    }
    case 'fw': return { kind, at: P(a[0], a[1]), via: [P(a[0], a[1])], drive: [P(a[0], a[1])], label: `Freeway merge${a[2] ? ` onto ${a[2]}` : ''}${a[3] ? ` from ${a[3]}` : ''}` };
    case 'rr': return { kind, at: P(a[0], a[1]), via: [P(a[0], a[1])], drive: [P(a[0], a[1])], label: `${a[3] === 'light' ? 'Light rail' : 'Railroad'} crossing${a[2] ? `: ${a[2]}` : ''}` };
    case 'qs': return { kind, at: P(a[0], a[1]), via: [P(a[0], a[1])], drive: [P(a[0], a[1])], label: `Quiet streets: ${a[2]}` };
    case 'pl': return { kind, at: P(a[0], a[1]), via: [P(a[0], a[1])], drive: [P(a[0], a[1])], label: `Parking lot${a[2] ? `: ${a[2]}` : a[3] ? ` off ${a[3]}` : ''}` };
    default: return null;
  }
}

// Loads every cell the loop could reach. Cells outside the school's map area just aren't there.
async function spotsAround(center, meters) {
  if (!spotIndex) spotIndex = await getJson('route-spots/index.json');
  const have = new Set(spotIndex.cells);
  const corner1 = offset(offset(center, meters, 0), meters, 270);
  const corner2 = offset(offset(center, meters, 180), meters, 90);
  const keys = [];
  for (let lat = Math.floor(corner2.lat * 10); lat <= Math.floor(corner1.lat * 10); lat++) {
    for (let lon = Math.floor(corner1.lon * 10); lon <= Math.floor(corner2.lon * 10); lon++) {
      const key = cellKey(lat / 10 + 0.00001, lon / 10 + 0.00001);
      if (have.has(key)) keys.push(key);
    }
  }
  await Promise.all(keys.filter((k) => !spotCells.has(k)).map(async (k) => {
    const raw = await getJson(`route-spots/${k}.json`);
    const cell = {};
    for (const [kind, list] of Object.entries(raw)) cell[kind] = list.map((a) => toSpot(kind, a)).filter(Boolean);
    spotCells.set(k, cell);
  }));
  const all = {};
  for (const k of keys) {
    for (const [kind, list] of Object.entries(spotCells.get(k))) (all[kind] ||= []).push(...list);
  }
  return all;
}

// ---------- planning a loop ----------

// More time, more stops (each stop is one skill), up to what a Maps link can carry.
const stopCount = (minutes) => Math.min(MAX_STOPS, Math.max(3, Math.round(minutes / 15) + 1));
// A first guess at the loop's size; the build then scales it until the drive time fits.
const loopRadius = (minutes) => minutes * 0.0735 * 1000;

// Lays the stops around a circle that passes through the start, so the route leaves, goes round
// and comes back without doubling over itself. Each slot on the circle gets one skill, in turn.
function planStops({ start, minutes, level, skills, rand, scale, spots, excluded }) {
  const radius = loopRadius(minutes) * scale;
  const n = stopCount(minutes);
  const toOffice = dist(start, OFFICE);
  // Test-ready loops head toward the office area, where road tests happen.
  const heading = level === 'test' && toOffice > 3000 ? bearing(start, OFFICE) : rand() * 360;
  const middle = offset(start, radius, heading);
  const clockwise = rand() < 0.5 ? 1 : -1;
  const kinds = skills.filter((k) => !(level === 'beginner' && k === 'fw') && spots[k]?.length);
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  const chosen = [];
  // Each spot's bit of randomness depends only on the seed and where it is, so resizing the loop
  // doesn't reshuffle which spots win.
  const salt = rand() * 1000;
  const jitter = (s) => {
    const x = Math.sin(s.at.lat * 12.9898 + s.at.lon * 78.233 + salt) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let slot = 0; slot < n && kinds.length; slot++) {
    const angle = heading + 180 + clockwise * ((slot + 1) * 360) / (n + 1);
    const target = offset(middle, radius, angle);
    let pick = null;
    for (let t = 0; t < kinds.length && !pick; t++) {
      const kind = kinds[(slot + t) % kinds.length];
      let best = null;
      (spots[kind] || []).forEach((s) => {
        if (excluded.has(s.via[0].lat + ',' + s.via[0].lon)) return;
        if (chosen.some((c) => dist(c.at, s.at) < 500)) return;
        const d = dist(s.at, target);
        if (d > radius * 0.8 + 1500) return;
        let score = d + jitter(s) * (radius * 0.35 + 400);
        if (level === 'test') score += dist(s.at, OFFICE) * 0.25;
        if (!best || score < best.score) best = { score, s };
      });
      if (best) pick = best.s;
    }
    if (pick) chosen.push(pick);
  }
  return { stops: chosen };
}

// ---------- the road route ----------

async function fetchRoute(start, stops, startRadius, avoidFreeways, signal) {
  const points = [start];
  const owner = [-1];
  stops.forEach((s, i) => s.via.forEach((p) => { points.push(p); owner.push(i); }));
  points.push(start);
  owner.push(-1);
  const radiuses = points.map((_, i) => (owner[i] === -1 ? startRadius : 40));
  const bearings = [[]];
  stops.forEach((s) => s.via.forEach((_, k) => bearings.push(s.heading?.[k] || [])));
  bearings.push([]);
  try {
    const data = await deps.school('/route', { points: points.map((p) => [p.lat, p.lon]), radiuses, bearings, avoidFreeways }, { signal });
    return { data, points, owner };
  } catch (err) {
    // The route service says which point it couldn't reach; swap that spot out and try again.
    const m = /coordinate (\d+)/i.exec(err.message || '');
    if (m && owner[Number(m[1])] >= 0) return { unreachable: stops[owner[Number(m[1])]] };
    if (m) throw new Error("Couldn't reach a road from the start point. Try the office, or step outside so GPS is better.");
    throw err;
  }
}

// Checks the route really does what each stop says: turns left at that light, goes through that
// roundabout, drives that stretch, passes that spot. A stop that fails is swapped out, never claimed.
function checkStops(stops, points, owner, feature) {
  const line = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const wayPoints = feature.properties.way_points;
  const segments = feature.properties.segments;
  const snapped = (i) => dist(line[wayPoints[i]], points[i]) <= SNAP_M;
  const stepAt = (step) => line[step.way_points[0]];
  return stops.map((s, si) => {
    const first = owner.indexOf(si);
    if (!s.via.every((_, k) => snapped(first + k))) return false;
    const seg = segments[first];
    switch (s.kind) {
      case 'lt':
      case 'ul': return seg.steps.some((st) => [0, 2, 4].includes(st.type) && dist(stepAt(st), s.at) < 80);
      case 'rb': return seg.steps.some((st) => st.type === 7 && dist(stepAt(st), s.at) < 150);
      case 'ml': return seg.distance <= s.meters * 1.3 + 150;
      default: return true;
    }
  });
}

function stopsFromRoute(stops, feature) {
  return {
    line: feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    seconds: feature.properties.summary.duration,
    meters: feature.properties.summary.distance,
    stops: stops.map((s) => ({ kind: s.kind, label: s.label, at: s.at, drive: s.drive })),
  };
}

// Plans, asks for the route, checks it, and resizes the loop until the drive time fits the lesson.
async function buildRoute(settings, seed, signal, onStatus) {
  const { start, minutes, level } = settings;
  const skills = [...settings.skills];
  const avoidFreeways = level === 'beginner';
  const startRadius = settings.startKind === 'here' ? 300 : 150;
  const excluded = new Set();
  const target = minutes * 60;
  let scale = 1;
  let best = null;
  let missing = [];
  onStatus('Finding practice spots…');
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const spots = await spotsAround(start, loopRadius(minutes) * Math.min(scale, 2.2) * 2 + 2500);
    if (!Object.keys(spots).length) throw new Error("That start is outside the area the app has map spots for (Phoenix to Queen Creek). Start from the office, or ask Eli to widen it.");
    const plan = planStops({ start, minutes, level, skills, rand: seeded(seed), scale, spots, excluded });
    if (!plan.stops.length) throw new Error('No spots for those skills near this start. Try more skills or a longer lesson.');
    onStatus(`Checking the route (try ${attempt} of ${MAX_TRIES})…`);
    const got = await fetchRoute(start, plan.stops, startRadius, avoidFreeways, signal);
    if (got.unreachable) {
      excluded.add(got.unreachable.via[0].lat + ',' + got.unreachable.via[0].lon);
      continue;
    }
    const feature = got.data.features?.[0];
    if (!feature) throw new Error("The route service didn't send a route back. Try again.");
    // A stop the route didn't really do (say it went straight instead of turning) is never claimed:
    // it's dropped from the list and from what goes to Maps, and swapped out on the next try.
    const ok = checkStops(plan.stops, got.points, got.owner, feature);
    const failed = ok.filter((x) => !x).length;
    // Turns with an unnamed street in the map data take their names from the route's own directions.
    const line = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
    const labeled = plan.stops.map((s, i) => {
      if (!s.what || (s.from && s.to)) return s;
      const seg = feature.properties.segments[got.owner.indexOf(i)];
      const turn = seg?.steps.find((st) => [0, 2, 4].includes(st.type) && dist(line[st.way_points[0]], s.at) < 80);
      return { ...s, label: turnLabel(s.what, s.from || shortName(seg?.steps[0]?.name), s.to || shortName(turn?.name)) };
    });
    plan.stops.forEach((s, i) => { if (!ok[i]) excluded.add(s.via[0].lat + ',' + s.via[0].lon); });
    const secs = feature.properties.summary.duration;
    const off = Math.abs(secs - target);
    const score = off + failed * 600; // a missed skill counts like being 10 minutes off
    if (!best || score < best.score) {
      const kept = labeled.filter((_, i) => ok[i]);
      best = { score, route: stopsFromRoute(kept, feature) };
      missing = skills.filter((k) => !kept.some((s) => s.kind === k));
    }
    if (!failed && off <= TOLERANCE_MIN * 60) break;
    scale *= Math.min(1.9, Math.max(0.5, target / secs));
  }
  if (!best || !best.route.stops.length) throw new Error("Couldn't make a route that passes those spots. Try Shuffle, or other skills.");
  return { ...best.route, missing };
}

// ---------- a test route typed in as turns ----------
// An admin pastes the school's test route as a list of turns ("Right on Ray Rd", "Left on Kyrene Rd", …).
// Each turn happens where the street you're on meets the next one, so the app finds those crossings
// (each the nearest one to the last, starting from the start), asks for the road route through them,
// and checks every turn goes the way its line says. Lines with no street ("Parallel park") become notes.

const SUFFIXES = {
  street: 'st', st: 'st', road: 'rd', rd: 'rd', avenue: 'ave', ave: 'ave', av: 'ave', boulevard: 'blvd', blvd: 'blvd',
  drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', parkway: 'pkwy', pkwy: 'pkwy', place: 'pl', pl: 'pl', court: 'ct', ct: 'ct',
  circle: 'cir', cir: 'cir', way: 'way', trail: 'trl', trl: 'trl', highway: 'hwy', hwy: 'hwy', terrace: 'ter', ter: 'ter', loop: 'loop',
};

// "S. Kyrene Road" and "Kyrene Rd" are the same street; "Kyrene" alone matches either.
function streetKey(name) {
  const words = String(name || '').toLowerCase().replace(/[.,']/g, ' ').split(/\s+/).filter((w) => w && w !== 'the');
  if (words.length > 1 && /^(n|s|e|w|north|south|east|west)$/.test(words[0])) words.shift();
  const last = words.at(-1);
  const suffix = words.length > 1 && SUFFIXES[last] ? SUFFIXES[last] : '';
  if (suffix) words[words.length - 1] = suffix;
  return { full: words.join(' '), base: suffix ? words.slice(0, -1).join(' ') : words.join(' '), suffix };
}

const sameStreet = (typed, mapped) => (typed.suffix ? typed.full === mapped.full : typed.base === mapped.base);

// One turn per line. "3. Turn left at the light onto Kyrene Rd heading south" -> left, Kyrene Rd.
export function parseTurns(text) {
  const turns = [];
  const startNotes = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s*(\d+\s*[.):-]|[-*•])\s*/, '').trim();
    if (!line) return;
    const dir = (line.match(/\b(left|right|u-?turn|straight|continue)\b/i)?.[1] || '').toLowerCase().replace('-', '');
    let street = line.match(/\b(?:onto|on to|on)\s+(?:the\s+)?([0-9A-Za-z][\w .'-]*?)(?=\s*(?:[,.;(]|\b(?:and|then|until|for|toward|towards|heading|going|at|to|past|after)\b|$))/i)?.[1]?.trim();
    // "Parallel park on the right" names a side, not a street.
    if (street && /^(right|left|right side|left side|light|corner|curb|shoulder|street|road)$/i.test(street)) street = '';
    const key = street && streetKey(street);
    const prev = turns.at(-1);
    // A line on the street you're already on ("Lane change on Ray Rd") is a note, not a turn.
    if (street && !(prev && key.base === prev.key.base)) {
      turns.push({ line: i + 1, text: line, dir: dir === 'continue' ? 'straight' : dir, street, key, notes: [] });
    } else if (prev) prev.notes.push(line);
    else startNotes.push(line);
  });
  return { turns, startNotes };
}

const streetCells = new Map();

async function crossingsAround(center, meters) {
  if (!spotIndex) spotIndex = await getJson('route-spots/index.json');
  const have = new Set(spotIndex.cells);
  const north = offset(center, meters, 0).lat;
  const south = offset(center, meters, 180).lat;
  const east = offset(center, meters, 90).lon;
  const west = offset(center, meters, 270).lon;
  const keys = [];
  for (let lat = Math.floor(south * 10); lat <= Math.floor(north * 10); lat++) {
    for (let lon = Math.floor(west * 10); lon <= Math.floor(east * 10); lon++) {
      const key = cellKey(lat / 10 + 0.00001, lon / 10 + 0.00001);
      if (have.has(key)) keys.push(key);
    }
  }
  await Promise.all(keys.filter((k) => !streetCells.has(k)).map(async (k) => {
    const { n, j } = await getJson(`route-spots/streets/${k}.json`);
    const named = n.map((name) => ({ name, key: streetKey(name) }));
    streetCells.set(k, j.map(([a, b, lat, lon]) => ({ a: named[a], b: named[b], at: { lat, lon } })));
  }));
  return keys.flatMap((k) => streetCells.get(k));
}

// Turns a line bearing difference into what a driver would call it.
function turnWay(before, at, after) {
  const angle = turnAngle(bearing(before, at), bearing(at, after));
  return angle < -35 ? 'left' : angle > 35 ? 'right' : 'straight';
}
const turnAngle = (hIn, hOut) => ((hOut - hIn + 540) % 360) - 180;

// The point `meters` along the route line from index i, forward (+1) or back (-1).
function alongLine(line, i, meters, step) {
  let walked = 0;
  let k = i;
  while (k + step >= 0 && k + step < line.length && walked < meters) {
    walked += dist(line[k], line[k + step]);
    k += step;
  }
  return line[k];
}

async function buildFromTurns(text, startKind, signal, onStatus) {
  const { turns, startNotes } = parseTurns(text);
  if (turns.length < 2) throw new Error('Type at least two turns, one per line, like "Right on Ray Rd" then "Left on Kyrene Rd".');
  if (turns.length > MAX_TURNS + 1) throw new Error(`That's ${turns.length} turns; a route can take up to ${MAX_TURNS + 1}. Split it in two.`);
  onStatus(startKind === 'here' ? 'Finding where you are…' : 'Finding the streets…');
  const start = startKind === 'here' ? await hereNow() : OFFICE;
  const crossings = await crossingsAround(start, 15000);
  if (!crossings.length) throw new Error("That start is outside the area the app has streets for (Phoenix to Queen Creek).");
  // Each turn after the first happens where the previous street meets this one.
  const problems = [];
  const points = [];
  let from = start;
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i];
    const found = crossings.filter((c) => (sameStreet(prev.key, c.a.key) && sameStreet(cur.key, c.b.key)) || (sameStreet(prev.key, c.b.key) && sameStreet(cur.key, c.a.key)));
    if (!found.length) {
      problems.push(`Line ${cur.line}: couldn't find where ${prev.street} meets ${cur.street}. Check both spellings.`);
      continue;
    }
    const near = found.reduce((best, c) => (dist(c.at, from) < dist(best.at, from) ? c : best));
    if (dist(near.at, from) > 12000) problems.push(`Line ${cur.line}: the nearest place ${prev.street} meets ${cur.street} is ${miles(dist(near.at, from))} mi from the turn before. Check it on the map.`);
    cur.at = near.at;
    points.push(cur);
    from = near.at;
  }
  if (!points.length) throw new Error(problems[0]);
  // The router is aimed 40 m past each turn, already on the new street and heading toward the next
  // crossing. Aimed at the crossing itself, it may cut through a side road and arrive from the wrong way.
  const nextAt = (k) => points[k + 1]?.at || start;
  const vias = points.map((t, k) => offset(t.at, 40, bearing(t.at, nextAt(k))));
  const route = [start, ...vias, start];
  const bearings = route.map((p, i) => (i === 0 || i === route.length - 1 ? [] : [bearing(points[i - 1].at, nextAt(i - 1)), 60]));
  onStatus('Drawing the route…');
  let data;
  try {
    data = await deps.school('/route', { points: route.map((p) => [p.lat, p.lon]), radiuses: route.map((_, i) => (i === 0 || i === route.length - 1 ? 150 : 50)), bearings }, { signal });
  } catch (err) {
    const m = /coordinate (\d+)/i.exec(err.message || '');
    const t = m && points[Number(m[1]) - 1];
    throw new Error(t ? `Line ${t.line}: the route can't get through ${t.street} there. Check that turn.` : err.message);
  }
  const feature = data.features?.[0];
  if (!feature) throw new Error("The route service didn't send a route back. Try again.");
  const line = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const wp = feature.properties.way_points;
  // Check each turn against the line drawn: that it goes through the crossing, which way it turns
  // there, and that it then follows the new street.
  points.forEach((t, k) => {
    let corner = wp[k];
    for (let i = wp[k]; i <= wp[k + 1]; i++) if (dist(line[i], t.at) < dist(line[corner], t.at)) corner = i;
    if (dist(line[corner], t.at) > 60) {
      problems.push(`Line ${t.line}: the route doesn't go through where ${turns[turns.indexOf(t) - 1].street} meets ${t.street}. Check that turn on the map.`);
      return;
    }
    const way = turnWay(alongLine(line, corner, 40, -1), line[corner], alongLine(line, corner, 40, 1));
    if ((t.dir === 'left' || t.dir === 'right') && way !== t.dir) {
      problems.push(`Line ${t.line} says ${t.dir}, but the route goes ${way === 'straight' ? 'straight on' : way} there. Check the turn or the street before it.`);
    }
    const seg = feature.properties.segments[k + 1];
    const longest = seg?.steps.reduce((a, s) => (s.distance > (a?.distance || 0) ? s : a), null);
    if (longest && longest.name && longest.name !== '-' && !sameStreet(t.key, streetKey(longest.name))) {
      problems.push(`After line ${t.line} the route mostly uses ${shortName(longest.name)}, not ${t.street}.`);
    }
  });
  // Up to 9 of the turns go to Google or Apple Maps, spread out, each just past the turn so it's driven the right way.
  const picks = new Set(points.length <= MAX_STOPS ? points.map((_, k) => k) : Array.from({ length: MAX_STOPS }, (_, n) => Math.round((n * (points.length - 1)) / (MAX_STOPS - 1))));
  const noted = (t) => [t.text, ...t.notes].join(' · ');
  const stops = [
    { kind: 'turn', label: [...startNotes, noted(turns[0])].join(' · '), at: start, drive: [] },
    ...turns.slice(1).map((t) => {
      const k = points.indexOf(t);
      return { kind: 'turn', label: noted(t), at: t.at || start, drive: picks.has(k) ? [line[wp[k + 1]]] : [] };
    }),
  ];
  return {
    line: line.map((p) => [p.lat, p.lon]), seconds: feature.properties.summary.duration, meters: feature.properties.summary.distance,
    stops, start, startKind, minutes: Math.round(feature.properties.summary.duration / 60), level: 'test', fromTurns: true, problems,
  };
}

// ---------- hand-off to Maps ----------

// Starts from wherever the phone is, through each stop in order, and back to the start.
// Keeps the first and last and spreads the rest evenly, when there are more points than a link can take.
function spread(list, n) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
}

// From wherever the phone is, through each stop in order, and back to the start. With viaStart (test
// routes, often opened at a student's house) it goes to the start first, so the course is driven
// from its beginning instead of joining it at the second turn; that uses one of the 9 stops.
function drivePoints(route, viaStart) {
  const stops = route.stops.flatMap((s) => s.drive);
  const pts = viaStart ? [route.start, ...spread(stops, MAX_STOPS - 1)] : spread(stops, MAX_STOPS);
  return pts.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
}

function googleLink(route, viaStart) {
  const q = new URLSearchParams({ api: '1', destination: `${route.start.lat.toFixed(5)},${route.start.lon.toFixed(5)}`, travelmode: 'driving', dir_action: 'navigate' });
  q.set('waypoints', drivePoints(route, viaStart).join('|'));
  return `https://www.google.com/maps/dir/?${q}`;
}

function appleLink(route, viaStart) {
  const parts = [`destination=${route.start.lat.toFixed(5)},${route.start.lon.toFixed(5)}`, ...drivePoints(route, viaStart).map((p) => `waypoint=${p}`), 'mode=driving'];
  return `https://maps.apple.com/directions?${parts.join('&')}`;
}

// ---------- the map ----------

let mapLib = null;
let map = null;

function loadMapLib() {
  if (!document.querySelector('link[data-maplibre]')) {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'vendor/maplibre/maplibre-gl.css' });
    css.dataset.maplibre = '';
    document.head.append(css);
  }
  mapLib ||= import('./vendor/maplibre/maplibre-gl.mjs').catch((err) => {
    mapLib = null;
    throw err;
  });
  return mapLib;
}

function pin(text, extra = '') {
  const el = document.createElement('div');
  el.className = `rt-pin${extra}`;
  el.textContent = text;
  return el;
}

async function showMap(route) {
  const el = document.getElementById('rt-map');
  if (!el) return;
  let ml;
  try {
    ml = await loadMapLib();
  } catch {
    el.classList.add('rt-map-off');
    el.textContent = "The map couldn't load. The route below still works.";
    return;
  }
  if (!el.isConnected) return;
  map?.remove();
  const bounds = new ml.LngLatBounds();
  route.line.forEach(([lat, lon]) => bounds.extend([lon, lat]));
  map = new ml.Map({
    container: el,
    style: MAP_STYLE,
    bounds,
    fitBoundsOptions: { padding: { top: 34, right: 34, left: 34, bottom: 84 } }, // clear of the map credits
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  // The dark style names a few pattern images it doesn't ship; a blank stand-in keeps the console quiet.
  map.setMissingStyleImageResolver((id) => {
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: route.line.map(([lat, lon]) => [lon, lat]) } } });
    map.addLayer({ id: 'route-edge', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0a0f1d', 'line-width': 8 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f5b400', 'line-width': 4.5 } });
  });
  new ml.Marker({ element: pin('S', ' rt-pin-start') }).setLngLat([route.start.lon, route.start.lat]).addTo(map);
  route.stops.forEach((s, i) => {
    if (dist(s.at, route.start) > 25) new ml.Marker({ element: pin(String(i + 1)) }).setLngLat([s.at.lon, s.at.lat]).addTo(map);
  });
}

export function leaveRoutes() {
  map?.remove();
  map = null;
}

// ---------- saved routes ----------

async function loadSaved() {
  if (rs.loaded) return;
  rs.saved = cleanRoutes(await deps.db.getMeta('routes').catch(() => null));
  rs.loaded = true;
}

const persistSaved = () => deps.db.setMeta('routes', rs.saved);

// Only what a saved route needs, checked, so a bad backup can't break the tab.
function cleanRoutes(list) {
  if (!Array.isArray(list)) return [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const pt = (p) => (p && num(p.lat) !== null && num(p.lon) !== null ? { lat: num(p.lat), lon: num(p.lon) } : null);
  return list.map((r) => {
    if (!r || typeof r.id !== 'string' || typeof r.line !== 'string' || !pt(r.start) || !Array.isArray(r.stops)) return null;
    const stops = r.stops.map((s) => (s && pt(s.at) && Array.isArray(s.drive) ? {
      kind: String(s.kind || ''), label: String(s.label || '').slice(0, 200), at: pt(s.at), drive: s.drive.map(pt).filter(Boolean).slice(0, 3),
    } : null)).filter(Boolean).slice(0, MAX_TURNS + 1);
    return {
      id: r.id, name: String(r.name || 'Practice route').slice(0, 80), createdAt: num(r.createdAt) || Date.now(), line: r.line,
      start: pt(r.start), startKind: r.startKind === 'here' ? 'here' : 'office', minutes: num(r.minutes) || 60,
      level: LEVELS.some(([v]) => v === r.level) ? r.level : 'building', seconds: num(r.seconds) || 0, meters: num(r.meters) || 0, stops,
      fromTurns: r.fromTurns === true,
    };
  }).filter(Boolean);
}

export const exportRoutes = () => rs.saved;

// From a backup: adds routes this phone doesn't have yet. Returns how many came in.
export async function importRoutes(list) {
  await loadSaved();
  const fresh = cleanRoutes(list).filter((r) => !rs.saved.some((s) => s.id === r.id));
  if (!fresh.length) return 0;
  rs.saved = [...fresh, ...rs.saved].sort((a, b) => b.createdAt - a.createdAt);
  await persistSaved();
  return fresh.length;
}

export function forgetRoutes() {
  rs.saved = [];
  rs.route = null;
  rs.tests = [];
  rs.testsLoaded = false;
}

// ---------- test routes (the school's, for road-test days) ----------

async function loadTests() {
  if (rs.testsLoaded) return;
  rs.tests = cleanRoutes(await deps.db.getMeta('testRoutes').catch(() => null));
  rs.testsLoaded = true;
}

function setTests(list) {
  rs.tests = cleanRoutes(list);
  deps.db.setMeta('testRoutes', rs.tests).catch(() => {});
}

// Asks the school server for the list (at most every 30 s). Says whether anything changed.
async function refreshTests(force = false) {
  if (deps.device().status !== 'approved' || (!force && Date.now() - rs.testsFetched < 30000)) return false;
  rs.testsFetched = Date.now();
  const before = JSON.stringify(rs.tests.map((t) => [t.id, t.name]));
  try {
    setTests((await deps.school('/test-routes')).routes);
  } catch {
    return false; // no signal: the copy on the phone still works
  }
  return before !== JSON.stringify(rs.tests.map((t) => [t.id, t.name]));
}

const isAdmin = () => deps.device().status === 'approved' && deps.device().admin;
const nextTestName = () => `Test route ${String.fromCharCode(65 + (rs.tests.length % 26))}`;
const routePayload = (r) => ({
  line: encodeLine(r.line), start: r.start, startKind: r.startKind, minutes: r.minutes, level: r.level, seconds: r.seconds, meters: r.meters, stops: r.stops,
  fromTurns: !!r.fromTurns,
});

async function addTest(button) {
  const route = rs.view?.route;
  if (!route) return;
  const name = (document.getElementById('rt-name')?.value || '').trim() || nextTestName();
  button.disabled = true;
  try {
    const res = await deps.school('/test-routes', { name, route: routePayload(route) });
    setTests(res.routes);
    rs.naming = null;
    deps.toast('Added to test routes for every instructor');
    deps.go(`/routes/test/${res.id}`);
  } catch (err) {
    button.disabled = false;
    deps.toast(err.message);
  }
}

async function deleteTest(id) {
  const test = rs.tests.find((t) => t.id === id);
  if (!test || !confirm(`Delete "${test.name}" for every instructor?\n\nLinks already sent to students will stop working.`)) return;
  try {
    setTests((await deps.school('/test-routes/delete', { id })).routes);
    deps.toast('Test route deleted');
    deps.go('/routes', true);
  } catch (err) {
    deps.toast(err.message);
  }
}

// A link the student opens on their own phone (no app, no sign-in) to practice before test day.
async function sendToStudent(id) {
  const test = rs.tests.find((t) => t.id === id);
  if (!test) return;
  const url = `${deps.appUrl}#/t/${id}`;
  const text = `Here's a practice route for your road test: ${test.name}. Open the link, start at the S pin, then tap Google Maps or Apple Maps and drive it with a licensed adult.`;
  if (navigator.share) {
    try { await navigator.share({ text, url }); } catch { /* cancelled */ }
    return;
  }
  deps.toast((await deps.copyText(`${text}\n${url}`)) ? 'Link copied. Paste it in a text to the student.' : "Couldn't copy");
}

// ---------- screens ----------

export function parseRoutesPath(parts) {
  if (parts[1] === 'route') return { name: 'routes', view: 'route' };
  if (parts[1] === 'saved' && parts[2]) return { name: 'routes', view: 'saved', id: parts[2] };
  if (parts[1] === 'test' && parts[2]) return { name: 'routes', view: 'test', id: parts[2] };
  if (parts[1] === 'turns') return { name: 'routes', view: 'turns' };
  return { name: 'routes', view: 'build' };
}

export async function renderRoutes(r) {
  await Promise.all([loadSaved(), loadTests()]);
  if (r.view === 'route' && rs.route) return renderRoute(rs.route, 'new');
  if (r.view === 'turns' && isAdmin()) return renderTurns();
  if (r.view === 'saved') {
    const saved = rs.saved.find((s) => s.id === r.id);
    if (saved) return renderRoute({ ...saved, line: decodeLine(saved.line) }, 'saved');
  }
  if (r.view === 'test') {
    if (!rs.tests.some((t) => t.id === r.id)) await refreshTests(true);
    const test = rs.tests.find((t) => t.id === r.id);
    if (test) return renderRoute({ ...test, line: decodeLine(test.line) }, 'test');
  }
  renderBuilder();
  // Pick up test routes an admin added since, then redraw if still here.
  if (await refreshTests() && location.hash === '#/routes') renderBuilder();
}

// What a student sees from a Share route link: the route, the Maps buttons, nothing else of the app.
export async function renderShared(id) {
  const shell = (body) => `${deps.header({ title: 'Practice route' })}<main class="view">${body}</main>`;
  deps.app.innerHTML = shell('<p class="empty-note">Loading the route…</p>');
  try {
    const [route] = cleanRoutes([await deps.school(`/shared/${encodeURIComponent(id)}`)]);
    if (!route) throw new Error("This practice route didn't load right. Ask your instructor for a new link.");
    if (location.hash === `#/t/${id}`) renderRoute({ ...route, line: decodeLine(route.line) }, 'student');
  } catch (err) {
    deps.app.innerHTML = shell(`<div class="card"><h2 class="card-title">Couldn't open this route</h2><p>${esc(err.message)}</p></div>`);
  }
}

function chips(action, options, isOn, extra = '') {
  return `<div class="chips rt-chips${extra}">${options.map(([value, label, disabled]) => `<button type="button" class="chip${isOn(value) ? ' on' : ''}" data-action="${action}" data-value="${esc(value)}" aria-pressed="${isOn(value)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`).join('')}</div>`;
}

function renderBuilder() {
  leaveRoutes();
  const approved = deps.device().status === 'approved';
  const busy = rs.building;
  const skills = SKILLS.map(([id, label]) => [id, label, rs.level === 'beginner' && id === 'fw']);
  const card = (s, action) => `<button type="button" class="card rt-saved" data-action="${action}" data-id="${esc(s.id)}">
      <span class="rt-saved-name">${esc(s.name)}</span>
      <span class="rt-saved-meta">${esc(minutesLabel(Math.round(s.seconds / 60)))} · ${esc(miles(s.meters))} mi · ${s.stops.length} stops · ${s.startKind === 'here' ? 'Started from a spot you picked' : 'From the office'}</span>
    </button>`;
  const saved = rs.saved.map((s) => card(s, 'rt-open')).join('');
  // Test routes come first: on a test day they're what you reach for.
  const tests = (rs.tests.length
    ? `<div class="list">${rs.tests.map((t) => card(t, 'rt-open-test')).join('')}</div>`
    : `<p class="hint rt-none">${isAdmin() ? 'None yet. Type in a test route\'s turns, or build a route and tap Add to test routes under it.' : 'None yet. Your admin adds them.'}</p>`)
    + (isAdmin() ? '<button class="btn btn-outline btn-block rt-gap" data-action="rt-turns">Make one from turns</button>' : '');
  deps.app.innerHTML = `
    ${deps.header({ title: 'Routes' })}
    <main class="view with-tabs routes-view">
      ${approved || rs.tests.length ? `<h2 class="list-title rt-first">Test routes</h2>${tests}<h2 class="list-title">Build a route</h2>` : ''}
      <section class="card rt-form">
        <div class="rt-row"><span class="label">Start</span>
          ${chips('rt-start', [['office', 'Office'], ['here', 'Here (GPS)']], (v) => v === rs.start)}
          ${rs.start === 'here' ? '<p class="hint">Uses where the phone is when you tap Build, like a student\'s house.</p>' : '<p class="hint">6909 W Ray Rd, Chandler.</p>'}
        </div>
        <div class="rt-row"><span class="label">Length</span>${chips('rt-length', LENGTHS.map(([v, l]) => [String(v), l]), (v) => Number(v) === rs.minutes, ' rt-chips-3')}</div>
        <div class="rt-row"><span class="label">Level</span>${chips('rt-level', LEVELS, (v) => v === rs.level)}
          <p class="hint">${rs.level === 'beginner' ? 'No freeways, and no freeway merging.' : rs.level === 'test' ? 'Leans toward the office area, where road tests happen.' : 'Any roads, freeways included.'}</p>
        </div>
        <div class="rt-row"><span class="label">Practice</span>${chips('rt-skill', skills, (v) => rs.skills.has(v), ' rt-chips-2')}</div>
        ${approved ? '' : '<p class="hint rt-warn">Routes come through the school server. Ask to join on the Break down tab first.</p>'}
        <button class="btn btn-primary btn-block btn-tall" data-action="${busy ? 'rt-cancel' : 'rt-build'}"${approved ? '' : ' disabled'}>
          ${busy ? `<span class="spinner"></span><span>${esc(busy.status)}</span>` : 'Build route'}
        </button>
      </section>
      ${saved ? `<h2 class="list-title">Saved routes</h2><div class="list">${saved}</div>` : ''}
    </main>
    ${deps.tabbar('routes')}`;
}

// mode: new (just built), saved (on this phone), test (the school's), student (opened from a link).
function renderRoute(route, mode) {
  rs.view = { route, mode };
  const student = mode === 'student';
  const viaStart = mode === 'test' || student; // test routes get opened away from the start, often at home
  const ios = deps.platform() !== 'android';
  const title = { new: 'Practice route', saved: 'Saved route', test: 'Test route', student: 'Practice route' }[mode];
  const total = `${minutesLabel(Math.round(route.seconds / 60))} · ${miles(route.meters)} mi · ${route.stops.length} ${route.fromTurns ? 'turns' : 'stops'}`;
  const from = route.startKind === 'here' ? 'From where you were' : 'From the office';
  const about = student
    ? `Tap ${ios ? 'Google Maps or Apple Maps' : 'Google Maps'} from anywhere, even home: it takes you to the start first (${route.startKind === 'office' ? 'Key Skills Driving School, 6909 W Ray Rd, Chandler, ' : ''}the S pin), then around the route.`
    : route.fromTurns ? `${from} · made from a list of turns` : `${from} · ${lengthLabel(route.minutes)} lesson · ${levelLabel(route.level)}`;
  const missing = route.missing?.length ? `<p class="hint">Nothing near enough for: ${esc(route.missing.map((k) => SKILLS.find(([id]) => id === k)?.[1]).join(', '))}.</p>` : '';
  // A typed-in route says plainly where it doesn't match the turns, before anyone saves it.
  const problems = route.problems?.length
    ? `<div class="banner banner-gold rt-problems"><div><strong>Check ${route.problems.length === 1 ? 'this' : `these ${route.problems.length}`} before saving:</strong><ul>${route.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div></div>`
    : '';
  // The Maps apps take 9 points; on a longer typed-in route the list is the full set of turns.
  const handoff = route.fromTurns && route.stops.length > MAX_STOPS && !student
    ? `<p class="hint">Google and Apple Maps get ${viaStart ? MAX_STOPS - 1 : MAX_STOPS} of the ${route.stops.length} turns, spread along the route. The list below has every turn.</p>` : '';
  const fine = student
    ? 'Practice with a licensed adult in the front seat. Road signs and signals come first: the map can be out of date.'
    : 'Spots come from OpenStreetMap and can be out of date. Drive a route yourself before using it with a student.';
  deps.app.innerHTML = `
    ${deps.header(student ? { title } : { left: deps.backLink('/routes', 'Routes'), title })}
    <main class="view${student ? '' : ' with-tabs'} routes-view">
      <div id="rt-map" class="rt-map" role="img" aria-label="Map of the route"></div>
      <div class="rt-summary">
        ${mode !== 'new' ? `<p class="rt-route-name">${esc(route.name)}</p>` : ''}
        <p class="rt-total">${esc(total)}</p>
        <p class="hint">${esc(about)}</p>
        ${missing}
      </div>
      ${problems}
      <span class="label">Drive it</span>
      <div class="${ios ? 'two' : ''} rt-drive">
        <a class="btn btn-primary${ios ? '' : ' btn-block'}" href="${esc(googleLink(route, viaStart))}" target="_blank" rel="noopener">Google Maps</a>
        ${ios ? `<a class="btn btn-primary" href="${esc(appleLink(route, viaStart))}" target="_blank" rel="noopener">Apple Maps</a>` : ''}
      </div>
      ${handoff}
      <div id="rt-actions">${routeButtons(route, mode)}</div>
      <h2 class="list-title">${route.fromTurns ? 'Turns' : 'Stops'}</h2>
      <ol class="rt-stops">
        ${route.stops.map((s) => `<li>${esc(s.label)}</li>`).join('')}
        <li class="rt-back">Back to the start</li>
      </ol>
      <p class="fine">${esc(fine)}</p>
    </main>
    ${student ? '' : deps.tabbar('routes')}`;
  showMap(route);
}

// The buttons under Drive it, or the name box while saving. Redrawn on their own so the map stays put.
function routeButtons(route, mode) {
  if (mode === 'student') return '';
  if (rs.naming) {
    const test = rs.naming === 'test';
    return `<div class="rt-name">
        <label class="field"><span class="label">${test ? 'Test route name (every instructor sees it)' : 'Name'}</span><input id="rt-name" maxlength="80" value="${esc(test ? nextTestName() : defaultName(route))}" autocomplete="off"></label>
        <div class="two"><button class="btn" data-action="rt-save-cancel">Cancel</button><button class="btn btn-primary" data-action="rt-save-confirm">${test ? 'Add' : 'Save'}</button></div>
      </div>`;
  }
  if (mode === 'test') {
    return `<button class="btn btn-block rt-gap" data-action="rt-send" data-id="${esc(route.id)}">Share route</button>
      ${isAdmin() ? `<button class="btn btn-block btn-danger-soft rt-gap" data-action="rt-test-delete" data-id="${esc(route.id)}">Delete test route</button>` : ''}`;
  }
  const toTests = isAdmin() ? '<button class="btn btn-block rt-gap" data-action="rt-test-add">Add to test routes</button>' : '';
  if (mode === 'saved') return `${toTests}<button class="btn btn-block rt-gap" data-action="rt-delete" data-id="${esc(route.id)}">Delete</button>`;
  if (rs.building) return `<button class="btn btn-block rt-gap" data-action="rt-cancel"><span class="spinner"></span><span>${esc(rs.building.status)}</span></button>`;
  // A typed-in route can't be shuffled; going back to fix a line is what it needs instead.
  const first = route.fromTurns ? '<button class="btn" data-action="rt-turns">Edit turns</button>' : '<button class="btn" data-action="rt-shuffle">Shuffle</button>';
  return `<div class="two rt-gap">${first}<button class="btn" data-action="rt-save">Save</button></div>${toTests}`;
}

// Admins type or paste a test route as turns; the app finds the crossings and draws it.
function renderTurns() {
  leaveRoutes();
  const busy = rs.building;
  deps.app.innerHTML = `
    ${deps.header({ left: deps.backLink('/routes', 'Routes'), title: 'Route from turns' })}
    <main class="view with-tabs routes-view">
      <section class="card rt-form">
        <div class="rt-row"><span class="label">Start</span>
          ${chips('rt-turns-start', [['office', 'Office'], ['here', 'Here (GPS)']], (v) => v === rs.turnsStart)}
        </div>
        <label class="field rt-row"><span class="label">Turns, one per line</span>
          <textarea id="rt-turns" rows="10" placeholder="Right on Ray Rd&#10;Left on Kyrene Rd&#10;Left on Warner Rd&#10;Parallel park on the right&#10;Left on 56th St&#10;Left on Ray Rd" autocapitalize="sentences">${esc(rs.turnsText)}</textarea></label>
        <p class="hint">Start with the street you pull out onto. Each turn happens where the street before it meets the new one. A line without a street (like "Parallel park on the right") is kept as a note on the turn before it. The route ends back at the start.</p>
        <button class="btn btn-primary btn-block btn-tall" data-action="${busy ? 'rt-cancel' : 'rt-turns-build'}">
          ${busy ? `<span class="spinner"></span><span>${esc(busy.status)}</span>` : 'Build from turns'}
        </button>
      </section>
    </main>
    ${deps.tabbar('routes')}`;
  const box = document.getElementById('rt-turns');
  if (box) {
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + 2}px`;
  }
}

async function buildTurns() {
  if (rs.building) return;
  rs.turnsText = document.getElementById('rt-turns')?.value || rs.turnsText;
  const controller = new AbortController();
  rs.building = { status: 'Reading the turns…', controller };
  rs.naming = null;
  renderTurns();
  try {
    const route = await buildFromTurns(rs.turnsText, rs.turnsStart, controller.signal, setStatus);
    if (controller.signal.aborted) return;
    rs.route = route;
    rs.building = null;
    if (location.hash.startsWith('#/routes')) deps.go('/routes/route');
  } catch (err) {
    if (controller.signal.aborted) return;
    rs.building = null;
    if (location.hash === '#/routes/turns') renderTurns();
    deps.toast(err.message || "Couldn't build that route", { label: 'OK', run: () => {} });
  }
}

// The app's input listener hands typing in the turns box here, so a re-render keeps it.
export function routesInput(el) {
  if (el.id === 'rt-turns') rs.turnsText = el.value;
}

function redrawButtons() {
  const box = document.getElementById('rt-actions');
  if (box && rs.view) box.innerHTML = routeButtons(rs.view.route, rs.view.mode);
}

function openNameBox(kind) {
  rs.naming = kind;
  redrawButtons();
  const input = document.getElementById('rt-name');
  input?.focus();
  input?.select();
}

function defaultName(route) {
  if (route.fromTurns) return `Turns from ${route.startKind === 'here' ? 'here' : 'the office'}, ${minutesLabel(Math.round(route.seconds / 60))}`;
  const kinds = [...new Set(route.stops.map((s) => s.kind))].map((k) => SKILLS.find(([id]) => id === k)?.[1]).filter(Boolean);
  return `${route.startKind === 'here' ? 'Here' : 'Office'}, ${lengthLabel(route.minutes)}: ${kinds.slice(0, 3).join(', ')}`.slice(0, 80);
}

// ---------- doing things ----------

function hereNow() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This phone can't share its location here. Start from the office."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1
        ? "Location is turned off for this app. Allow it in the phone's settings, or start from the office."
        : "Couldn't get a GPS fix. Step outside or try again.")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  });
}

function setStatus(text) {
  if (!rs.building) return;
  rs.building.status = text;
  const btn = document.querySelector('[data-action=rt-cancel] span:last-child');
  if (btn) btn.textContent = text;
}

// From the route screen (Shuffle) it stays put and shows progress on the button; from the
// settings screen, on Build route.
async function build({ stay = false } = {}) {
  if (rs.building) return;
  if (!rs.skills.size) {
    deps.toast('Pick at least one thing to practice');
    return;
  }
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const controller = new AbortController();
  rs.building = { status: rs.start === 'here' ? 'Finding where you are…' : 'Finding practice spots…', controller };
  rs.naming = null;
  const redraw = () => (stay && document.getElementById('rt-actions') ? redrawButtons() : renderBuilder());
  if (stay || location.hash === '#/routes') redraw();
  else deps.go('/routes');
  try {
    const start = rs.start === 'here' ? await hereNow() : OFFICE;
    const settings = { start, startKind: rs.start, minutes: rs.minutes, level: rs.level, skills: rs.skills };
    const route = await buildRoute(settings, seed, controller.signal, setStatus);
    if (controller.signal.aborted) return;
    rs.route = { ...route, start, startKind: rs.start, minutes: rs.minutes, level: rs.level, seed };
    rs.building = null;
    if (location.hash.startsWith('#/routes')) deps.go('/routes/route');
    else deps.toast('Your route is ready in Routes'); // they went to another tab meanwhile
  } catch (err) {
    if (controller.signal.aborted) return;
    rs.building = null;
    redraw();
    deps.toast(err.message || "Couldn't build a route");
  }
}

function cancelBuild() {
  rs.building?.controller.abort();
  rs.building = null;
  if (document.getElementById('rt-actions')) redrawButtons();
  else if (location.hash === '#/routes/turns') renderTurns();
  else renderBuilder();
  deps.toast('Stopped');
}

async function saveRoute() {
  const route = rs.route;
  if (!route) return;
  const name = (document.getElementById('rt-name')?.value || '').trim() || defaultName(route);
  const saved = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
    name, createdAt: Date.now(), line: encodeLine(route.line), start: route.start, startKind: route.startKind,
    minutes: route.minutes, level: route.level, seconds: route.seconds, meters: route.meters, stops: route.stops, fromTurns: !!route.fromTurns,
  };
  rs.saved = [saved, ...rs.saved];
  try {
    await persistSaved();
  } catch {
    rs.saved = rs.saved.filter((s) => s !== saved);
    deps.toast("Couldn't save the route. Try again.");
    return;
  }
  rs.naming = null;
  deps.toast('Route saved');
  deps.go(`/routes/saved/${saved.id}`, true);
}

async function deleteRoute(id) {
  const route = rs.saved.find((s) => s.id === id);
  if (!route || !confirm(`Delete "${route.name}"?`)) return;
  rs.saved = rs.saved.filter((s) => s.id !== id);
  await persistSaved().catch(() => {});
  deps.toast('Route deleted');
  deps.go('/routes', true);
}

export const routeActions = {
  'rt-start': (el) => { rs.start = el.dataset.value; renderBuilder(); },
  'rt-length': (el) => { rs.minutes = Number(el.dataset.value); renderBuilder(); },
  'rt-level': (el) => {
    rs.level = el.dataset.value;
    if (rs.level === 'beginner') rs.skills.delete('fw');
    renderBuilder();
  },
  'rt-skill': (el) => {
    const id = el.dataset.value;
    if (rs.skills.has(id)) rs.skills.delete(id);
    else rs.skills.add(id);
    renderBuilder();
  },
  'rt-build': () => build(),
  'rt-cancel': () => cancelBuild(),
  'rt-shuffle': () => {
    if (!rs.route) return;
    rs.start = rs.route.startKind;
    rs.minutes = rs.route.minutes;
    rs.level = rs.route.level;
    build({ stay: true });
  },
  'rt-save': () => openNameBox('save'),
  'rt-test-add': () => openNameBox('test'),
  'rt-save-cancel': () => { rs.naming = null; redrawButtons(); },
  'rt-save-confirm': (el) => (rs.naming === 'test' ? addTest(el) : saveRoute()),
  'rt-open': (el) => deps.go(`/routes/saved/${el.dataset.id}`),
  'rt-delete': (el) => deleteRoute(el.dataset.id),
  'rt-open-test': (el) => deps.go(`/routes/test/${el.dataset.id}`),
  'rt-test-delete': (el) => deleteTest(el.dataset.id),
  'rt-send': (el) => sendToStudent(el.dataset.id),
  'rt-turns': () => { rs.naming = null; deps.go('/routes/turns'); },
  'rt-turns-start': (el) => { rs.turnsStart = el.dataset.value; renderTurns(); },
  'rt-turns-build': () => buildTurns(),
};
