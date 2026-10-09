import { geoMercator } from 'd3-geo';
import { id } from './domain.ts';
import type { Camera, Origin } from './domain.ts';
import type { PointE7, RoadPolyline } from './data/city-types.ts';
import { roadPoints } from './data/city-cache.ts';
import { SCALE, wrapLongitude } from './view.ts';

export type GeoBounds = [west: number, south: number, east: number, north: number];
export const MAX_SEGMENTS = 8_000_000;

/** Bounds may use an east longitude above 180 for data crossing the antimeridian. */
export function projector(bounds: GeoBounds) {
  const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
  const origin: Origin = [wrapLongitude(cx), cy];
  const projection = geoMercator().rotate([-cx, 0]).center([0, cy]).scale(SCALE);
  const project = (lon: number, lat: number): [number, number] => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat <= -90 || lat >= 90) throw new Error('Road data contains invalid or unprojectable coordinates');
    const p = projection([lon, lat]);
    if (!p || !p.every(Number.isFinite)) throw new Error('Road coordinates cannot be projected');
    return [p[0], -p[1]];
  };
  const corners = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]].map(([lon, lat]) => project(lon > 180 ? lon - 360 : lon, lat));
  const camera: Camera = { left: Math.min(corners[0][0], corners[1][0]), right: Math.max(corners[0][0], corners[1][0]), top: Math.max(corners[0][1], corners[1][1]), bottom: Math.min(corners[0][1], corners[1][1]) };
  const pad = Math.max(camera.right - camera.left, camera.top - camera.bottom, 1) * 0.12;
  camera.left -= pad; camera.right += pad; camera.top += pad; camera.bottom -= pad;
  return { project, bounds: camera, origin };
}

/** [west, south, east, north] of lon/lat points; east exceeds 180 when the wrapped span is shorter. */
export function pointBounds(points: Iterable<readonly [number, number]>): GeoBounds {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity, wrappedWest = Infinity, wrappedEast = -Infinity;
  for (const [lon, lat] of points) {
    west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat);
    const wrapped = lon < 0 ? lon + 360 : lon;
    wrappedWest = Math.min(wrappedWest, wrapped); wrappedEast = Math.max(wrappedEast, wrapped);
  }
  return wrappedEast - wrappedWest < east - west ? [wrappedWest, south, wrappedEast, north] : [west, south, east, north];
}

export function osmGeometry(value: unknown): { positions: Float32Array; bounds: Camera; origin: Origin; segments: number; indexMs: number; projectMs: number } {
  const started = performance.now();
  if (!value || typeof value !== 'object' || !Array.isArray((value as { elements?: unknown }).elements)) throw new Error('The road service returned an invalid response');
  const elements = (value as { elements: unknown[] }).elements;
  const nodes = new Map<string, [number, number]>();
  const ways = new Map<string, string[]>();
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  let wrappedWest = Infinity, wrappedEast = -Infinity;
  let segments = 0;
  for (const element of elements) {
    if (!element || typeof element !== 'object') throw new Error('Invalid road element');
    const e = element as Record<string, unknown>;
    if (e.type === 'node') {
      const nodeId = id(e.id);
      const lon = e.lon, lat = e.lat;
      if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat <= -90 || lat >= 90) throw new Error('Invalid road node coordinate');
      if (nodes.has(nodeId)) throw new Error('Duplicate road node');
      nodes.set(nodeId, [lon, lat]);
      west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat);
      const wrapped = lon < 0 ? lon + 360 : lon;
      wrappedWest = Math.min(wrappedWest, wrapped); wrappedEast = Math.max(wrappedEast, wrapped);
    } else if (e.type === 'way') {
      const wayId = id(e.id);
      if (!Array.isArray(e.nodes) || e.nodes.length < 2 || ways.has(wayId)) throw new Error('Invalid or duplicate road way');
      const refs = e.nodes.map(id);
      ways.set(wayId, refs);
      segments += refs.length - 1;
      if (segments > MAX_SEGMENTS) throw new Error('This map exceeds the geometry limit. Choose a smaller area.');
    }
  }
  if (!nodes.size || !ways.size || !segments) throw new Error('No roads were found in this area. Choose a city boundary or larger bounding box.');
  const indexed = performance.now();
  if (wrappedEast - wrappedWest < east - west) { west = wrappedWest; east = wrappedEast; }
  const projection = projector([west, south, east, north]);
  const points = new Map<string, [number, number]>();
  const positions = new Float32Array(segments * 4);
  let offset = 0;
  const point = (nodeId: string) => {
    const existing = points.get(nodeId);
    if (existing) return existing;
    const raw = nodes.get(nodeId);
    if (!raw) throw new Error(`Road data is incomplete: missing node ${nodeId}`);
    const projected = projection.project(raw[0], raw[1]);
    points.set(nodeId, projected);
    return projected;
  };
  for (const refs of ways.values()) {
    let previous = point(refs[0]);
    for (let i = 1; i < refs.length; i++) {
      const next = point(refs[i]);
      positions[offset++] = previous[0]; positions[offset++] = previous[1]; positions[offset++] = next[0]; positions[offset++] = next[1];
      previous = next;
    }
  }
  return { positions, bounds: projection.bounds, origin: projection.origin, segments, indexMs: indexed - started, projectMs: performance.now() - indexed };
}

export function polylineGeometry(roads: RoadPolyline[], project: (lon: number, lat: number) => [number, number], pointsOf: (road: RoadPolyline, index: number) => PointE7[] = roadPoints): Float32Array {
  const count = roads.reduce((sum, road) => sum + road.coordinate_deltas_e7.length / 2, 0);
  if (count > MAX_SEGMENTS) throw new Error('This map exceeds the geometry limit');
  const positions = new Float32Array(count * 4);
  let offset = 0;
  for (let index = 0; index < roads.length; index++) {
    const points = pointsOf(roads[index], index);
    let previous = project(points[0][0] / 1e7, points[0][1] / 1e7);
    for (let i = 1; i < points.length; i++) {
      const next = project(points[i][0] / 1e7, points[i][1] / 1e7);
      positions[offset++] = previous[0]; positions[offset++] = previous[1]; positions[offset++] = next[0]; positions[offset++] = next[1];
      previous = next;
    }
  }
  return positions;
}
