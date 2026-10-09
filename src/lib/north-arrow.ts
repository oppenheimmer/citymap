/**
 * North arrow geometry in CSS pixels, drawn at the map's top-right corner on screen and
 * in PNG/SVG exports. Map rotation is disabled, so north is always straight up.
 */
export const NORTH_ARROW = {
  width: 24, height: 38, margin: 16,
  path: 'M12 14L20 37L12 31L4 37Z',
  letter: { x: 12, y: 6, size: 12 },
} as const;
