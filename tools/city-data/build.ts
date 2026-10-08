import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { assert, encodeChunk, geometryStats, integer, manifestKey, chunkKey, object, osmId, roadPoints, text, validateManifest, validateMetadata } from '../../src/lib/data/city-cache.ts';
import type { CityManifest, CityMetadata, CityRoadChunk, PointE7, RoadPolyline } from '../../src/lib/data/city-types.ts';

export const BUILDER = 'citymap-v2-local/2';
export const DEFAULT_POINT_BUDGET = 262_144;
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const POINTER_CACHE = 'public, max-age=60, must-revalidate';
const PBF_VERSION: string = createRequire(import.meta.url)('pbf/package.json').version;

export interface CityInput {
  metadata: CityMetadata;
  elements: unknown[];
}

export interface DatasetObject {
  key: string;
  bytes: Uint8Array;
  immutable: boolean;
  headers: { 'Content-Type': string; 'Cache-Control': string; 'Content-Encoding'?: string };
}

export interface BuiltDataset {
  manifest: CityManifest;
  chunks: CityRoadChunk[];
  objects: DatasetObject[];
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Object property order in source JSON must not affect revisions or artifact bytes.
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]]));
    }
    return v;
  });
}

function decimalOrder(a: string, b: string) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function flag(value: unknown): boolean {
  if (value === undefined) return false;
  text(value, 'bridge/tunnel tag');
  return !['no', 'false', '0'].includes(value);
}

export function roadTags(value: unknown, wayId: string): Pick<RoadPolyline, 'osm_way_id' | 'highway' | 'bridge' | 'tunnel' | 'layer'> {
  const tags = object(value, 'way tags');
  text(tags.highway, 'highway');
  let layer = 0;
  if (tags.layer !== undefined) {
    assert(typeof tags.layer === 'string' && /^-?\d+$/.test(tags.layer), 'layer tag must be an integer string');
    layer = Number(tags.layer); integer(layer, 'layer', -0x80000000, 0x7fffffff);
  }
  return { osm_way_id: wayId, highway: tags.highway, bridge: flag(tags.bridge), tunnel: flag(tags.tunnel), layer };
}

export function polyline(points: PointE7[], tags: Pick<RoadPolyline, 'osm_way_id' | 'highway' | 'bridge' | 'tunnel' | 'layer'>, fragmentIndex = 0): RoadPolyline {
  assert(points.length >= 2, 'A road needs at least two points');
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return {
    osm_way_id: tags.osm_way_id,
    highway: tags.highway,
    bridge: tags.bridge,
    tunnel: tags.tunnel,
    layer: tags.layer,
    first_lon_e7: points[0][0],
    first_lat_e7: points[0][1],
    coordinate_deltas_e7: deltas,
    fragment_index: fragmentIndex,
  };
}

export function normalizeInput(value: unknown): { metadata: CityMetadata; roads: RoadPolyline[] } {
  const input = object(value, 'input');
  validateMetadata(input.metadata);
  assert(Array.isArray(input.elements), 'elements must be an array');
  const nodes = new Map<string, PointE7>();
  const ways: Record<string, unknown>[] = [];
  const wayIds = new Set<string>();
  for (const value of input.elements) {
    const element = object(value, 'element');
    osmId(element.id, 'element ID');
    if (element.type === 'node') {
      assert(!nodes.has(element.id), `Duplicate node ${element.id}`);
      assert(typeof element.lon === 'number' && Number.isFinite(element.lon) && element.lon >= -180 && element.lon <= 180, `Invalid longitude for node ${element.id}`);
      assert(typeof element.lat === 'number' && Number.isFinite(element.lat) && element.lat >= -90 && element.lat <= 90, `Invalid latitude for node ${element.id}`);
      nodes.set(element.id, [Math.round(element.lon * 1e7) || 0, Math.round(element.lat * 1e7) || 0]);
    } else if (element.type === 'way') {
      assert(!wayIds.has(element.id), `Duplicate way ${element.id}`);
      wayIds.add(element.id);
      ways.push(element);
    } else {
      throw new Error('Input must contain only preselected road ways and their nodes');
    }
  }
  assert(ways.length > 0, 'Input contains no road ways');
  const roads = ways.map(way => {
    assert(Array.isArray(way.nodes) && way.nodes.length >= 2, `Way ${way.id} needs at least two node references`);
    const points = way.nodes.map(id => {
      osmId(id, 'node reference');
      const point = nodes.get(id);
      assert(point, `Way ${way.id} references missing node ${id}`);
      return point;
    });
    return polyline(points, roadTags(way.tags, way.id as string));
  });
  // Stable spatial ordering; these chunks are independent polylines, not map tiles.
  roads.sort((a, b) => a.first_lon_e7 - b.first_lon_e7 || a.first_lat_e7 - b.first_lat_e7 || decimalOrder(a.osm_way_id, b.osm_way_id));
  const metadata = structuredClone(input.metadata);
  metadata.area_ids.sort(decimalOrder);
  return { metadata, roads };
}

