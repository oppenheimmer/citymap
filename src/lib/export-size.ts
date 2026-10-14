/** Export limits: pixels along each edge, and in the whole image. */
export const EXPORT_LIMITS = { min: 256, max: 8192, pixels: 16_777_216 } as const;

/** The pixels one edge may have when the other follows at `ratio`, this edge over the other. */
export function edgeRange(ratio: number): [number, number] {
  const { min, max, pixels } = EXPORT_LIMITS;
  return [Math.max(min, Math.ceil(min * ratio)), Math.floor(Math.min(max, max * ratio, Math.sqrt(pixels * ratio)))];
}

/**
 * An export of the map's shape: `edge` pixels along one edge, moved within the limits,
 * and the other edge at `ratio`, the first over the other.
 */
export function linkedSize(edge: number, ratio: number): [number, number] {
  const [low, high] = edgeRange(ratio), other = (value: number) => Math.round(value / ratio);
  let value = Math.min(Math.max(Math.round(edge), low), high);
  // Rounding the other edge up can pass the pixel limit by a little.
  while (value > low && value * other(value) > EXPORT_LIMITS.pixels) value--;
  return [value, other(value)];
}
