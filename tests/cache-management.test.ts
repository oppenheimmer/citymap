import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CacheGeneration } from '../src/lib/cache-generation.ts';
import { cloudCities } from '../src/lib/cache-manager.ts';
import { createCacheHandler, deleteMaps } from '../server/cache.ts';
import type { MapStore } from '../server/cache.ts';
import { parseR2Listing, R2 } from '../server/r2.ts';
import { buildDataset } from '../tools/city-data/build.ts';
import { syntheticCity } from '../tools/city-data/fixtures.ts';
import { catalogObjects } from '../tools/city-data/publish.ts';

class Store implements MapStore {
  values = new Map<string, { body: Buffer; etag: string }>();
  deleted: string[] = [];
  fail = ''; conflict = false;
  async list(prefix: string, limit = 1000, cursor?: string) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
    const objects = keys.slice(0, limit).map(key => ({ key, bytes: this.values.get(key)!.body.length, modified: '2026-10-29T00:00:00Z' }));
    return { objects, cursor: keys.length > limit ? objects.at(-1)!.key : undefined };
  }
  async request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, headers: Record<string, string> = {}) {
    const old = this.values.get(key);
    let status = 200;
    if (method === 'GET') status = old ? 200 : 404;
    if (method === 'PUT') {
      if (key === this.fail) status = 503;
      else if (headers['If-None-Match'] === '*' && old || headers['If-Match'] && (this.conflict || headers['If-Match'] !== old?.etag)) status = 412;
      else this.values.set(key, { body: body!, etag: `"${Date.now()}-${this.values.size}"` });
    }
    if (method === 'DELETE') {
      if (key === this.fail) status = 503;
      else { this.values.delete(key); this.deleted.push(key); status = 204; }
    }
    return { status, headers: new Headers(old ? { ETag: old.etag } : {}), body: old?.body || Buffer.alloc(0) };
  }
  seed(key: string, value = 'data') { this.values.set(key, { body: Buffer.from(value), etag: '"seed"' }); }
}
const signal = () => AbortSignal.timeout(5000);
function catalog(store: Store) {
  const manifests = ['1', '2'].map(id => buildDataset(syntheticCity(2, id), 12).manifest);
  for (const object of catalogObjects(manifests)) store.seed(object.key, object.body.toString());
  for (const manifest of manifests) {
    store.seed(`v2/cities/${manifest.city_key}/latest.json`);
    store.seed(`v2/cities/${manifest.city_key}/${manifest.dataset_revision}/manifest.json`);
  }
}

test('cache generations invalidate other tabs synchronously and survive blocked localStorage', t => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) }, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  const first = new CacheGeneration('test'), second = new CacheGeneration('test');
  assert.equal(first.read(), 0); first.invalidate(); assert.equal(second.read(), 1);
  second.invalidate(); assert.equal(first.read(), 2);
  values.set('citymap:cache-generation:test', 'NaN'); assert.equal(first.read(), 2);
  first.observe(7); assert.equal(first.read(), 7);
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('Denied'); }, configurable: true });
  assert.equal(first.invalidate(), 8); assert.equal(first.read(), 8);
});

test('cloud city inventory groups files without downloading geometry or listing search records', () => {
  assert.deepEqual(cloudCities([
    { key: 'v2/cities/osm-relation-1/a/roads.pbf.gz', bytes: 20, modified: '2026-10-28' },
    { key: 'v2/cities/osm-relation-1/latest.json', bytes: 10, modified: '2026-10-29' },
    { key: 'v2/catalog.json', bytes: 100, modified: '2026-10-29' },
  ]), [{ key: 'osm-relation-1', count: 2, bytes: 30, modified: '2026-10-29' }]);
});

test('signed R2 listing preserves continuation query and DELETE signs only valid object keys', async () => {
  const r2 = new R2({ accountId: 'a'.repeat(32), bucket: 'citymap-data', accessKeyId: 'access', secretAccessKey: 'secret' });
  const listing = await r2.sign('GET', '', undefined, {}, new URLSearchParams({ 'list-type': '2', prefix: 'v2/', 'continuation-token': 'a+b/=' }));
  assert.equal(new URL(listing.url).searchParams.get('continuation-token'), 'a+b/=');
  assert.ok(listing.headers.get('authorization')?.includes('AWS4-HMAC-SHA256'));
  assert.equal((await r2.sign('DELETE', 'v2/cities/osm-relation-1/latest.json')).method, 'DELETE');
  await assert.rejects(r2.sign('DELETE', '')); await assert.rejects(r2.sign('DELETE', 'v2/../locks/key'));
});

