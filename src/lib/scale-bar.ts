import { SCALE } from './view.ts';

const EARTH_RADIUS = 6_371_008.8;
const METRES_PER_MILE = 1609.344, METRES_PER_FOOT = 0.3048;
/** Ground metres per projected scene unit at a latitude; Mercator scale varies north to south. */
export const metresPerSceneUnit = (lat: number) => EARTH_RADIUS * Math.cos(lat * Math.PI / 180) / SCALE;

/**
 * Longest whole-number step (1/2/5×10ⁿ, at least 1) with 2–5 divisions that fits; ties
 * keep fewer divisions. Undefined when even two 1-unit steps do not fit.
 */
export function niceDivisions(maxUnits: number): { step: number; count: number } | undefined {
  if (!(maxUnits > 0) || !Number.isFinite(maxUnits)) return;
  let best: { step: number; count: number } | undefined;
  const exponent = Math.floor(Math.log10(maxUnits));
  for (let e = Math.max(0, exponent - 2); e <= exponent; e++) for (const m of [1, 2, 5]) {
    const step = m * 10 ** e, count = Math.min(5, Math.floor(maxUnits / step + 1e-9));
    if (count < 2) continue;
    const total = step * count, bestTotal = best ? best.step * best.count : 0;
    if (!best || total > bestTotal * (1 + 1e-9) || total >= bestTotal * (1 - 1e-9) && count < best.count) best = { step, count };
  }
  return best;
}

export interface ScaleLine { x1: number; y1: number; x2: number; y2: number }
export interface ScaleText { x: number; y: number; text: string }
/** Railway-style scale bar in CSS pixels: metric teeth above the rail, imperial teeth below. */
export interface ScaleBarGeometry { width: number; height: number; lines: ScaleLine[]; texts: ScaleText[]; summary: string }

export const SCALE_BAR = { maxLength: 140, font: 10, tooth: 6, stroke: 1.25 } as const;
const TOP_TEXT = 5, RAIL = 19, BOTTOM_TEXT = 33, HEIGHT = 38;
const label = (value: number) => String(Math.round(value));

// The larger unit is used when at least two whole units fit; otherwise the smaller one.
function axis(metresPerPx: number, units: { unit: string; metres: number }[]) {
  for (const { unit, metres } of units) {
    const divisions = niceDivisions(SCALE_BAR.maxLength * metresPerPx / metres);
    if (divisions) return { ...divisions, unit, px: divisions.step * metres / metresPerPx };
  }
}

/** Geometry for `metresPerPx` ground metres per CSS pixel, or undefined when not drawable. */
export function scaleBar(metresPerPx: number): ScaleBarGeometry | undefined {
  if (!(metresPerPx > 0) || !Number.isFinite(metresPerPx)) return;
  const metric = axis(metresPerPx, [{ unit: 'km', metres: 1000 }, { unit: 'm', metres: 1 }]);
  const imperial = axis(metresPerPx, [{ unit: 'mi', metres: METRES_PER_MILE }, { unit: 'ft', metres: METRES_PER_FOOT }]);
  if (!metric || !imperial) return;
  const { tooth, font } = SCALE_BAR;
  const ends = [`${label(metric.step * metric.count)} ${metric.unit}`, `${label(imperial.step * imperial.count)} ${imperial.unit}`];
  // End labels are centred on the last teeth; pad so the widest stays inside the mark.
  const x0 = Math.ceil(Math.max(...ends.map(text => text.length)) * font * 0.3) + 2;
  const length = Math.max(metric.px * metric.count, imperial.px * imperial.count);
  const lines: ScaleLine[] = [{ x1: x0, y1: RAIL, x2: x0 + length, y2: RAIL }];
  const texts: ScaleText[] = [];
  for (const [side, scale] of [[-1, metric], [1, imperial]] as const) {
    for (let i = 0; i <= scale.count; i++) {
      const x = x0 + i * scale.px;
      lines.push({ x1: x, y1: RAIL, x2: x, y2: RAIL + side * tooth });
      texts.push({ x, y: side < 0 ? TOP_TEXT : BOTTOM_TEXT, text: label(i * scale.step) + (i === scale.count ? ` ${scale.unit}` : '') });
    }
  }
  const summary = `${label(metric.step * metric.count)} ${metric.unit} and ${label(imperial.step * imperial.count)} ${imperial.unit}`;
  return { width: length + 2 * x0, height: HEIGHT, lines, texts, summary };
}

/** Visible width of a camera fitted to an aspect ratio, as SceneController and exports frame it. */
export const fittedWidth = (camera: { left: number; right: number; top: number; bottom: number }, aspect: number) => Math.max(camera.right - camera.left, (camera.top - camera.bottom) * aspect);
