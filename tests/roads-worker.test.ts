import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { buildDataset } from '../tools/city-data/build.ts';
import type { WorkerLoad, WorkerResult } from '../src/lib/worker-protocol.ts';

const metadata = {
  city_key: 'osm-relation-77', name: 'Antimeridian test', country: 'FJ', area_ids: [],
  source: { kind: 'osm-extract', url: 'https://example.com/region.osm.pbf', sha256: 'a'.repeat(64), snapshot_at: '2026-10-01T00:00:00.000Z' },
  boundary: { osm_type: 'relation', osm_id: '77', version: '1', sha256: 'b'.repeat(64), policy: 'preselected-complete-ways' },
  built_at: '2026-10-02T00:00:00.000Z',
};
// Roads on both sides of, and across, the antimeridian.
const lons = [179.9, 179.95, 179.99, -179.99, -179.95, -179.9];
const elements = [
  ...lons.flatMap((lon, i) => [{ type: 'node', id: String(i + 1), lon, lat: -16.5 }, { type: 'node', id: String(i + 11), lon, lat: -16.4 }]),
  ...lons.map((_lon, i) => ({ type: 'way', id: String(100 + i), nodes: [String(i + 1), String(i + 11)], tags: { highway: 'residential' } })),
  { type: 'way', id: '200', nodes: lons.map((_lon, i) => String(i + 1)), tags: { highway: 'primary' } },
];
const dataset = buildDataset({ metadata, elements }, 4);
const base = 'https://data.example.com';
const overpass = 'http://localhost/roads';
const liveRoads = { elements: [{ type: 'node', id: 1, lon: 7.42, lat: 43.73 }, { type: 'node', id: 2, lon: 7.43, lat: 43.74 }, { type: 'way', id: 3, nodes: [1, 2] }] };

type Route = (url: string) => Response | Promise<Response>;
async function run(t: TestContext, load: Partial<WorkerLoad>, route: Route) {
  const messages: WorkerResult[] = [];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const scope = { onmessage: undefined as undefined | ((event: { data: unknown }) => void), postMessage(message: WorkerResult) { messages.push(message); if (message.type === 'done' || message.type === 'error') finish(); } };
  Object.defineProperty(globalThis, 'self', { value: scope, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, 'self'); });
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { requests.push(url); return route(url); });
  // A fresh module instance per run, as each load uses a new worker.
  await import(`../src/workers/roads.worker.ts?run=${Math.random()}`);
  scope.onmessage!({ data: { boundary: { key: metadata.city_key, name: 'Test', kind: 'city', areaId: '3600000077' }, providers: { cityDataBase: base, legacyCacheBase: '', overpass, search: '' }, useCache: true, allowLarge: true, detail: 'streets', ...load } });
  await finished;
  return { messages, requests };
}
// Browsers decode Content-Encoding: gzip before the worker reads the body.
const r2: Route = url => {
  const object = dataset.objects.find(candidate => `${base}/${candidate.key}` === url);
  if (!object) return new Response('{}', { status: 404 });
  return new Response(new Uint8Array(object.headers['Content-Encoding'] ? gunzipSync(object.bytes) : object.bytes));
};

test('antimeridian datasets project with the wrapped extent and one origin', async t => {
  assert.ok(dataset.manifest.chunks.length > 2);
  assert.ok(dataset.manifest.bounds[2] - dataset.manifest.bounds[0] > 180);
  const { messages } = await run(t, {}, r2);
  const chunks = messages.filter(message => message.type === 'chunk');
  // Each dataset chunk arrives as one message per road rank, major roads first.
  assert.deepEqual([...new Set(chunks.map(chunk => chunk.index))], dataset.manifest.chunks.map(chunk => chunk.index));
  for (const index of new Set(chunks.map(chunk => chunk.index))) { const ranks = chunks.filter(chunk => chunk.index === index).map(chunk => chunk.rank); assert.deepEqual(ranks, [...ranks].sort()); }
  assert.equal(new Set(chunks.map(chunk => JSON.stringify(chunk.origin))).size, 1);
  assert.ok(Math.abs(Math.abs(chunks[0].origin[0]) - 180) < 1e-9);
  // 0.2 degrees of longitude is about 22 km in scene units, plus padding.
  const bounds = chunks[0].bounds;
  assert.ok(bounds.right - bounds.left > 22_000 && bounds.right - bounds.left < 40_000);
  for (const chunk of chunks) {
    const positions = new Float32Array(chunk.positions);
    for (let i = 0; i < positions.length; i += 2) assert.ok(positions[i] > bounds.left && positions[i] < bounds.right);
  }
  const done = messages.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') { assert.equal(done.source.kind, 'r2'); assert.equal(done.segmentCount, dataset.manifest.segment_count); assert.equal(done.coverage, 'all'); }
});

test('chunk downloads overlap within a bounded window and stay in manifest order', async t => {
  let active = 0, peak = 0;
  const { messages } = await run(t, {}, async url => {
    if (!url.endsWith('.pbf')) return r2(url);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return r2(url);
  });
  assert.equal(messages.at(-1)!.type, 'done');
  assert.equal(peak, 3);
});

for (const [name, failure] of [
  ['a network or CORS failure', () => { throw new TypeError('Failed to fetch'); }],
  ['a server error', () => new Response('', { status: 500 })],
  ['an invalid pointer', () => new Response('{"pointer_version":9}')],
] as [string, () => Response][]) test(`${name} before a revision is selected falls back to live roads`, async t => {
  const { messages, requests } = await run(t, {}, url => url === overpass ? new Response(JSON.stringify(liveRoads)) : url.endsWith('/latest.json') ? failure() : r2(url));
  assert.ok(messages.some(message => message.type === 'progress' && /Loading live roads/.test(message.progress.message)));
  assert.ok(requests.includes(overpass));
  const done = messages.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') { assert.equal(done.source.kind, 'live'); assert.equal(done.coverage, 'streets'); }
});

test('a selected revision that later fails does not fall back to live roads', async t => {
  const manifest = `${base}/v2/cities/${metadata.city_key}/${dataset.manifest.dataset_revision}/manifest.json`;
  const { messages, requests } = await run(t, {}, url => url === manifest ? new Response('', { status: 500 }) : r2(url));
  assert.equal(messages.at(-1)!.type, 'error');
  assert.ok(!requests.includes(overpass));
});

test('a bundled-only data origin serves its own cities and is never probed for others', async t => {
  const shipped = 'http://app.example.com/data';
  const fromShipped: Route = async url => url.startsWith(`${shipped}/`) ? new Response(new Uint8Array(await readFile(new URL(`../public/data/${url.slice(shipped.length + 1)}`, import.meta.url)))) : new Response(JSON.stringify(liveRoads));
  const providers = { cityDataBase: shipped, cityDataBundled: true, legacyCacheBase: '', overpass, search: '' };
  const monaco = await run(t, { boundary: { key: 'osm-relation-1124039', name: 'Monaco', kind: 'city', areaId: '3601124039' }, providers }, fromShipped);
  const done = monaco.messages.at(-1)!;
  assert.ok(done.type === 'done' && done.source.kind === 'r2' && done.source.bundled === true && done.segmentCount === 15369);
  assert.ok(!monaco.requests.includes(overpass));
  const other = await run(t, { boundary: { key: 'osm-relation-77', name: 'Elsewhere', kind: 'city', areaId: '3600000077' }, providers }, fromShipped);
  assert.deepEqual(other.requests, [overpass]);
  assert.equal(other.messages.at(-1)!.type, 'done');
});
