import { test } from 'node:test';
import strict from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import Pbf from 'pbf';
import { CityRoadChunk as codec } from '../src/proto/city.js';
import { decodeChunk, encodeChunk, geometryStats, manifestKey, roadPoints, validateChunk, validateManifest } from '../src/lib/data/city-cache.ts';
import type { CityManifest, CityRoadChunk } from '../src/lib/data/city-types.ts';
import { buildDataset, normalizeInput, sha256, stableJson } from '../tools/city-data/build.ts';
import type { CityInput } from '../tools/city-data/build.ts';
import { validateDataset, writeDataset } from '../tools/city-data/files.ts';
import { syntheticCity } from '../tools/city-data/fixtures.ts';

const edges: CityInput = JSON.parse(await readFile(new URL('./fixtures/schema-edges.json', import.meta.url), 'utf8'));
const keyOf = (manifest: CityManifest) => manifestKey(manifest.city_key, manifest.dataset_revision);

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-data-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function unchecked(chunk: CityRoadChunk): Uint8Array {
  const pbf = new Pbf();
  codec.write(chunk, pbf);
  return pbf.finish();
}

function joined(chunks: CityRoadChunk[]) {
  const ways = new Map<string, number[][]>();
  for (const chunk of chunks) for (const road of chunk.roads) {
    const points = ways.get(road.osm_way_id) ?? [];
    const fragment = roadPoints(road);
    points.push(...(road.fragment_index ? fragment.slice(1) : fragment));
    ways.set(road.osm_way_id, points);
  }
  return [...ways].sort(([a], [b]) => a.localeCompare(b));
}

test('E7, zero/negative coordinates, extrema, string IDs, tags and sint64 deltas survive round trips', () => {
  const built = buildDataset(edges, 3);
  const actual = built.chunks.map(chunk => decodeChunk(encodeChunk(chunk)));
  strict.deepEqual(actual, built.chunks);
  strict.equal(actual[0].city_key, edges.metadata.city_key);
  strict.ok(actual.flatMap(chunk => chunk.roads).some(road => road.coordinate_deltas_e7.includes(3_600_000_000)));
  strict.ok(actual.flatMap(chunk => chunk.roads).some(road => road.highway === 'future_road_class' && road.bridge && road.layer === -2));
  strict.deepEqual(joined(actual), joined([{ ...actual[0], roads: normalizeInput(edges).roads }]));
});

test('single and independent fragments preserve every segment and shared endpoint exactly', async () => {
  const input = syntheticCity(4);
  const single = buildDataset(input, 100);
  const split = buildDataset(input, 3);
  strict.deepEqual(joined(split.chunks), joined(single.chunks));
  strict.equal(split.manifest.unique_way_count, 4);
  strict.equal(split.manifest.segment_count, 32);
  strict.ok(split.manifest.point_count > single.manifest.point_count);
  await temporary(async root => {
    await writeDataset(root, split);
    const validated = await validateDataset(root, keyOf(split.manifest));
    strict.deepEqual(joined(validated.chunks), joined(single.chunks));
  });
});

test('source element/property order does not affect revisions or artifact bytes', () => {
  const first = syntheticCity(8);
  const reordered = JSON.parse(stableJson(first)) as CityInput;
  reordered.elements.reverse();
  const a = buildDataset(first, 20), b = buildDataset(reordered, 20);
  strict.equal(a.manifest.dataset_revision, b.manifest.dataset_revision);
  strict.deepEqual(a.objects, b.objects);
});

test('revision fingerprints the actual compressor environment', async () => {
  const input = syntheticCity(8);
  const current = buildDataset(input, 20);
  const actualVersion = process.versions.zlib;
  Object.defineProperty(process.versions, 'zlib', { value: 'different-encoder-test', configurable: true });
  try {
    const other = buildDataset(input, 20);
    strict.notEqual(other.manifest.dataset_revision, current.manifest.dataset_revision);
    strict.equal(other.manifest.encoding.zlib, 'different-encoder-test');
    await temporary(async root => {
      await writeDataset(root, current);
      await writeDataset(root, other);
      await validateDataset(root, keyOf(current.manifest));
      await validateDataset(root, keyOf(other.manifest));
    });
  } finally {
    Object.defineProperty(process.versions, 'zlib', { value: actualVersion, configurable: true });
  }
});

test('geometry, tags, source snapshot and chunk policy change revisions; build timestamp alone does not', () => {
  const input = syntheticCity(4);
  const revision = buildDataset(input, 20).manifest.dataset_revision;
  const timestamp = structuredClone(input);
  timestamp.metadata.built_at = '2026-10-07T01:00:00.000Z';
  strict.equal(buildDataset(timestamp, 20).manifest.dataset_revision, revision);
  const changed = structuredClone(input);
  (changed.elements.find(value => (value as { type: string }).type === 'node') as { lon: number }).lon += 0.001;
  strict.notEqual(buildDataset(changed, 20).manifest.dataset_revision, revision);
  const tagged = structuredClone(input);
  (tagged.elements.find(value => (value as { type: string }).type === 'way') as { tags: { highway: string } }).tags.highway = 'trunk';
  strict.notEqual(buildDataset(tagged, 20).manifest.dataset_revision, revision);
  const source = structuredClone(input);
  source.metadata.source.sha256 = 'a'.repeat(64);
  strict.notEqual(buildDataset(source, 20).manifest.dataset_revision, revision);
  strict.notEqual(buildDataset(input, 3).manifest.dataset_revision, revision);
});

