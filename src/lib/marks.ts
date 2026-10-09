import type { Design, MarkPosition } from './domain.ts';
import { NORTH_ARROW } from './north-arrow.ts';

/** Export border width in export pixels, drawn in the road colour at full opacity. */
export const EXPORT_BORDER = 3;
/** CSS pixels between the north arrow and a scale bar placed below it by default. */
export const MARK_GAP = 10;
export interface Size { width: number; height: number }
export interface Centre { x: number; y: number }

const clamp = (value: number, half: number, extent: number) => half * 2 >= extent ? extent / 2 : Math.min(extent - half, Math.max(half, value));
/** Centre of a mark in map pixels, kept fully inside the map. `size` is in CSS pixels, `scale` map pixels per CSS pixel. */
export function markCentre(at: MarkPosition, size: Size, map: Size, scale = 1): Centre {
  return { x: clamp(at.x * map.width, size.width * scale / 2, map.width), y: clamp(at.y * map.height, size.height * scale / 2, map.height) };
}
export const northCentre = (design: Design, map: Size, scale = 1) => markCentre(design.northAt, NORTH_ARROW, map, scale);
/** The scale bar uses its own position once moved; until then it sits just below the north arrow. */
export function scaleBarCentre(design: Design, bar: Size, map: Size, scale = 1): Centre {
  if (design.scaleBarAt) return markCentre(design.scaleBarAt, bar, map, scale);
  const north = northCentre(design, map, scale);
  const below = north.y + (NORTH_ARROW.height / 2 + MARK_GAP + bar.height / 2) * scale;
  return markCentre({ x: north.x / map.width, y: below / map.height }, bar, map, scale);
}
