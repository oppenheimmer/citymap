import type { Camera } from './domain.ts';
import { SCALE } from './view.ts';

export type GridMode = 'none' | 'ticks' | 'lines';
export interface GridOptions { mode: GridMode; opacity: number }
export interface GridLine { x1: number; y1: number; x2: number; y2: number }
export interface GridText { x: number; y: number; text: string }
/** Export-pixel geometry: faint full lines, border teeth at full opacity, and labels. */
export interface GridDrawing { lines: GridLine[]; teeth: GridLine[]; texts: GridText[]; lineOpacity: number; lineWidth: number; font: number }

const RAD = Math.PI / 180;
const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
const inverseMercator = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
// Intervals in arc-seconds: whole degrees, then minutes, then seconds.
const STEPS = [36000, 18000, 7200, 3600, 1800, 1200, 900, 600, 300, 120, 60, 30, 20, 15, 10, 5, 2, 1];
const TEETH = 8, LABEL_GAP = 3;

/** Largest interval giving at least three lines across `span` arc-seconds. */
export const gridStep = (span: number) => STEPS.find(step => span / step >= 3) ?? 1;

/** Degrees, minutes and seconds to the precision of `step`, with a hemisphere letter. */
export function formatAngle(seconds: number, step: number, axis: 'lon' | 'lat'): string {
  if (axis === 'lon') seconds = ((seconds + 648000) % 1296000 + 1296000) % 1296000 - 648000;
  const total = Math.abs(Math.round(seconds));
  const d = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  const text = step >= 3600 ? `${d}°` : step >= 60 ? `${d}°${String(m).padStart(2, '0')}′` : `${d}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″`;
  return total === 0 ? text : text + (axis === 'lon' ? (seconds > 0 ? 'E' : 'W') : (seconds > 0 ? 'N' : 'S'));
}

/** Parallels and meridians crossing an export frame, as values in arc-seconds and pixel offsets. */
export function graticule(camera: Camera, centre: { lon: number; lat: number }, width: number, height: number) {
  const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2;
  const sceneWidth = camera.right - camera.left, sceneHeight = camera.top - camera.bottom;
  const lonAt = (x: number) => centre.lon + (camera.left + x / width * sceneWidth - cx) / SCALE / RAD;
  const latAt = (y: number) => inverseMercator(mercator(centre.lat) + (camera.top - y / height * sceneHeight - cy) / SCALE);
  const xOf = (lon: number) => (cx + (lon - centre.lon) * RAD * SCALE - camera.left) / sceneWidth * width;
  const yOf = (lat: number) => (camera.top - (cy + (mercator(lat) - mercator(centre.lat)) * SCALE)) / sceneHeight * height;
  const series = (from: number, to: number) => {
    const low = Math.round(Math.min(from, to) * 3600), high = Math.round(Math.max(from, to) * 3600), step = gridStep(high - low);
    const values: number[] = [];
    for (let value = Math.ceil(low / step) * step; value <= high; value += step) values.push(value);
    return { step, values };
  };
  const lon = series(lonAt(0), lonAt(width)), lat = series(latAt(height), latAt(0));
  return {
    meridians: lon.values.map(value => ({ at: xOf(value / 3600), label: formatAngle(value, lon.step, 'lon') })),
    parallels: lat.values.map(value => ({ at: yOf(value / 3600), label: formatAngle(value, lat.step, 'lat') })),
  };
}

/**
 * Drawing for an export of `width`×`height` pixels whose CSS-to-export ratio is `scale`.
 * Labels run along the top and left edges, inside the frame border; labels that would
 * leave the frame or crowd a corner are omitted.
 */
export function gridDrawing(camera: Camera, centre: { lon: number; lat: number }, width: number, height: number, scale: number, options: GridOptions, border: number): GridDrawing | undefined {
  if (options.mode === 'none') return;
  const { meridians, parallels } = graticule(camera, centre, width, height);
  const font = Math.max(9, 10 * scale), tooth = TEETH * Math.max(1, scale), gap = LABEL_GAP * Math.max(1, scale);
  const textWidth = (text: string) => text.length * font * 0.6;
  const inside = (at: number, extent: number) => at > border && at < extent - border;
  const lines: GridLine[] = [], teeth: GridLine[] = [], texts: GridText[] = [];
  for (const { at: x, label } of meridians.filter(line => inside(line.at, width))) {
    if (options.mode === 'lines') lines.push({ x1: x, y1: 0, x2: x, y2: height });
    else teeth.push({ x1: x, y1: border, x2: x, y2: border + tooth }, { x1: x, y1: height - border, x2: x, y2: height - border - tooth });
    if (x > border + font * 4 && x + gap + textWidth(label) < width - border - gap) texts.push({ x: x + gap, y: border + gap + font / 2, text: label });
  }
  for (const { at: y, label } of parallels.filter(line => inside(line.at, height))) {
    if (options.mode === 'lines') lines.push({ x1: 0, y1: y, x2: width, y2: y });
    else teeth.push({ x1: border, y1: y, x2: border + tooth, y2: y }, { x1: width - border, y1: y, x2: width - border - tooth, y2: y });
    if (y - gap - font > border + font * 2 && y < height - border) texts.push({ x: border + gap, y: y - gap - font / 2, text: label });
  }
  return { lines, teeth, texts, lineOpacity: Math.max(0, Math.min(1, options.opacity)), lineWidth: Math.max(1, Math.round(scale)), font };
}