const invalidInputs: [string, (input: CityInput) => void, RegExp][] = [
  ['missing middle node', input => { input.elements = input.elements.filter(e => (e as { id: string }).id !== '2'); }, /missing node 2/],
  ['numeric ID', input => { (input.elements[0] as { id: unknown }).id = 9007199254740992; }, /string ID/],
  ['duplicate node', input => { input.elements.push(input.elements[0]); }, /Duplicate node/],
  ['duplicate way', input => { input.elements.push(input.elements.at(-1)); }, /Duplicate way/],
  ['out-of-range latitude', input => { (input.elements[0] as { lat: number }).lat = 91; }, /latitude/],
  ['nonfinite longitude', input => { (input.elements[0] as { lon: number }).lon = NaN; }, /longitude/],
  ['empty roads', input => { input.elements = []; }, /no road/],
  ['identifier mismatch', input => { input.metadata.boundary.osm_id = '7'; }, /does not match/],
  ['missing road class', input => { (input.elements.at(-1) as { tags: { highway: string } }).tags.highway = ''; }, /highway/],
  ['invalid layer', input => { (input.elements.at(-1) as { tags: { layer: string } }).tags.layer = '1.5'; }, /layer/],
  ['ambiguous extraction policy', input => { (input.metadata.boundary as { policy: string }).policy = 'clipped'; }, /boundary policy/],
];
for (const [name, mutate, error] of invalidInputs) test(`generator rejects ${name}`, () => {
  const input = structuredClone(edges);
  mutate(input);
  strict.throws(() => buildDataset(input), error);
});

test('decoder skips unknown protobuf fields and rejects invalid semantic values', () => {
  const chunk = buildDataset(edges).chunks[0];
  const pbf = new Pbf();
  codec.write(chunk, pbf);
  pbf.writeStringField(100, 'future metadata');
  strict.deepEqual(decodeChunk(pbf.finish()), chunk);
  for (const mutate of [
    (c: CityRoadChunk) => { c.schema_version = 1; },
    (c: CityRoadChunk) => { c.chunk_count = 0; },
    (c: CityRoadChunk) => { c.detail_level = 2; },
    (c: CityRoadChunk) => { c.roads[0].coordinate_deltas_e7 = [1]; },
    (c: CityRoadChunk) => { c.roads[0].coordinate_deltas_e7 = []; },
    (c: CityRoadChunk) => { c.roads[0].first_lat_e7 = 900_000_001; },
    (c: CityRoadChunk) => { c.roads.push(c.roads[0]); },
  ]) {
    const corrupt = structuredClone(chunk);
    mutate(corrupt);
    strict.throws(() => decodeChunk(unchecked(corrupt)));
  }
  strict.throws(() => decodeChunk(new Uint8Array()));
  strict.throws(() => validateChunk({ ...chunk, roads: [] }));
});

test('manifest rejects unsupported versions, unsafe/mixed keys, duplicate indices and inconsistent totals', () => {
  const original = buildDataset(edges, 3).manifest;
  for (const mutate of [
    (m: CityManifest) => { (m as { manifest_version: number }).manifest_version = 2; },
    (m: CityManifest) => { (m as { schema_version: number }).schema_version = 1; },
    (m: CityManifest) => { m.chunks[0].key = '../../secret'; },
    (m: CityManifest) => { m.chunks[0].key = m.chunks[0].key.replace(m.dataset_revision, 'b'.repeat(64)); },
    (m: CityManifest) => { m.chunks[1].index = 0; },
    (m: CityManifest) => { m.segment_count++; },
    (m: CityManifest) => { m.chunks[0].decoded_bytes = 100_000_000; },
    (m: CityManifest) => { m.chunks[0].stored_sha256 = ''; },
    (m: CityManifest) => { m.attribution.text = ''; },
    (m: CityManifest) => { m.bounds = [180, 0, -180, 1]; },
  ]) {
    const manifest = structuredClone(original);
    mutate(manifest);
    strict.throws(() => validateManifest(manifest));
  }
});

test('local writer is idempotent, records required R2 headers/order and preserves immutable objects', async () => temporary(async root => {
  const input = syntheticCity(2);
  const built = buildDataset(input, 5);
  const planKey = await writeDataset(root, built);
  await writeDataset(root, built);
  await validateDataset(root, keyOf(built.manifest));
  const plan = JSON.parse(await readFile(path.join(root, planKey), 'utf8'));
  strict.equal(plan.objects[0].headers['Content-Encoding'], 'gzip');
  strict.equal(plan.objects[0].headers['Content-Type'], 'application/x-protobuf');
  strict.match(plan.objects[0].headers['Cache-Control'], /immutable/);
  strict.equal(plan.objects.at(-2).key, keyOf(built.manifest));
  strict.match(plan.objects.at(-1).key, /latest.json$/);
  strict.match(plan.objects.at(-1).headers['Cache-Control'], /max-age=60/);
  const before = await readFile(path.join(root, keyOf(built.manifest)));
  input.metadata.built_at = '2026-10-07T01:00:00.000Z';
  await strict.rejects(writeDataset(root, buildDataset(input, 5)), /Refusing to overwrite immutable/);
  strict.deepEqual(await readFile(path.join(root, keyOf(built.manifest))), before);
}));

