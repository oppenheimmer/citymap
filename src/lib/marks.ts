import type { Design, MarkPosition } from './domain.ts';
import { NORTH_ARROW } from './north-arrow.ts';
import { avoidGrid } from './graticule.ts';
import type { Box, Keepout, Point } from './graticule.ts';

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

/** Export positions of the marks and map label, nudged inward clear of the grid's teeth and labels. */
export function placeMarks(design: Design, map: Size, scale: number, bar: Size | undefined, keepouts: Keepout[] = [], gap = 4): { north: Centre; scaleBar?: Centre; label: Centre } {
  const box = (centre: Centre, width: number, height: number): Box => [centre.x - width / 2, centre.y - height / 2, centre.x + width / 2, centre.y + height / 2];
  const shift = (centre: Centre, [dx, dy]: Point): Centre => ({ x: centre.x + dx, y: centre.y + dy });
  const arrow = northCentre(design, map, scale), arrowBox = box(arrow, NORTH_ARROW.width * scale, NORTH_ARROW.height * scale);
  let north = shift(arrow, avoidGrid(arrowBox, keepouts, gap)), scaleBar: Centre | undefined;
  if (bar) {
    const at = scaleBarCentre(design, bar, map, scale), barBox = box(at, bar.width * scale, bar.height * scale);
    if (design.scaleBarAt) scaleBar = shift(at, avoidGrid(barBox, keepouts, gap));
    else {
      // A scale bar that follows the arrow moves with it as one group, keeping their spacing.
      const offset = avoidGrid([Math.min(arrowBox[0], barBox[0]), arrowBox[1], Math.max(arrowBox[2], barBox[2]), barBox[3]], keepouts, gap);
      north = shift(arrow, offset); scaleBar = shift(at, offset);
    }
  }
  const size = design.label.size * scale;
  const at = { x: design.label.x * map.width, y: design.label.y * map.height }, label = shift(at, avoidGrid(box(at, design.label.text.length * size * 0.6, size), keepouts, gap));
  return { north, scaleBar, label };
}
