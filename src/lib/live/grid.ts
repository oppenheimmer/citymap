import type { BBox, Camera, Origin, RoadRank } from '../domain.ts';
import { MAX_LATITUDE, mercator, RAD, SCALE, TX, TY, wrapLongitude } from '../view.ts';

/**
 * Live roads load in Web Mercator tiles ("cells"): deterministic query units that repeat
 * across pans, zooms and sessions. They are not pre-generated map tiles; each cell's roads
 * come from the live road service. Bump the version when levels or tile math change, so
 * cached cells from another grid are never reused.
 */
export const GRID_VERSION = 1;
/** Column `x` (0…2^z−1, west to east) and row `y` (north to south) at zoom `z`. */
export interface Tile { z: number; x: number; y: number }
export type Point = [x: number, y: number];

// Equatorial cell widths: about 20 km for major roads, 5 km for streets, 2.4 km for every way.
const BASE_LEVEL: Record<RoadRank, number> = { 0: 11, 1: 13, 2: 14 };

/**
 * Cell zoom for a road rank near `lat`. Mercator tiles shrink towards the poles, so higher
 * latitudes use coarser levels to keep a similar ground size and road count per query.
 */
export function cellLevel(rank: RoadRank, lat: number): number {
  const stretch = Math.log2(1 / Math.cos(Math.min(Math.abs(lat), MAX_LATITUDE) * RAD));
  return BASE_LEVEL[rank] - Math.round(stretch);
}

export const tileKey = (tile: Tile) => `${tile.z}/${tile.x}/${tile.y}`;
export function children(tile: Tile): Tile[] {
  const z = tile.z + 1, x = tile.x * 2, y = tile.y * 2;
  return [{ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 }];
}

const latitude = (row: number, n: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) / RAD;
const longitude = (column: number, n: number) => column / n * 360 - 180;
/** [south, west, north, east]. Tile columns end at ±180°, so a cell never crosses the antimeridian. */
export function tileBBox(tile: Tile): BBox {
  const n = 2 ** tile.z;
  return [latitude(tile.y + 1, n), longitude(tile.x, n), latitude(tile.y, n), longitude(tile.x + 1, n)];
}

// Scene coordinates mirror projector() in geometry.ts and cameraFromView() in view.ts.
// Columns may be unwrapped (outside 0…n) so that cells beside the antimeridian stay near the origin.
const sceneX = (column: number, n: number, origin: Origin) => TX + (longitude(column, n) - origin[0]) * RAD * SCALE;
const sceneY = (row: number, n: number, origin: Origin) => (Math.PI * (1 - 2 * row / n) - mercator(origin[1])) * SCALE - TY;
const column = (x: number, n: number, origin: Origin) => (origin[0] + (x - TX) / (RAD * SCALE) + 180) / 360 * n;
const row = (y: number, n: number, origin: Origin) => (1 - ((y + TY) / SCALE + mercator(origin[1])) / Math.PI) / 2 * n;
const rect = (x: number, y: number, n: number, origin: Origin): Camera => ({ left: sceneX(x, n, origin), right: sceneX(x + 1, n, origin), top: sceneY(y, n, origin), bottom: sceneY(y + 1, n, origin) });

/** Scene rectangle of the tile's copy nearest the projection origin. */
export function tileRect(tile: Tile, origin: Origin): Camera {
  const n = 2 ** tile.z;
  return rect(tile.x + Math.round((origin[0] - longitude(tile.x + 0.5, n)) / 360) * n, tile.y, n, origin);
}

const EARTH_RADIUS = 6_371_008.8;
/** Great-circle distance in metres between two [lon, lat] points. */
export function groundDistance(a: Origin, b: Origin): number {
  const dLat = (b[1] - a[1]) * RAD, dLon = wrapLongitude(b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Approximate distance in metres from a [lon, lat] point to the nearest part of a tile. */
export function tileDistance(tile: Tile, point: Origin): number {
  const [south, west, north, east] = tileBBox(tile);
  // The tile's longitudes are reached the short way around the globe.
  const gap = Math.max(0, Math.abs(wrapLongitude(point[0] - (west + east) / 2)) - (east - west) / 2);
  return groundDistance(point, [point[0] + gap, Math.min(north, Math.max(south, point[1]))]);
}

/** Separating-axis test of a convex polygon against a rectangle; touching edges do not intersect. */
function intersects(polygon: Point[], box: Camera): boolean {
  const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
  if (Math.max(...xs) <= box.left || Math.min(...xs) >= box.right || Math.max(...ys) <= box.bottom || Math.min(...ys) >= box.top) return false;
  const corners: Point[] = [[box.left, box.bottom], [box.right, box.bottom], [box.right, box.top], [box.left, box.top]];
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length];
    const along = (point: Point) => point[0] * (by - ay) + point[1] * (ax - bx);
    const a = polygon.map(along), b = corners.map(along);
    if (Math.max(...a) <= Math.min(...b) || Math.max(...b) <= Math.min(...a)) return false;
  }
  return true;
}

/**
 * Tiles at zoom `z` intersecting the convex scene polygon `corners`, nearest its centre
 * first. Undefined when more than `limit` tiles would be needed, so a zoomed-out view can
 * never start hundreds of live requests.
 */
export function coverTiles(corners: Point[], origin: Origin, z: number, limit: number): Tile[] | undefined {
  if (!corners.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return undefined;
  const n = 2 ** z;
  const columns = corners.map(([x]) => column(x, n, origin)), rows = corners.map(([, y]) => row(y, n, origin));
  const x0 = Math.floor(Math.min(...columns)), x1 = Math.floor(Math.max(...columns));
  const y0 = Math.max(0, Math.floor(Math.min(...rows))), y1 = Math.min(n - 1, Math.floor(Math.max(...rows)));
  if (y1 < y0) return [];
  // Screen-shaped footprints fill at least half their bounding box, even when rotated.
  if (x1 - x0 + 1 > n || (x1 - x0 + 1) * (y1 - y0 + 1) > limit * 4) return undefined;
  const cx = corners.reduce((sum, [x]) => sum + x, 0) / corners.length, cy = corners.reduce((sum, [, y]) => sum + y, 0) / corners.length;
  const found: { tile: Tile; distance: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const box = rect(x, y, n, origin);
    if (!intersects(corners, box)) continue;
    if (found.length === limit) return undefined;
    found.push({ tile: { z, x: (x % n + n) % n, y }, distance: Math.hypot((box.left + box.right) / 2 - cx, (box.top + box.bottom) / 2 - cy) });
  }
  return found.sort((a, b) => a.distance - b.distance || a.tile.y - b.tile.y || a.tile.x - b.tile.x).map(entry => entry.tile);
}
