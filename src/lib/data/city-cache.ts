import Pbf from 'pbf';
import { CityRoadChunk as codec } from '../../proto/city.js';
import type { Bounds, CityManifest, CityMetadata, CityRoadChunk, GeometryStats, PointE7, RoadPolyline } from './city-types.ts';

export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const CITY_KEY = /^osm-(node|way|relation)-[1-9][0-9]*$/;
const OSM_ID = /^[1-9][0-9]*$/;
const HASH = /^[a-f0-9]{64}$/;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 4096, `${name} must be a nonempty string`);
}

export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be an integer in ${min}..${max}`);
}

export function osmId(value: unknown, name: string): asserts value is string {
  assert(typeof value === 'string' && OSM_ID.test(value) && value.length <= 32, `${name} must be a positive decimal string ID`);
}

export function sha256Value(value: unknown, name: string): asserts value is string {
  assert(typeof value === 'string' && HASH.test(value), `${name} must be a SHA-256 hex string`);
}

function timestamp(value: unknown, name: string) {
  text(value, name);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `${name} must be a canonical UTC timestamp`);
}

export function validateMetadata(value: unknown): asserts value is CityMetadata {
  const m = object(value, 'metadata');
  assert(typeof m.city_key === 'string' && CITY_KEY.test(m.city_key), 'Invalid typed city_key');
  text(m.name, 'name');
  assert(typeof m.country === 'string' && /^[A-Z]{2}$/.test(m.country), 'country must be a two-letter uppercase code');
  assert(Array.isArray(m.area_ids), 'area_ids must be an array of explicit aliases');
  m.area_ids.forEach(id => osmId(id, 'area ID'));
  assert(new Set(m.area_ids).size === m.area_ids.length, 'Duplicate area ID alias');
  const s = object(m.source, 'source');
  assert(s.kind === 'synthetic' || s.kind === 'osm-extract', 'Unsupported source kind');
  text(s.url, 'source URL');
  assert(new URL(s.url).protocol === 'https:', 'Source URL must use HTTPS');
  sha256Value(s.sha256, 'source checksum');
  timestamp(s.snapshot_at, 'source snapshot');
  const b = object(m.boundary, 'boundary');
  assert(['node', 'way', 'relation'].includes(String(b.osm_type)), 'Invalid boundary type');
  osmId(b.osm_id, 'boundary ID');
  osmId(b.version, 'boundary version');
  assert(m.city_key === `osm-${b.osm_type}-${b.osm_id}`, 'Boundary identifier does not match city_key');
  sha256Value(b.sha256, 'boundary checksum');
  assert(b.policy === 'preselected-complete-ways', 'Unsupported boundary policy');
  timestamp(m.built_at, 'build timestamp');
  assert(Date.parse(m.built_at as string) >= Date.parse(s.snapshot_at as string), 'Build timestamp precedes source snapshot');
}

export function validateBounds(value: unknown): asserts value is Bounds {
  assert(Array.isArray(value) && value.length === 4 && value.every(Number.isFinite), 'Invalid bounds');
  const [w, s, e, n] = value as number[];
  assert(w >= -180 && e <= 180 && w <= e && s >= -90 && n <= 90 && s <= n, 'Bounds must be canonical [west, south, east, north]');
}

export function chunkKey(cityKey: string, revision: string, index: number) {
  return `v2/cities/${cityKey}/${revision}/full/${String(index).padStart(5, '0')}.pbf`;
}

export function manifestKey(cityKey: string, revision: string) {
  return `v2/cities/${cityKey}/${revision}/manifest.json`;
}

function validateStats(value: Record<string, unknown>) {
  validateBounds(value.bounds);
  integer(value.road_fragment_count, 'road fragment count', 1);
  integer(value.unique_way_count, 'unique way count', 1, value.road_fragment_count);
  integer(value.point_count, 'point count', 2);
  integer(value.segment_count, 'segment count', 1);
  assert(value.segment_count === value.point_count - value.road_fragment_count, 'Point/segment counts disagree');
}

export function validateManifest(value: unknown): asserts value is CityManifest {
  validateMetadata(value);
  const m = value as unknown as Record<string, unknown>;
  assert(m.manifest_version === 1, 'Unsupported manifest version');
  assert(m.schema_version === 2, 'Unsupported data schema version');
  sha256Value(m.dataset_revision, 'dataset revision');
  text(m.builder, 'builder');
  const encoding = object(m.encoding, 'encoding');
  text(encoding.protobuf, 'protobuf encoder');
  text(encoding.zlib, 'gzip encoder');
  assert(encoding.gzip_level === 9, 'Unsupported gzip level');
  integer(encoding.gzip_os, 'gzip OS marker', 0, 255);
  integer(m.max_points_per_chunk, 'max_points_per_chunk', 2, 1_000_000);
  assert(m.coordinate_encoding === 'e7-delta' && m.longitude_convention === 'canonical-minus180-to180', 'Unsupported coordinate convention');
  assert(JSON.stringify(m.detail_levels) === '["full"]', 'Only full detail is supported by this generator');
  assert(JSON.stringify(m.retained_tags) === '["highway","bridge","tunnel","layer"]', 'Unsupported retained tag declaration');
  const a = object(m.attribution, 'attribution');
  assert(a.text === '© OpenStreetMap contributors' && a.url === 'https://www.openstreetmap.org/copyright' && a.license === 'ODbL-1.0', 'Missing OSM attribution/license');
  validateStats(m);
  assert(Array.isArray(m.chunks) && m.chunks.length > 0 && m.chunks.length <= 100_000, 'Invalid chunk list');
  let points = 0, segments = 0, fragments = 0;
  m.chunks.forEach((value, index) => {
    const c = object(value, 'chunk descriptor');
    assert(c.index === index, 'Chunks must have unique, contiguous ordered indices');
    assert(c.key === chunkKey(m.city_key as string, m.dataset_revision as string, index), 'Chunk key does not match immutable city/revision path');
    assert(c.content_encoding === 'gzip', 'Unsupported compression');
    integer(c.wire_bytes, 'wire bytes', 1, MAX_CHUNK_BYTES);
    integer(c.decoded_bytes, 'decoded bytes', 1, MAX_CHUNK_BYTES);
    integer(c.estimated_processing_bytes, 'estimated processing bytes', c.decoded_bytes);
    sha256Value(c.stored_sha256, 'stored checksum');
    sha256Value(c.decoded_sha256, 'decoded checksum');
    validateStats(c);
    assert((c.point_count as number) <= (m.max_points_per_chunk as number), 'Chunk exceeds declared point budget');
    points += c.point_count as number;
    segments += c.segment_count as number;
    fragments += c.road_fragment_count as number;
  });
  assert(m.point_count === points && m.segment_count === segments && m.road_fragment_count === fragments, 'Manifest totals disagree with chunk totals');
}

function coordinate(lon: unknown, lat: unknown) {
  integer(lon, 'longitude E7', -1_800_000_000, 1_800_000_000);
  integer(lat, 'latitude E7', -900_000_000, 900_000_000);
}

export function roadPoints(road: RoadPolyline): PointE7[] {
  coordinate(road.first_lon_e7, road.first_lat_e7);
  let lon = road.first_lon_e7, lat = road.first_lat_e7;
  const points: PointE7[] = [[lon, lat]];
  assert(Array.isArray(road.coordinate_deltas_e7) && road.coordinate_deltas_e7.length >= 2 && road.coordinate_deltas_e7.length % 2 === 0, 'Road must have paired deltas and at least two points');
  for (let i = 0; i < road.coordinate_deltas_e7.length; i += 2) {
    const dx = road.coordinate_deltas_e7[i], dy = road.coordinate_deltas_e7[i + 1];
    integer(dx, 'longitude delta', -3_600_000_000, 3_600_000_000);
    integer(dy, 'latitude delta', -1_800_000_000, 1_800_000_000);
    lon += dx;
    lat += dy;
    coordinate(lon, lat);
    points.push([lon, lat]);
  }
  return points;
}

export function validateChunk(value: unknown): asserts value is CityRoadChunk {
  const c = object(value, 'decoded chunk');
  assert(c.schema_version === 2, 'Unsupported chunk schema version');
  assert(typeof c.city_key === 'string' && CITY_KEY.test(c.city_key), 'Invalid chunk city_key');
  sha256Value(c.dataset_revision, 'chunk revision');
  integer(c.chunk_count, 'chunk count', 1, 100_000);
  integer(c.chunk_index, 'chunk index', 0, c.chunk_count - 1);
  integer(c.detail_level, 'detail level', 0, 1);
  assert(Array.isArray(c.roads) && c.roads.length > 0, 'Chunk contains no roads');
  const fragments = new Set<string>();
  c.roads.forEach(value => {
    const r = object(value, 'road');
    osmId(r.osm_way_id, 'way ID');
    text(r.highway, 'highway');
    integer(r.fragment_index, 'fragment index', 0, 0xffffffff);
    integer(r.layer, 'layer', -0x80000000, 0x7fffffff);
    assert(typeof r.bridge === 'boolean' && typeof r.tunnel === 'boolean', 'Invalid bridge/tunnel flags');
    const key = `${r.osm_way_id}/${r.fragment_index}`;
    assert(!fragments.has(key), 'Duplicate way fragment');
    fragments.add(key);
    roadPoints(value as RoadPolyline);
  });
}

export function encodeChunk(chunk: CityRoadChunk): Uint8Array {
  validateChunk(chunk);
  const pbf = new Pbf();
  codec.write(chunk, pbf);
  const bytes = pbf.finish();
  assert(bytes.byteLength <= MAX_CHUNK_BYTES, 'Encoded chunk exceeds decoded byte limit; reduce point budget');
  return bytes;
}

// Call with browser-decompressed bytes; checksum verification belongs to the manifest loader.
export function decodeChunk(bytes: Uint8Array): CityRoadChunk {
  assert(bytes.byteLength > 0 && bytes.byteLength <= MAX_CHUNK_BYTES, 'Invalid decoded chunk byte size');
  const pbf = new Pbf(bytes);
  const chunk = codec.read(pbf);
  assert(pbf.pos === bytes.byteLength, 'Incomplete protobuf read');
  validateChunk(chunk);
  return chunk;
}

export function geometryStats(roads: RoadPolyline[]): GeometryStats {
  assert(roads.length > 0, 'No road geometry');
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity, pointCount = 0;
  const ways = new Set<string>();
  for (const road of roads) {
    ways.add(road.osm_way_id);
    for (const [lon, lat] of roadPoints(road)) {
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
      pointCount++;
    }
  }
  return {
    bounds: [west / 1e7, south / 1e7, east / 1e7, north / 1e7],
    road_fragment_count: roads.length,
    unique_way_count: ways.size,
    point_count: pointCount,
    segment_count: pointCount - roads.length,
  };
}
