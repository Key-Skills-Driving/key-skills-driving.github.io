// QR code for the review card, drawn as crisp SVG so it scans well at any size.
import qrcode from './vendor/qrcode.js';

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      let run = 1;
      while (col + run < count && qr.isDark(row, col + run)) run++;
      d += `M${col + quiet} ${row + quiet}h${run}v1h-${run}z`;
      col += run - 1;
    }
  }
  const size = count + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