test('R2 listing decodes keys/tokens and rejects unsafe, malformed and oversized inventories', () => {
  const xml = '<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated><Contents><Key>v2%2Fcities%2Fa%26b</Key><Size>12</Size><LastModified>2026-10-29T00:00:00Z</LastModified></Contents><NextContinuationToken>x&amp;y=</NextContinuationToken></ListBucketResult>';
  assert.deepEqual(parseR2Listing(xml, 'v2/'), { objects: [{ key: 'v2/cities/a&b', bytes: 12, modified: '2026-10-29T00:00:00Z' }], cursor: 'x&y=' });
  for (const bad of [xml.replace('v2%2F', 'locks%2F'), xml.replace('<Size>12', '<Size>-1'), xml.replace('true', 'maybe'), xml.replace('<EncodingType>url</EncodingType>', ''), '<!DOCTYPE a>' + xml, xml.replace('x&amp;y=', ''), xml.replace('</Contents>', '')]) assert.throws(() => parseR2Listing(bad, 'v2/'));
});

test('individual R2 city removal updates the catalog, removes all revisions and preserves other cities/search', async () => {
  const store = new Store(); catalog(store); store.seed('search/v1/query.json'); store.seed('locks/public-nominatim.json');
  store.seed('v2/cities/osm-relation-1/old/chunk.gz');
  const result = await deleteMaps(store, 'osm-relation-1', signal());
  assert.equal(result.remaining, false);
  assert.ok(![...store.values.keys()].some(key => key.startsWith('v2/cities/osm-relation-1/')));
  assert.ok([...store.values.keys()].some(key => key.startsWith('v2/cities/osm-relation-2/')));
  const root = JSON.parse(store.values.get('v2/catalog.json')!.body.toString()); assert.equal(root.city_count, 1);
  const index = JSON.parse(store.values.get(root.countries[0].key)!.body.toString()); assert.deepEqual(index.cities.map((city: { city_key: string }) => city.city_key), ['osm-relation-2']);
  assert.ok(store.values.has('search/v1/query.json')); assert.ok(store.values.has('locks/public-nominatim.json'));
});

test('catalog conflicts and corruption stop deletion before any city files are removed', async () => {
  for (const conflict of [true, false]) {
    const store = new Store(); catalog(store); store.conflict = conflict;
    if (!conflict) { const root = JSON.parse(store.values.get('v2/catalog.json')!.body.toString()); store.seed(root.countries[0].key, '{}'); }
    await assert.rejects(deleteMaps(store, 'osm-relation-1', signal())); assert.deepEqual(store.deleted, []);
  }
});

test('removing the last catalog city leaves a valid empty catalog and orphan cities can be removed', async () => {
  const store = new Store(); catalog(store);
  await deleteMaps(store, 'osm-relation-1', signal()); await deleteMaps(store, 'osm-relation-2', signal());
  const root = JSON.parse(store.values.get('v2/catalog.json')!.body.toString());
  assert.equal(root.city_count, 0); assert.deepEqual(root.countries, []);
  store.values.delete('v2/catalog.json'); store.seed('v2/cities/osm-relation-3/orphan.gz');
  await deleteMaps(store, 'osm-relation-3', signal());
  assert.ok(!store.values.has('v2/cities/osm-relation-3/orphan.gz'));
});

test('an unavailable latest pointer stops city deletion and out-of-prefix listings cannot delete private objects', async () => {
  const store = new Store(); store.seed('v2/cities/osm-relation-1/latest.json'); store.fail = 'v2/cities/osm-relation-1/latest.json';
  await assert.rejects(deleteMaps(store, 'osm-relation-1', signal()), /pointer/); assert.deepEqual(store.deleted, []);
  store.fail = '';
  store.list = async () => ({ objects: [{ key: 'locks/keep', bytes: 1, modified: '2026-10-29' }], cursor: undefined });
  await assert.rejects(deleteMaps(store, 'osm-relation-1', signal()), /deletion listing/);
  assert.ok(!store.deleted.join('\n').includes('locks/keep'));
});

