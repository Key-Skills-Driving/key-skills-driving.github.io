// Small map helpers shared by the Routes tab (routes.js) and Drive mode (drive.js).
// Points are { lat, lon }; distances are meters, headings degrees clockwise from north.

export const rad = (d) => (d * Math.PI) / 180;

export function dist(a, b) {
  const kx = 111320 * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * kx);
}

export function bearing(a, b) {
  return ((Math.atan2((b.lon - a.lon) * Math.cos(rad(a.lat)), b.lat - a.lat) * 180) / Math.PI + 360) % 360;
}

export function offset(p, meters, deg) {
  return { lat: p.lat + (meters * Math.cos(rad(deg))) / 111320, lon: p.lon + (meters * Math.sin(rad(deg))) / (111320 * Math.cos(rad(p.lat))) };
}

// How far the heading swings from hIn to hOut: negative is left, positive right, -180 to 180.
export const turnAngle = (hIn, hOut) => ((hOut - hIn + 540) % 360) - 180;

// The route service's names are long ("East Chandler Boulevard"); say them the way the spots do.
const SUFFIX = { Street: 'St', Road: 'Rd', Avenue: 'Ave', Boulevard: 'Blvd', Drive: 'Dr', Parkway: 'Pkwy', Lane: 'Ln', Place: 'Pl', Court: 'Ct', Circle: 'Cir', Trail: 'Trl' };
export function shortName(name) {
  if (!name || name === '-') return '';
  const words = name.split(' ');
  if (words.length > 1 && /^(North|South|East|West|[NSEW])$/.test(words[0])) words.shift();
  if (words.length > 1 && SUFFIX[words.at(-1)]) words[words.length - 1] = SUFFIX[words.at(-1)];
  return words.join(' ');
}
