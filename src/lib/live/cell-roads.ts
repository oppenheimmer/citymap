import { id, roadRank } from '../domain.ts';
import type { Camera, RoadRank } from '../domain.ts';
import { CellFailure } from './overpass.ts';

type Project = (lon: number, lat: number) => [number, number];

/**
 * Liang–Barsky clipping to a half-open cell: a piece lying along the right or top edge
 * belongs to the neighbouring cell, so a road on a cell border is drawn exactly once.
 * Neighbours compute the same parameter for their shared edge, so clipped roads meet exactly.
 */
export function clipSegment(x1: number, y1: number, x2: number, y2: number, cell: Camera): [number, number, number, number] | undefined {
  const dx = x2 - x1, dy = y2 - y1;
  let from = 0, to = 1;
  const p = [-dx, dx, -dy, dy], q = [x1 - cell.left, cell.right - x1, y1 - cell.bottom, cell.top - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > from) from = t; } else if (t < to) to = t;
    if (from > to) return;
  }
  const ax = from > 0 ? x1 + from * dx : x1, ay = from > 0 ? y1 + from * dy : y1;
  const bx = to < 1 ? x1 + to * dx : x2, by = to < 1 ? y1 + to * dy : y2;
  if (ax === bx && ay === by) return;
  if (ax >= cell.right && bx >= cell.right || ay >= cell.top && by >= cell.top) return;
  return [ax, ay, bx, by];
}

const invalid = (message: string) => new CellFailure('decode_failure', { message });
function coordinate(lon: unknown, lat: unknown): [number, number] {
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat <= -90 || lat >= 90) throw invalid('Road data contains an invalid coordinate');
  return [lon, lat];
}

export interface CellRoads { positions: Float32Array; segments: number; ways: number; snapshotAt?: string }

/**
 * Projected segments of one road rank inside a cell. Accepts inline way geometry
 * (`out geom`) or separate nodes. Ways of other ranks are dropped, so ranks fetched by
 * separate queries never overlap. A cell without roads is valid and empty.
 */
export function cellRoads(value: unknown, project: Project, cell: Camera, rank: RoadRank): CellRoads {
  const elements = value && typeof value === 'object' ? (value as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) throw invalid('The road service returned an invalid response');
  const nodes = new Map<string, [number, number]>();
  for (const element of elements) {
    if (!element || typeof element !== 'object') throw invalid('Invalid road element');
    const e = element as Record<string, unknown>;
    if (e.type === 'node') nodes.set(id(e.id), coordinate(e.lon, e.lat));
  }
  const lines: [number, number][][] = [];
  const seen = new Set<string>();
  let capacity = 0;
  for (const element of elements) {
    const e = element as Record<string, unknown>;
    if (e.type !== 'way') continue;
    const wayId = id(e.id);
    if (seen.has(wayId) || roadRank((e.tags as Record<string, unknown> | undefined)?.highway) !== rank) continue;
    seen.add(wayId);
    let points: [number, number][];
    if (Array.isArray(e.geometry)) points = e.geometry.map(point => coordinate(point?.lon, point?.lat));
    else if (Array.isArray(e.nodes)) points = e.nodes.map(ref => {
      const point = nodes.get(id(ref));
      if (!point) throw invalid('Road data is incomplete: a way references a missing node');
      return point;
    });
    else throw invalid('A road has no geometry');
    // A one-node way is a mapping defect with nothing to draw.
    if (points.length < 2) continue;
    lines.push(points);
    capacity += points.length - 1;
  }
  const positions = new Float32Array(capacity * 4);
  let offset = 0;
  for (const points of lines) {
    let [px, py] = project(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      const [nx, ny] = project(points[i][0], points[i][1]);
      const piece = clipSegment(px, py, nx, ny, cell);
      if (piece) { positions[offset++] = piece[0]; positions[offset++] = piece[1]; positions[offset++] = piece[2]; positions[offset++] = piece[3]; }
      px = nx; py = ny;
    }
  }
  const timestamp = (value as { osm3s?: { timestamp_osm_base?: unknown } }).osm3s?.timestamp_osm_base;
  // An exact-length copy, so the transferred buffer holds no unused tail.
  return { positions: offset === positions.length ? positions : positions.slice(0, offset), segments: offset / 4, ways: lines.length, snapshotAt: typeof timestamp === 'string' ? timestamp.slice(0, 64) : undefined };
}
