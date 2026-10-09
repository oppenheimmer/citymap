/**
 * Minimal line-art compass rose with a single "N", in CSS pixels. It is a draggable map
 * mark on screen and in PNG/SVG exports. Map rotation is disabled, so north is always
 * straight up.
 */
const UNIT = 1.25;
const CX = 28 * UNIT, CY = 44 * UNIT;
const RING = 18.5 * UNIT, HUB = 3.5 * UNIT, CARDINAL = 24 * UNIT, WAIST = 5 * UNIT, DIAGONAL = 16 * UNIT;
// Diagonal points start this far from the star's waist along its edges, keeping them pointed.
const SPLIT = 0.12;

type Point = readonly [number, number];
const round = (value: number) => Math.round(value * 100) / 100;
/** Degrees clockwise from north. */
const polar = (degrees: number, distance: number): Point => [round(CX + Math.sin(degrees * Math.PI / 180) * distance), round(CY - Math.cos(degrees * Math.PI / 180) * distance)];
const between = (from: Point, to: Point, t: number): Point => [round(from[0] + (to[0] - from[0]) * t), round(from[1] + (to[1] - from[1]) * t)];
const xy = (point: Point) => `${point[0]} ${point[1]}`;

const tips = [0, 90, 180, 270].map(angle => polar(angle, CARDINAL));
const waists = [45, 135, 225, 315].map(angle => polar(angle, WAIST));
const star = `M${tips.flatMap((tip, i) => [tip, waists[i]]).map(xy).join(' L')} Z`;
// Centre lines split each point into two facets, as on a drawn compass rose.
const facets = [0, 90, 180, 270].map((angle, i) => `M${xy(polar(angle, HUB))} L${xy(tips[i])}`);
const diagonals = [45, 135, 225, 315].map((angle, i) => {
  const tip = polar(angle, DIAGONAL), waist = waists[i];
  return `M${xy(between(waist, tips[i], SPLIT))} L${xy(tip)} L${xy(between(waist, tips[(i + 1) % 4], SPLIT))} M${xy(waist)} L${xy(tip)}`;
});

export const NORTH_ARROW = {
  width: 56 * UNIT, height: 72 * UNIT, stroke: 1.5,
  // Stroke-only geometry; coordinates use spaces so SVG road-segment counts ignore it.
  path: [star, ...facets, ...diagonals].join(' '),
  circles: [{ cx: CX, cy: CY, r: RING }, { cx: CX, cy: CY, r: HUB }],
  letter: { x: CX, y: 9 * UNIT, size: 16 },
} as const;