test('file validator rejects changed stored bytes and wrong decoded hashes', async () => temporary(async root => {
  const built = buildDataset(edges);
  await writeDataset(root, built);
  const descriptor = built.manifest.chunks[0];
  const file = path.join(root, descriptor.key);
  const original = await readFile(file);
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(file, corrupt);
  await strict.rejects(validateDataset(root, keyOf(built.manifest)), /Stored chunk/);
  await writeFile(file, original);
  descriptor.decoded_sha256 = '0'.repeat(64);
  await writeFile(path.join(root, keyOf(built.manifest)), stableJson(built.manifest));
  await strict.rejects(validateDataset(root, keyOf(built.manifest)), /Decoded chunk/);
}));

test('writer preserves the previous pointer when a new revision fails read-back validation', async () => temporary(async root => {
  const input = syntheticCity(2);
  const first = buildDataset(input, 5);
  await writeDataset(root, first);
  const pointerFile = path.join(root, `v2/cities/${input.metadata.city_key}/latest.json`);
  const previous = await readFile(pointerFile);
  input.metadata.source.sha256 = 'c'.repeat(64);
  const next = buildDataset(input, 5);
  const bytes = Buffer.from(next.objects[0].bytes);
  bytes[bytes.length - 1] ^= 1;
  next.objects[0].bytes = bytes;
  await strict.rejects(writeDataset(root, next), /Stored chunk/);
  strict.deepEqual(await readFile(pointerFile), previous);
}));

// Rehash a deliberately changed payload so checks reach identity/fragment validation.
async function rewriteChunk(root: string, manifest: CityManifest, index: number, mutate: (chunk: CityRoadChunk) => void) {
  const descriptor = manifest.chunks[index];
  const chunk = decodeChunk(gunzipSync(await readFile(path.join(root, descriptor.key))));
  mutate(chunk);
  const decoded = encodeChunk(chunk), wire = gzipSync(decoded, { level: 9 });
  Object.assign(descriptor, geometryStats(chunk.roads), {
    decoded_bytes: decoded.byteLength, wire_bytes: wire.byteLength,
    decoded_sha256: sha256(decoded), stored_sha256: sha256(wire),
  });
  await writeFile(path.join(root, descriptor.key), wire);
  const chunks = await Promise.all(manifest.chunks.map(async descriptor => decodeChunk(gunzipSync(await readFile(path.join(root, descriptor.key))))));
  Object.assign(manifest, geometryStats(chunks.flatMap(chunk => chunk.roads)));
  await writeFile(path.join(root, keyOf(manifest)), stableJson(manifest));
}

const invalidChunks: [string, (chunk: CityRoadChunk) => void, RegExp][] = [
  ['mixed city', c => { c.city_key = 'osm-relation-7'; }, /identity\/detail/],
  ['mixed revision', c => { c.dataset_revision = 'a'.repeat(64); }, /identity\/detail/],
  ['incorrect count', c => { c.chunk_count++; }, /identity\/detail/],
  ['overview detail', c => { c.detail_level = 1; }, /identity\/detail/],
  ['duplicate fragment', c => { c.roads[0].fragment_index = 0; }, /Duplicate fragment across/],
  ['missing fragment', c => { c.roads[0].fragment_index = 8; }, /not contiguous/],
  ['disconnected fragment', c => { c.roads[0].first_lon_e7++; }, /disconnected/],
  ['inconsistent tags', c => { c.roads[0].highway = 'path'; }, /tags differ/],
];
for (const [name, mutate, error] of invalidChunks) test(`file validator rejects ${name} after valid checksums`, async () => temporary(async root => {
  const built = buildDataset(syntheticCity(1), 3);
  await writeDataset(root, built);
  await rewriteChunk(root, built.manifest, 1, mutate);
  await strict.rejects(validateDataset(root, keyOf(built.manifest)), error);
}));

test('gzip expansion is bounded and manifest paths cannot follow symlinks outside the data root', async () => temporary(async root => {
  const built = buildDataset(edges);
  await writeDataset(root, built);
  built.manifest.chunks[0].decoded_bytes--;
  await writeFile(path.join(root, keyOf(built.manifest)), stableJson(built.manifest));
  await strict.rejects(validateDataset(root, keyOf(built.manifest)), /larger than|size|length/i);
  await rm(path.join(root, built.manifest.chunks[0].key));
  await symlink(new URL('./fixtures/schema-edges.json', import.meta.url), path.join(root, built.manifest.chunks[0].key));
  await strict.rejects(validateDataset(root, keyOf(built.manifest)), /escapes data root/);
}));