export function splitRoads(roads: RoadPolyline[], maxPoints: number): RoadPolyline[][] {
  integer(maxPoints, 'max points per chunk', 2, 1_000_000);
  const groups: RoadPolyline[][] = [];
  let current: RoadPolyline[] = [], pointCount = 0;
  for (const road of roads) {
    const points = roadPoints(road);
    let fragment = 0;
    for (let start = 0; start < points.length - 1; start += maxPoints - 1) {
      const part = points.slice(start, start + maxPoints);
      if (pointCount + part.length > maxPoints) {
        groups.push(current);
        current = [];
        pointCount = 0;
      }
      current.push(polyline(part, road, fragment++));
      pointCount += part.length;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

export function buildDataset(input: unknown, maxPoints = DEFAULT_POINT_BUDGET): BuiltDataset {
  const { metadata, roads } = normalizeInput(input);
  const grouped = splitRoads(roads, maxPoints);
  const { built_at: _buildTimestamp, ...revisionMetadata } = metadata;
  const encoding = {
    protobuf: `pbf/${PBF_VERSION}`, gzip_level: 9 as const,
    zlib: process.versions.zlib, gzip_os: gzipSync(new Uint8Array(), { level: 9 })[9],
  };
  // Fingerprint real encoded output with a fixed revision placeholder to avoid a circular hash.
  // Encoder versions also prevent runtime-dependent gzip bytes from sharing immutable keys.
  const chunkFingerprints = grouped.map((roads, index) => sha256(gzipSync(encodeChunk({
    schema_version: 2, city_key: metadata.city_key, dataset_revision: '0'.repeat(64),
    chunk_index: index, chunk_count: grouped.length, detail_level: 0, roads,
  }), { level: 9 })));
  const revision = sha256(stableJson({ schema_version: 2, builder: BUILDER, encoding, maxPoints, metadata: revisionMetadata, chunkFingerprints }));
  const chunks: CityRoadChunk[] = grouped.map((roads, index) => ({
    schema_version: 2,
    city_key: metadata.city_key,
    dataset_revision: revision,
    chunk_index: index,
    chunk_count: grouped.length,
    detail_level: 0,
    roads,
  }));
  const objects: DatasetObject[] = [];
  const descriptors = chunks.map(chunk => {
    const decoded = encodeChunk(chunk);
    const wire = gzipSync(decoded, { level: 9 });
    const key = chunkKey(metadata.city_key, revision, chunk.chunk_index);
    const stats = geometryStats(chunk.roads);
    objects.push({
      key, bytes: wire, immutable: true,
      headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', 'Cache-Control': IMMUTABLE_CACHE },
    });
    return {
      ...stats,
      index: chunk.chunk_index,
      key,
      content_encoding: 'gzip' as const,
      wire_bytes: wire.byteLength,
      decoded_bytes: decoded.byteLength,
      stored_sha256: sha256(wire),
      decoded_sha256: sha256(decoded),
      // Conservative heuristic for a JS decoder, not a measured memory bound.
      estimated_processing_bytes: decoded.byteLength * 3 + stats.point_count * 64 + stats.road_fragment_count * 256,
    };
  });
  const manifest: CityManifest = {
    ...metadata,
    ...geometryStats(grouped.flat()),
    manifest_version: 1,
    schema_version: 2,
    dataset_revision: revision,
    builder: BUILDER,
    encoding,
    max_points_per_chunk: maxPoints,
    coordinate_encoding: 'e7-delta',
    longitude_convention: 'canonical-minus180-to180',
    detail_levels: ['full'],
    retained_tags: ['highway', 'bridge', 'tunnel', 'layer'],
    attribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL-1.0' },
    chunks: descriptors,
  };
  validateManifest(manifest);
  const manifestBytes = Buffer.from(stableJson(manifest) + '\n');
  const key = manifestKey(metadata.city_key, revision);
  objects.push({ key, bytes: manifestBytes, immutable: true, headers: { 'Content-Type': 'application/json', 'Cache-Control': IMMUTABLE_CACHE } });
  const pointer = {
    pointer_version: 1, city_key: metadata.city_key, dataset_revision: revision,
    manifest: key, manifest_sha256: sha256(manifestBytes),
  };
  objects.push({
    key: `v2/cities/${metadata.city_key}/latest.json`, bytes: Buffer.from(stableJson(pointer) + '\n'), immutable: false,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': POINTER_CACHE },
  });
  return { manifest, chunks, objects };
}
