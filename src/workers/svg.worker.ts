import type { Camera, Design } from '../lib/domain.ts';
import { NORTH_ARROW } from '../lib/north-arrow.ts';
import { metresPerSceneUnit, scaleBar, SCALE_BAR } from '../lib/scale-bar.ts';
import { EXPORT_BORDER, placeMarks } from '../lib/marks.ts';
import type { Centre, Size } from '../lib/marks.ts';
import { gridDrawing } from '../lib/graticule.ts';
import type { GridOptions } from '../lib/graticule.ts';
import { fitCamera } from '../lib/view.ts';

type Request =
  | { type: 'start'; width: number; height: number; camera: Camera; design: Design; centre: { lon: number; lat: number }; grid: GridOptions; scale: number; labelSize: number; strokeWidth: number; transparent: boolean }
  | { type: 'geometry'; positions: ArrayBuffer }
  | { type: 'finish' };
const scope = self as unknown as { onmessage: (event: MessageEvent<Request>) => void; postMessage: (value: { blob?: Blob; error?: string }) => void };
let setup: Extract<Request, { type: 'start' }>;
const parts: string[] = [];
// eslint-disable-next-line no-control-regex -- XML excludes these control characters.
const escape = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const n = (value: number) => String(Number(value.toFixed(6)));

// Liang–Barsky clipping preserves every visible segment without creating connections.
function clip(x1: number, y1: number, x2: number, y2: number): number[] | undefined {
  const dx = x2 - x1, dy = y2 - y1;
  let from = 0, to = 1;
  const p = [-dx, dx, -dy, dy], q = [x1, setup.width - x1, y1, setup.height - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return; }
    else { const t = q[i] / p[i]; if (p[i] < 0) from = Math.max(from, t); else to = Math.min(to, t); if (from > to) return; }
  }
  return [x1 + from * dx, y1 + from * dy, x1 + to * dx, y1 + to * dy];
}

