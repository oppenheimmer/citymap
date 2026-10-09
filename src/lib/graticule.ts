import type { Camera } from './domain.ts';
import { SCALE } from './view.ts';

export type GridMode = 'none' | 'ticks' | 'lines';
export interface GridOptions { mode: GridMode; opacity: number }
export interface GridLine { x1: number; y1: number; x2: number; y2: number }
/** Text centred on (x, y), running along `angle` degrees (clockwise from the +x axis). */
export interface GridText { x: number; y: number; text: string; angle: number }
/** Area a tooth or label occupies, with the edge it belongs to (0 top, 1 left, 2 bottom, 3 right). */
export interface Keepout { box: Box; edge: number }
/**
 * Export-pixel geometry: faint full lines, border teeth at full opacity, labels, and the
 * keepouts that marks move clear of.
 */
export interface GridDrawing { lines: GridLine[]; teeth: GridLine[]; texts: GridText[]; keepouts: Keepout[]; lineOpacity: number; lineWidth: number; font: number }
export type Point = [number, number];
/** Axis-aligned area in export pixels: [left, top, right, bottom]. */
export type Box = [number, number, number, number];

const RAD = Math.PI / 180;
const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
const inverseMercator = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
// Values are hundredths of an arc-minute. Intervals: whole degrees, whole minutes, then
// decimal minutes, so labels never need seconds.
const PER_DEGREE = 6000;
const STEPS = [60000, 30000, 12000, 6000, 3000, 2000, 1500, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const TEETH = 8, LABEL_GAP = 3;

/** Largest interval giving at least three lines across `span` hundredths of a minute. */
export const gridStep = (span: number) => STEPS.find(step => span / step >= 3) ?? 1;

/** Degrees and minutes (decimal minutes below one minute) with a hemisphere letter. */
export function formatAngle(value: number, step: number, axis: 'lon' | 'lat'): string {
  if (axis === 'lon') value = ((value + 180 * PER_DEGREE) % (360 * PER_DEGREE) + 360 * PER_DEGREE) % (360 * PER_DEGREE) - 180 * PER_DEGREE;
  const total = Math.abs(Math.round(value)), degrees = Math.floor(total / PER_DEGREE), minutes = total % PER_DEGREE / 100;
  const decimals = step >= 100 ? 0 : step >= 10 ? 1 : 2;
  const text = step >= PER_DEGREE ? `${degrees}°` : `${degrees}°${minutes.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}′`;
  return total === 0 ? text : text + (axis === 'lon' ? (value > 0 ? 'E' : 'W') : (value > 0 ? 'N' : 'S'));
}

/**
 * Pixel frame of an export: `camera` is its centre with extents along the screen axes,
 * turned clockwise by `rotation` degrees. Scene y points north; pixel y points down.
 */
function frame(camera: Camera, width: number, height: number, rotation: number) {
  const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2, unit = width / (camera.right - camera.left);
  const cos = Math.cos(rotation * RAD), sin = Math.sin(rotation * RAD);
  return {
    cx, cy,
    toPixel: (x: number, y: number): Point => { const dx = x - cx, dy = y - cy; return [width / 2 + (dx * cos + dy * sin) * unit, height / 2 - (-dx * sin + dy * cos) * unit]; },
    toScene: (px: number, py: number): Point => { const sx = (px - width / 2) / unit, sy = (height / 2 - py) / unit; return [cx + sx * cos - sy * sin, cy + sx * sin + sy * cos]; },
    /** Pixel direction of scene north (meridians) and east (parallels). */
    north: [sin, -cos] as Point, east: [cos, sin] as Point,
  };
}

export interface GraticuleLine { axis: 'lon' | 'lat'; label: string; point: Point; direction: Point }
/** Meridians and parallels crossing an export frame, as pixel points and directions. */
export function graticule(camera: Camera, centre: { lon: number; lat: number }, width: number, height: number, rotation = 0): GraticuleLine[] {
  const f = frame(camera, width, height, rotation);
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => f.toScene(x, y));
  const lonOf = (x: number) => centre.lon + (x - f.cx) / SCALE / RAD;
  const latOf = (y: number) => inverseMercator(mercator(centre.lat) + (y - f.cy) / SCALE);
  const series = (values: number[]) => {
    const low = Math.round(Math.min(...values) * PER_DEGREE), high = Math.round(Math.max(...values) * PER_DEGREE), step = gridStep(high - low);
    const result: number[] = [];
    for (let value = Math.ceil(low / step) * step; value <= high; value += step) result.push(value);
    return { step, values: result };
  };
  const lon = series(corners.map(([x]) => lonOf(x))), lat = series(corners.map(([, y]) => latOf(y)));
  return [
    ...lon.values.map(value => ({ axis: 'lon' as const, label: formatAngle(value, lon.step, 'lon'), point: f.toPixel(f.cx + (value / PER_DEGREE - centre.lon) * RAD * SCALE, f.cy), direction: f.north })),
    ...lat.values.map(value => ({ axis: 'lat' as const, label: formatAngle(value, lat.step, 'lat'), point: f.toPixel(f.cx, f.cy + (mercator(value / PER_DEGREE) - mercator(centre.lat)) * SCALE), direction: f.east })),
  ];
}

