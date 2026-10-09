import type { Camera, Design } from '../lib/domain.ts';
import { NORTH_ARROW } from '../lib/north-arrow.ts';

type Request =
  | { type: 'start'; width: number; height: number; camera: Camera; design: Design; scale: number; labelSize: number; licenseSize: number; strokeWidth: number; transparent: boolean }
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
      const c = setup.camera, aspect = setup.width / setup.height;
      const h = Math.max(c.top - c.bottom, (c.right - c.left) / aspect);
      const cx = (c.left + c.right) / 2, cy = (c.bottom + c.top) / 2;
      setup.camera = { left: cx - h * aspect / 2, right: cx + h * aspect / 2, bottom: cy - h / 2, top: cy + h / 2 };
      parts.push(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${setup.width}" height="${setup.height}" viewBox="0 0 ${setup.width} ${setup.height}"><metadata>Data © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright</metadata>`);
      if (!setup.transparent && setup.design.backgroundOpacity > 0) parts.push(`<rect width="100%" height="100%" fill="${setup.design.backgroundColor}" fill-opacity="${setup.design.backgroundOpacity}"/>`);
      parts.push(`<g fill="none" stroke="${setup.design.roadColor}" stroke-opacity="${setup.design.roadOpacity}" stroke-width="${setup.strokeWidth}" stroke-linecap="butt">`);
    } else if (request.type === 'geometry') {
      const positions = new Float32Array(request.positions);
      const c = setup.camera;
      let paths = '';
      for (let i = 0; i < positions.length; i += 4) {
        const line = clip((positions[i] - c.left) * setup.width / (c.right - c.left), (c.top - positions[i + 1]) * setup.height / (c.top - c.bottom), (positions[i + 2] - c.left) * setup.width / (c.right - c.left), (c.top - positions[i + 3]) * setup.height / (c.top - c.bottom));
        if (line) paths += `M${n(line[0])},${n(line[1])}L${n(line[2])},${n(line[3])}`;
        if (i && i % 20000 === 0 && paths) { parts.push(`<path d="${paths}"/>`); paths = ''; }
      }
      if (paths) parts.push(`<path d="${paths}"/>`);
    } else {
      const label = setup.design.label, arrow = NORTH_ARROW;
      parts.push('</g>');
      if (setup.design.north) parts.push(`<g transform="translate(${n(setup.width - (arrow.margin + arrow.width) * setup.scale)} ${n(arrow.margin * setup.scale)}) scale(${n(setup.scale)})" fill="${label.color}"><path d="${arrow.path}"/><text x="${arrow.letter.x}" y="${arrow.letter.y}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-weight="bold" font-size="${arrow.letter.size}">N</text></g>`);
      parts.push(`<text x="${n(label.x * setup.width)}" y="${n(label.y * setup.height)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${setup.labelSize}" fill="${label.color}" fill-opacity="${label.opacity}">${escape(label.text)}</text><a xlink:href="https://www.openstreetmap.org/copyright"><text x="${n(setup.width * 0.97)}" y="${n(setup.height * 0.97)}" text-anchor="end" dominant-baseline="middle" font-family="sans-serif" font-size="${setup.licenseSize}" fill="#303030" stroke="#ffffff" stroke-width="${setup.licenseSize / 6}" paint-order="stroke fill">© OpenStreetMap contributors</text></a></svg>`);
      scope.postMessage({ blob: new Blob(parts, { type: 'image/svg+xml' }) });
    }
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : 'SVG export failed' }); }
};
