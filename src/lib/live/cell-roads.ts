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
export interface RoadCell { box: Camera; rank: RoadRank }

/**
 * Projected segments of one road rank inside a cell. Accepts inline way geometry
 * (`out geom`) or separate nodes. Ways of other ranks are dropped, so ranks fetched by
 * separate queries never overlap. A cell without roads is valid and empty.
 */
export function cellRoads(value: unknown, project: Project, cell: Camera, rank: RoadRank): CellRoads {
  return batchCellRoads(value, project, [{ box: cell, rank }])[0];
}

/** Scan, validate and project each selected way once, then clip it into its cells. */
export function batchCellRoads(value: unknown, project: Project, cells: RoadCell[]): CellRoads[] {
  const elements = value && typeof value === 'object' ? (value as { elements?: unknown }).elements : undefined;
  if (!Array.isArray(elements)) throw invalid('The road service returned an invalid response');
  const nodes = new Map<string, [number, number]>();
  for (const element of elements) {
    if (!element || typeof element !== 'object') throw invalid('Invalid road element');
    const e = element as Record<string, unknown>;
    if (e.type === 'node') nodes.set(id(e.id), coordinate(e.lon, e.lat));
  }
  const ranks = new Set(cells.map(cell => cell.rank));
  const lines: { points: Float64Array; bounds: Camera }[][] = [[], [], []];
  const seen = [new Set<string>(), new Set<string>(), new Set<string>()];
  for (const element of elements) {
    const e = element as Record<string, unknown>;
    if (e.type !== 'way') continue;
    const wayId = id(e.id);
    const rank = roadRank((e.tags as Record<string, unknown> | undefined)?.highway);
    if (!ranks.has(rank) || seen[rank].has(wayId)) continue;
    seen[rank].add(wayId);
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
    // Keep double precision until clipping; neighbouring cells must compute identical seams.
    const projected = new Float64Array(points.length * 2);
    const bounds: Camera = { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity };
    for (let i = 0; i < points.length; i++) {
      const [x, y] = project(points[i][0], points[i][1]);
      projected[i * 2] = x; projected[i * 2 + 1] = y;
      bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
      bounds.bottom = Math.min(bounds.bottom, y); bounds.top = Math.max(bounds.top, y);
    }
    lines[rank].push({ points: projected, bounds });
  }
  const timestamp = (value as { osm3s?: { timestamp_osm_base?: unknown } }).osm3s?.timestamp_osm_base;
  const snapshotAt = typeof timestamp === 'string' ? timestamp.slice(0, 64) : undefined;
  return cells.map(({ box, rank }) => {
    // Reject whole ways outside the cell before allocating or clipping individual segments.
    const candidates = lines[rank].filter(({ bounds: b }) => b.left <= box.right && b.right >= box.left && b.bottom <= box.top && b.top >= box.bottom);
    const capacity = candidates.reduce((sum, line) => sum + line.points.length / 2 - 1, 0);
    const positions = new Float32Array(capacity * 4);
    let offset = 0;
    for (const { points } of candidates) for (let i = 2; i < points.length; i += 2) {
      const piece = clipSegment(points[i - 2], points[i - 1], points[i], points[i + 1], box);
      if (piece) { positions[offset++] = piece[0]; positions[offset++] = piece[1]; positions[offset++] = piece[2]; positions[offset++] = piece[3]; }
    }
    // An exact-length copy, so the transferred buffer holds no unused tail.
    return { positions: offset === positions.length ? positions : positions.slice(0, offset), segments: offset / 4, ways: lines[rank].length, snapshotAt };
  });
}
