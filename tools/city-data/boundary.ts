import { assert, object } from '../../src/lib/data/city-cache.ts';
import type { PointE7 } from '../../src/lib/data/city-types.ts';

const TURN = 3_600_000_000;
type Box = [number, number, number, number];
interface Edge { a: PointE7; b: PointE7; box: Box }
interface Ring { points: PointE7[]; edges: Edge[]; box: Box }
interface Polygon { rings: Ring[]; center: number; box: Box }
export interface BoundaryGeometry { polygons: Polygon[] }

const wrap = (lon: number, reference: number) => lon + Math.round((reference - lon) / TURN) * TURN;
const box = (a: PointE7, b: PointE7): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const overlaps = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const orientation = (a: PointE7, b: PointE7, p: PointE7) => BigInt(b[0] - a[0]) * BigInt(p[1] - a[1]) - BigInt(b[1] - a[1]) * BigInt(p[0] - a[0]);
const onSegment = (a: PointE7, b: PointE7, p: PointE7) => orientation(a, b, p) === 0n && overlaps(box(a, b), box(p, p));

function intersects(a: PointE7, b: PointE7, c: PointE7, d: PointE7): boolean {
  if (!overlaps(box(a, b), box(c, d))) return false;
  const ac = orientation(a, b, c), ad = orientation(a, b, d), ca = orientation(c, d, a), cb = orientation(c, d, b);
  if (ac === 0n && onSegment(a, b, c) || ad === 0n && onSegment(a, b, d) || ca === 0n && onSegment(c, d, a) || cb === 0n && onSegment(c, d, b)) return true;
  return (ac < 0n) !== (ad < 0n) && (ca < 0n) !== (cb < 0n);
}

export function coordinate(lon: unknown, lat: unknown): PointE7 {
  assert(typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180, 'Invalid boundary/source longitude');
  assert(typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90, 'Invalid boundary/source latitude');
  return [Math.round(lon * 1e7) || 0, Math.round(lat * 1e7) || 0];
}

function ring(value: unknown, reference?: number): Ring {
  assert(Array.isArray(value) && value.length >= 4 && value.length <= 100_000, 'Invalid or oversized boundary ring');
  const points = value.map(value => {
    assert(Array.isArray(value) && value.length === 2, 'Boundary coordinates must be longitude/latitude pairs');
    return coordinate(value[0], value[1]);
  });
  assert(points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1], 'Boundary ring is not closed');
  points[0][0] = reference === undefined ? points[0][0] : wrap(points[0][0], reference);
  for (let i = 1; i < points.length; i++) points[i][0] = wrap(points[i][0], points[i - 1][0]);
  assert(points.at(-1)![0] === points[0][0], 'Boundary ring winds around the globe');
  const bounds: Box = [Infinity, Infinity, -Infinity, -Infinity];
  let area = 0n;
  const edges: Edge[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    assert(a[0] !== b[0] || a[1] !== b[1], 'Boundary has a zero-length edge');
    area += BigInt(a[0]) * BigInt(b[1]) - BigInt(a[1]) * BigInt(b[0]);
    const boundsForEdge = box(a, b);
    bounds[0] = Math.min(bounds[0], boundsForEdge[0]); bounds[1] = Math.min(bounds[1], boundsForEdge[1]);
    bounds[2] = Math.max(bounds[2], boundsForEdge[2]); bounds[3] = Math.max(bounds[3], boundsForEdge[3]);
    edges.push({ a, b, box: boundsForEdge });
  }
  assert(area !== 0n && bounds[2] - bounds[0] < TURN / 2, 'Boundary is degenerate or spans a hemisphere');
  // Bounding-box pruning keeps exact E7 intersection checks focused on nearby edges.
  for (let i = 0; i < edges.length; i++) for (let j = i + 2; j < edges.length; j++) {
    if (i === 0 && j === edges.length - 1) continue;
    assert(!intersects(edges[i].a, edges[i].b, edges[j].a, edges[j].b), 'Boundary ring intersects itself');
  }
  return { points, edges, box: bounds };
}

function contains(ring: Ring, point: PointE7): 'inside' | 'outside' | 'edge' {
  if (!overlaps(ring.box, box(point, point))) return 'outside';
  let inside = false;
  for (const { a, b } of ring.edges) {
    if (onSegment(a, b, point)) return 'edge';
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const cross = orientation(a, b, point);
      if ((cross > 0n) === (b[1] > a[1])) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

export function boundaryGeometry(value: unknown): BoundaryGeometry {
  const geometry = object(value, 'boundary geometry');
  assert(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon', 'Boundary must be a Polygon or MultiPolygon');
  const raw = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  assert(Array.isArray(raw) && raw.length > 0 && raw.length <= 1024, 'Invalid or oversized boundary polygons');
  const polygons = raw.map(value => {
    assert(Array.isArray(value) && value.length > 0, 'Boundary polygon is empty');
    const outer = ring(value[0]);
    const center = (outer.box[0] + outer.box[2]) / 2;
    const rings = [outer, ...value.slice(1).map(value => ring(value, center))];
    for (const hole of rings.slice(1)) {
      assert(hole.points.every(point => contains(outer, point) === 'inside'), 'Boundary hole is not strictly inside its outer ring');
      for (const a of outer.edges) for (const b of hole.edges) assert(!intersects(a.a, a.b, b.a, b.b), 'Boundary hole crosses outer ring');
    }
    for (let i = 1; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
      assert(contains(rings[i], rings[j].points[0]) === 'outside' && contains(rings[j], rings[i].points[0]) === 'outside', 'Boundary holes overlap');
      for (const a of rings[i].edges) for (const b of rings[j].edges) assert(!intersects(a.a, a.b, b.a, b.b), 'Boundary holes cross');
    }
    return { rings, center, box: outer.box };
  });
  return { polygons };
}

/** Include a complete way when any segment touches covered land, including crossings with no interior vertex. */
export function touchesBoundary(points: PointE7[], geometry: BoundaryGeometry): boolean {
  assert(points.length >= 2, 'Road needs two points');
  for (const polygon of geometry.polygons) {
    for (let i = 1; i < points.length; i++) {
      const a: PointE7 = [wrap(points[i - 1][0], polygon.center), points[i - 1][1]];
      const b: PointE7 = [wrap(points[i][0], a[0]), points[i][1]];
      const extent = box(a, b);
      if (!overlaps(extent, polygon.box)) continue;
      for (const point of [a, b]) {
        const outer = contains(polygon.rings[0], point);
        if (outer === 'edge' || outer === 'inside' && polygon.rings.slice(1).every(hole => contains(hole, point) !== 'inside')) return true;
      }
      for (const ring of polygon.rings) for (const edge of ring.edges) {
        if (overlaps(extent, edge.box) && intersects(a, b, edge.a, edge.b)) return true;
      }
    }
  }
  return false;
}
