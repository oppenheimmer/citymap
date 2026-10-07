import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildDataset, sha256 } from '../tools/city-data/build.ts';
import { writeDataset } from '../tools/city-data/files.ts';
import { syntheticCity } from '../tools/city-data/fixtures.ts';
import { publishCity, publishDatasets, catalogObjects, preparePublication } from '../tools/city-data/publish.ts';
import type { PublisherClient } from '../tools/city-data/publish.ts';
import { R2 } from '../server/r2.ts';
import { gzipSync } from 'node:zlib';
import type { R2Response } from '../server/r2.ts';
import { manifestKey } from '../src/lib/data/city-cache.ts';

class FakeR2 implements PublisherClient {
  values = new Map<string, { body: Buffer; headers: Headers }>();
  writes: string[] = [];
  version = 0;
  corrupt?: string;
  fail?: string;
  concurrent?: string;
  wrongHeader?: string;
  async request(method: 'GET' | 'HEAD' | 'PUT', key: string, body?: Buffer, headers: Record<string, string> = {}): Promise<R2Response> {
    const old = this.values.get(key);
    if (method !== 'PUT') {
      const stored = old && Buffer.from(old.body);
      if (stored && key === this.corrupt) stored[0] ^= 1;
      const resultHeaders = new Headers(old?.headers);
      if (key === this.wrongHeader) resultHeaders.set('Content-Encoding', 'br');
      return { status: old ? 200 : 404, headers: resultHeaders, body: stored || Buffer.alloc(0) };
    }
    if (key === this.fail) return { status: 503, headers: new Headers(), body: Buffer.alloc(0) };
    if (key === this.concurrent) { this.values.set(key, { body: Buffer.from('competing revision'), headers: new Headers({ ETag: '"competitor"' }) }); return { status: 412, headers: new Headers(), body: Buffer.alloc(0) }; }
    if (headers['If-None-Match'] === '*' && old || headers['If-Match'] && headers['If-Match'] !== old?.headers.get('ETag')) return { status: 412, headers: new Headers(), body: Buffer.alloc(0) };
    const storedHeaders = new Headers(headers); storedHeaders.set('ETag', `"${++this.version}"`);
    this.values.set(key, { body: Buffer.from(body!), headers: storedHeaders }); this.writes.push(key);
    return { status: 200, headers: storedHeaders, body: Buffer.alloc(0) };
  }
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-publish-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function dataset(root: string, id = '1', real = true) {
  const input = syntheticCity(4, id);
  // Declared extract metadata exercises publication logic; geometry remains fictional.
  if (real) { input.metadata.source.kind = 'osm-extract'; input.metadata.country = 'JP'; }
  const built = buildDataset(input, 12); await writeDataset(root, built);
  return { built, key: manifestKey(built.manifest.city_key, built.manifest.dataset_revision), latest: `v2/cities/${built.manifest.city_key}/latest.json` };
}

test('publisher verifies immutable bytes/headers before latest and retries idempotently', async () => fixture(async root => {
  const { built, key, latest } = await dataset(root); const r2 = new FakeR2();
  await publishCity(root, key, r2);
  assert.deepEqual(r2.writes, [...built.manifest.chunks.map(chunk => chunk.key), key, latest]);
  const writes = r2.writes.length; await publishCity(root, key, r2);
  assert.equal(r2.writes.length, writes + 1);
  for (const chunk of built.manifest.chunks) assert.equal(sha256(r2.values.get(chunk.key)!.body), chunk.stored_sha256);
}));
for (const failure of ['corrupt', 'fail', 'wrongHeader'] as const) test(`publisher ${failure} retains the previous pointer`, async () => fixture(async root => {
  const { built, key, latest } = await dataset(root); const r2 = new FakeR2();
  r2.values.set(latest, { body: Buffer.from('previous'), headers: new Headers({ ETag: '"previous"' }) });
  r2[failure] = built.manifest.chunks[0].key;
  await assert.rejects(publishCity(root, key, r2));
  assert.equal(r2.values.get(latest)!.body.toString(), 'previous'); assert.ok(!r2.writes.includes(latest));
}));
test('publisher rejects synthetic inputs without writes but permits a local dry-run plan', async () => fixture(async root => {
  const { key } = await dataset(root, '1', false); const r2 = new FakeR2();
  assert.ok((await preparePublication(root, key)).objects.length);
  await assert.rejects(publishDatasets(root, [key], r2, true), /Synthetic/); assert.equal(r2.writes.length, 0);
}));
test('latest compare-and-swap preserves a competing publication', async () => fixture(async root => {
  const { key, latest } = await dataset(root); const r2 = new FakeR2(); r2.concurrent = latest;
  await assert.rejects(publishCity(root, key, r2), /concurrently/);
  assert.equal(r2.values.get(latest)!.body.toString(), 'competing revision');
}));
test('catalog publishes only after every city, rejects lost coverage before writes, and checks shards', async () => fixture(async root => {
  const a = await dataset(root), b = await dataset(root, '2'); const r2 = new FakeR2();
  await publishDatasets(root, [a.key, b.key], r2, true);
  const rootCatalog = JSON.parse(r2.values.get('v2/catalog.json')!.body.toString()); assert.equal(rootCatalog.city_count, 2);
  assert.ok(r2.writes.indexOf('v2/catalog.json') > r2.writes.indexOf(a.latest)); assert.ok(r2.writes.indexOf('v2/catalog.json') > r2.writes.indexOf(b.latest));
  const writes = r2.writes.length;
  await assert.rejects(publishDatasets(root, [a.key], r2, true), /remove cities/); assert.equal(r2.writes.length, writes);
  r2.corrupt = rootCatalog.countries[0].key;
  await assert.rejects(publishDatasets(root, [a.key, b.key], r2, true), /checksum/); assert.equal(r2.writes.length, writes);
  assert.deepEqual(catalogObjects([a.built.manifest, b.built.manifest]), catalogObjects([b.built.manifest, a.built.manifest]));
}));
test('catalog compare-and-swap cannot overwrite a competing catalog', async () => fixture(async root => {
  const { key } = await dataset(root); const r2 = new FakeR2(); r2.concurrent = 'v2/catalog.json';
  await assert.rejects(publishDatasets(root, [key], r2, true), /concurrently/);
  assert.equal(r2.values.get('v2/catalog.json')!.body.toString(), 'competing revision');
}));


test('R2 signing preserves gzip bytes, fixed content length and conditional headers', async () => {
  const body = gzipSync('raw stored protobuf bytes');
  const client = new R2({ accountId: 'a'.repeat(32), bucket: 'citymap-test', accessKeyId: 'test-key', secretAccessKey: 'test-secret' });
  const signed = await client.sign('PUT', 'v2/test.pbf', body, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/x-protobuf', 'If-None-Match': '*' });
  assert.equal(signed.headers.get('Content-Length'), String(body.byteLength));
  assert.equal(signed.headers.get('Content-Encoding'), 'gzip');
  assert.match(signed.headers.get('Authorization')!, /if-none-match/);
  assert.deepEqual(Buffer.from(await signed.arrayBuffer()), body);
  await assert.rejects(client.sign('PUT', '../escape', body), /object key/);
});