/** Parameter range where `point + t·direction` lies inside the box, if any. */
function clip(point: Point, direction: Point, x0: number, y0: number, x1: number, y1: number): [number, number] | undefined {
  let from = -Infinity, to = Infinity;
  for (const [p, d, min, max] of [[point[0], direction[0], x0, x1], [point[1], direction[1], y0, y1]]) {
    if (Math.abs(d) < 1e-12) { if (p < min || p > max) return; continue; }
    const a = (min - p) / d, b = (max - p) / d;
    from = Math.max(from, Math.min(a, b)); to = Math.min(to, Math.max(a, b));
  }
  return from < to ? [from, to] : undefined;
}

/**
 * Drawing for an export of `width`×`height` pixels whose CSS-to-export ratio is `scale`,
 * with the map turned clockwise by `rotation` degrees. Each edge pair carries one family:
 * longitudes on the top and bottom and latitudes on the left and right, swapped once the
 * map turns past 45° and meridians run closer to horizontal. Teeth follow their grid line
 * in from those edges; each line is labelled once, at its tooth's tip, perpendicular to
 * the line and kept upright, preferring the top or left edge.
 */
export function gridDrawing(camera: Camera, centre: { lon: number; lat: number }, width: number, height: number, scale: number, options: GridOptions, border: number, rotation = 0): GridDrawing | undefined {
  if (options.mode === 'none') return;
  const font = Math.max(9, 10 * scale), tooth = TEETH * Math.max(1, scale), gap = LABEL_GAP * Math.max(1, scale);
  const [x0, y0, x1, y1] = [border, border, width - border, height - border];
  const lines: GridLine[] = [], teeth: GridLine[] = [], texts: GridText[] = [];
  const placed: Box[] = [], keepouts: Keepout[] = [];
  // Edges: 0 top, 1 left, 2 bottom, 3 right.
  const edge = ([x, y]: Point) => [Math.abs(y - y0), Math.abs(x - x0), Math.abs(y - y1), Math.abs(x - x1)].reduce((best, distance, index, all) => distance < all[best] ? index : best, 0);
  const meridiansUpright = Math.abs(Math.cos(rotation * RAD)) >= Math.abs(Math.sin(rotation * RAD)) - 1e-9;
  const allowed = (axis: 'lon' | 'lat', index: number) => (index % 2 === 0) === (axis === 'lon' ? meridiansUpright : !meridiansUpright);
  for (const { axis, label, point, direction } of graticule(camera, centre, width, height, rotation)) {
    const range = clip(point, direction, x0, y0, x1, y1);
    if (!range || range[1] - range[0] < 1) continue;
    const at = (t: number): Point => [point[0] + direction[0] * t, point[1] + direction[1] * t];
    // Each end, with the direction pointing into the frame.
    const all = [{ p: at(range[0]), d: direction }, { p: at(range[1]), d: [-direction[0], -direction[1]] as Point }];
    // Only ends on this family's edges get teeth and labels.
    const ends = all.filter(({ p }) => allowed(axis, edge(p)));
    if (options.mode === 'ticks') for (const { p, d } of ends) {
      const tip: Point = [p[0] + d[0] * tooth, p[1] + d[1] * tooth];
      teeth.push({ x1: p[0], y1: p[1], x2: tip[0], y2: tip[1] });
      keepouts.push({ box: [Math.min(p[0], tip[0]), Math.min(p[1], tip[1]), Math.max(p[0], tip[0]), Math.max(p[1], tip[1])], edge: edge(p) });
    }
    if (!ends.length) {
      if (options.mode === 'lines') lines.push({ x1: all[0].p[0], y1: all[0].p[1], x2: all[1].p[0], y2: all[1].p[1] });
      continue;
    }
    const end = ends.length === 1 || edge(ends[0].p) <= edge(ends[1].p) ? ends[0] : ends[1], other = end === all[0] ? all[1] : all[0];
    const tip = options.mode === 'ticks' ? tooth : 0;
    // Text runs perpendicular to its line; flip so it is never upside down.
    let t: Point = [-end.d[1], end.d[0]];
    if (t[0] < -1e-9 || Math.abs(t[0]) <= 1e-9 && t[1] > 0) t = [-t[0], -t[1]];
    const half = label.length * font * 0.3;
    // Past the tooth's tip, far enough along the line that a tilted label clears its edge.
    const normal = ([[0, 1], [1, 0], [0, -1], [-1, 0]] as Point[])[edge(end.p)];
    const inward = end.d[0] * normal[0] + end.d[1] * normal[1];
    const reach = half * Math.abs(t[0] * normal[0] + t[1] * normal[1]) + font / 2 * inward;
    const offset = inward > 0.2 ? Math.max(tip + gap + font / 2, (gap + reach) / inward) : Infinity;
    const c: Point = [end.p[0] + end.d[0] * offset, end.p[1] + end.d[1] * offset];
    const corners = [-1, 1].flatMap(a => [-1, 1].map(b => [c[0] + t[0] * half * a + end.d[0] * font / 2 * b, c[1] + t[1] * half * a + end.d[1] * font / 2 * b]));
    const box: Box = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
    const fits = Number.isFinite(offset) && box[0] >= x0 + 1 && box[1] >= y0 + 1 && box[2] <= x1 - 1 && box[3] <= y1 - 1 && !placed.some(b => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3]);
    if (fits) { placed.push(box); keepouts.push({ box, edge: edge(end.p) }); texts.push({ x: c[0], y: c[1], text: label, angle: Math.atan2(t[1], t[0]) / RAD }); }
    if (options.mode === 'lines') {
      // The labelled end starts just past its label so the line never crosses it.
      const start = fits ? offset + font / 2 + gap : 0;
      lines.push({ x1: end.p[0] + end.d[0] * start, y1: end.p[1] + end.d[1] * start, x2: other.p[0], y2: other.p[1] });
    }
  }
  return { lines, teeth, texts, keepouts, lineOpacity: Math.max(0, Math.min(1, options.opacity)), lineWidth: Math.max(1, Math.round(scale)), font };
}

/**
 * Shift that moves `box` inward, away from each grid tooth or label it overlaps (with a
 * `gap`), perpendicular to that keepout's edge. A few passes settle chains of overlaps.
 */
export function avoidGrid(box: Box, keepouts: Keepout[], gap: number): Point {
  let dx = 0, dy = 0;
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const { box: o, edge } of keepouts) {
      const b = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
      if (!(b[0] < o[2] + gap && o[0] - gap < b[2] && b[1] < o[3] + gap && o[1] - gap < b[3])) continue;
      if (edge === 0) dy += o[3] + gap - b[1];
      else if (edge === 1) dx += o[2] + gap - b[0];
      else if (edge === 2) dy -= b[3] - (o[1] - gap);
      else dx -= b[2] - (o[0] - gap);
      moved = true;
    }
    if (!moved) break;
  }
  return [dx, dy];
}