test('R2 clear-all resumes bounded batches and never clears private data', async () => {
  const store = new Store(); for (let i = 0; i < 205; i++) store.seed(`v2/cities/osm-relation-1/rev/${i}.gz`);
  store.seed('search/v1/keep'); store.seed('locks/keep');
  const sizes = []; let remaining = true;
  while (remaining) { const result = await deleteMaps(store, undefined, signal()); sizes.push(result.deleted); remaining = result.remaining; }
  assert.deepEqual(sizes, [100, 100, 5]); assert.deepEqual([...store.values.keys()], ['search/v1/keep', 'locks/keep']);
});

test('R2 deletion reports partial failures and a retry finishes without hiding failures', async () => {
  const store = new Store(); store.seed('v2/a'); store.seed('v2/b'); store.fail = 'v2/b';
  await assert.rejects(deleteMaps(store, undefined, signal()), /1 map files removed; 1/);
  assert.ok(!store.values.has('v2/a')); assert.ok(store.values.has('v2/b'));
  store.fail = ''; await deleteMaps(store, undefined, signal()); assert.equal(store.values.size, 0);
});

const secret = 'a-long-test-administrator-key-123456789';
async function call(options: { method?: string; body?: string; origin?: string; auth?: string; url?: string; env?: NodeJS.ProcessEnv }, store = new Store()) {
  const req = Object.assign(Readable.from(options.body ? [options.body] : []), { method: options.method || 'GET', url: options.url || '/api/cache', headers: { origin: options.origin, authorization: options.auth, 'content-type': 'application/json' } }) as IncomingMessage;
  let data = '', statusCode = 200; const headers = new Map<string, string>();
  const res = { setHeader: (key: string, value: string) => headers.set(key, value), end: (value: string) => { data = value; }, get statusCode() { return statusCode; }, set statusCode(value: number) { statusCode = value; } } as unknown as ServerResponse;
  await createCacheHandler({ APP_ORIGIN: 'https://maps.test', CACHE_ADMIN_TOKEN: secret, R2_DATA_BUCKET: 'citymap-data', R2_SEARCH_BUCKET: 'citymap-search', ...options.env }, store)(req, res);
  assert.equal(headers.get('Cache-Control'), 'no-store');
  return { status: statusCode, data: JSON.parse(data), store };
}
test('cache administration is disabled without a secret or with the private search bucket', async () => {
  assert.deepEqual((await call({ url: '/api/cache?status=1', env: { CACHE_ADMIN_TOKEN: '' } })).data, { configured: false });
  assert.equal((await call({ env: { R2_DATA_BUCKET: 'citymap-search' } })).status, 503);
  for (const origin of ['https://maps.test/path', 'https://maps.test/', 'http://maps.test', 'invalid']) assert.deepEqual((await call({ url: '/api/cache?status=1', env: { APP_ORIGIN: origin } })).data, { configured: false });
});
test('cache administration rejects missing/wrong auth, cross-origin mutations and invalid scopes', async () => {
  for (const auth of [undefined, 'Bearer wrong']) assert.equal((await call({ auth })).status, 401);
  const auth = `Bearer ${secret}`;
  assert.equal((await call({ auth, origin: 'https://evil.test' })).status, 403);
  assert.equal((await call({ auth, method: 'POST', body: '{"scope":"all"}' })).status, 403);
  assert.equal((await call({ auth, method: 'DELETE' })).status, 405);
  assert.equal((await call({ auth, url: `/api/cache?cursor=${'x'.repeat(4097)}` })).status, 400);
  for (const body of ['{}', '{', '{"scope":"city","city":"../search"}', 'null']) assert.equal((await call({ auth, method: 'POST', origin: 'https://maps.test', body })).status, 400);
  assert.equal((await call({ auth, method: 'POST', origin: 'https://maps.test', body: JSON.stringify({ scope: 'all', padding: 'x'.repeat(1024) }) })).status, 413);
});
test('authenticated same-origin deletion and paginated listing reach only map storage', async () => {
  const store = new Store(); store.seed('v2/map'); store.seed('locks/keep');
  const auth = `Bearer ${secret}`;
  assert.deepEqual((await call({ auth }, store)).data.objects.map((object: { key: string }) => object.key), ['v2/map']);
  assert.equal((await call({ auth, method: 'POST', origin: 'https://maps.test', body: '{"scope":"all"}' }, store)).status, 200);
  assert.deepEqual([...store.values.keys()], ['locks/keep']);
});