scope.onmessage = event => {
  try {
    const request = event.data;
    if (request.type === 'start') {
      setup = request;
      setup.camera = fitCamera(setup.camera, setup.width / setup.height);
      parts.push(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${setup.width}" height="${setup.height}" viewBox="0 0 ${setup.width} ${setup.height}"><metadata>Data © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright</metadata>`);
      if (!setup.transparent && setup.design.backgroundOpacity > 0) parts.push(`<rect width="100%" height="100%" fill="${setup.design.backgroundColor}" fill-opacity="${setup.design.backgroundOpacity}"/>`);
      parts.push(`<g fill="none" stroke="${setup.design.roadColor}" stroke-opacity="${setup.design.roadOpacity}" stroke-width="${setup.strokeWidth}" stroke-linecap="butt">`);
    } else if (request.type === 'geometry') {
      const positions = new Float32Array(request.positions);
      // Scene to export pixels around the frame centre, turned clockwise by the map rotation.
      const c = setup.camera, cx = (c.left + c.right) / 2, cy = (c.top + c.bottom) / 2, unit = setup.width / (c.right - c.left);
      const r = (setup.design.rotation || 0) * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r), halfW = setup.width / 2, halfH = setup.height / 2;
      const px = (x: number, y: number) => halfW + ((x - cx) * cos + (y - cy) * sin) * unit;
      const py = (x: number, y: number) => halfH - ((y - cy) * cos - (x - cx) * sin) * unit;
      let paths = '';
      for (let i = 0; i < positions.length; i += 4) {
        const [x1, y1, x2, y2] = [positions[i], positions[i + 1], positions[i + 2], positions[i + 3]];
        const line = clip(px(x1, y1), py(x1, y1), px(x2, y2), py(x2, y2));
        if (line) paths += `M${n(line[0])},${n(line[1])}L${n(line[2])},${n(line[3])}`;
        if (i && i % 20000 === 0 && paths) { parts.push(`<path d="${paths}"/>`); paths = ''; }
      }
      if (paths) parts.push(`<path d="${paths}"/>`);
    } else {
      const label = setup.design.label, arrow = NORTH_ARROW;
      parts.push('</g>');
      // Coordinate grid above the roads, below the label and marks.
      // setup.camera is already fitted to the export, so its width spans the export.
      const bar = setup.design.scaleBar ? scaleBar((setup.camera.right - setup.camera.left) / setup.width * metresPerSceneUnit(setup.centre.lat) * setup.scale) : undefined;
      const area = { width: setup.width, height: setup.height };
      const grid = gridDrawing(setup.camera, setup.centre, setup.width, setup.height, setup.scale, setup.grid, EXPORT_BORDER, setup.design.rotation || 0);
      // Marks and the label move inward a few pixels when they would cover grid teeth or labels.
      const placed = placeMarks(setup.design, area, setup.scale, bar, grid?.keepouts, 4 * Math.max(1, setup.scale));
      if (grid) {
        const lines = (list: typeof grid.lines) => list.map(line => `<line x1="${n(line.x1)}" y1="${n(line.y1)}" x2="${n(line.x2)}" y2="${n(line.y2)}"/>`).join('');
        if (grid.lines.length) parts.push(`<g stroke="${setup.design.roadColor}" stroke-width="${grid.lineWidth}" stroke-opacity="${grid.lineOpacity}">${lines(grid.lines)}</g>`);
        if (grid.teeth.length) parts.push(`<g stroke="${setup.design.roadColor}" stroke-width="${grid.lineWidth}">${lines(grid.teeth)}</g>`);
        parts.push(`<g fill="${setup.design.roadColor}" font-family="sans-serif" font-size="${n(grid.font)}" text-anchor="middle" dominant-baseline="middle">${grid.texts.map(text => `<text transform="translate(${n(text.x)} ${n(text.y)}) rotate(${n(text.angle)})">${escape(text.text)}</text>`).join('')}</g>`);
      }
      // Marks are CSS-pixel geometry, laid out as on screen and scaled to the export.
      const place = (centre: Centre, size: Size) => `translate(${n(centre.x - size.width * setup.scale / 2)} ${n(centre.y - size.height * setup.scale / 2)}) scale(${n(setup.scale)})`;
      if (setup.design.north) parts.push(`<g transform="${place(placed.north, arrow)} rotate(${n(setup.design.rotation || 0)} ${arrow.cx} ${arrow.cy})"><g fill="none" stroke="${label.color}" stroke-width="${arrow.stroke}" stroke-linejoin="round" stroke-linecap="round"><path d="${arrow.path}"/>${arrow.circles.map(circle => `<circle cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}"/>`).join('')}</g><text x="${arrow.letter.x}" y="${arrow.letter.y}" fill="${label.color}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-weight="bold" font-size="${arrow.letter.size}">N</text></g>`);
      if (bar && placed.scaleBar) parts.push(`<g transform="${place(placed.scaleBar, bar)}" fill="${label.color}"><g stroke="${label.color}" stroke-width="${SCALE_BAR.stroke}" stroke-linecap="square">${bar.lines.map(line => `<line x1="${n(line.x1)}" y1="${n(line.y1)}" x2="${n(line.x2)}" y2="${n(line.y2)}"/>`).join('')}</g>${bar.texts.map(text => `<text x="${n(text.x)}" y="${n(text.y)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${SCALE_BAR.font}">${escape(text.text)}</text>`).join('')}</g>`);
      parts.push(`<rect x="${EXPORT_BORDER / 2}" y="${EXPORT_BORDER / 2}" width="${setup.width - EXPORT_BORDER}" height="${setup.height - EXPORT_BORDER}" fill="none" stroke="${setup.design.roadColor}" stroke-width="${EXPORT_BORDER}"/>`);
      parts.push(`<text x="${n(placed.label.x)}" y="${n(placed.label.y)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${setup.labelSize}" fill="${label.color}" fill-opacity="${label.opacity}">${escape(label.text)}</text></svg>`);
      scope.postMessage({ blob: new Blob(parts, { type: 'image/svg+xml' }) });
    }
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : 'SVG export failed' }); }
};
