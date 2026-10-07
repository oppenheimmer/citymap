import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, SearchError } from '../server/search.ts';
import { memoryStore } from '../server/r2.ts';

const provider = 'https://nominatim.openstreetmap.org/search';
const contact = 'https://citymap.example.com';
const response = () => new Response(JSON.stringify([{ osm_type: 'relation', osm_id: 123, display_name: 'Test City' }]));

test('production public search fails closed without shared storage', async () => {
  let called = false;
  await assert.rejects(search('Test', new AbortController().signal, { provider, contact, production: true, fetch: async () => { called = true; return response(); } }), error => error instanceof SearchError && error.status === 503);
  assert.equal(called, false);
});
test('independent requests share an atomic lease and cached queries bypass the provider', async () => {
  const store = memoryStore(); let time = 1000, calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const options = { provider, contact, store, production: true, now: () => time, fetch: (async () => { calls++; await held; return response(); }) as typeof fetch };
  const first = search('First', new AbortController().signal, options);
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(search('Second', new AbortController().signal, options), error => error instanceof SearchError && error.status === 429);
  release(); await first; assert.equal(calls, 1);
  await search('first', new AbortController().signal, options); assert.equal(calls, 1);
  await assert.rejects(search('Second', new AbortController().signal, options), error => error instanceof SearchError && error.status === 429);
  time += 1200; await search('Second', new AbortController().signal, options); assert.equal(calls, 2);
});
test('provider rejection releases the lease and respects the aggregate cooldown', async () => {
  const store = memoryStore();
  await assert.rejects(search('Fail', new AbortController().signal, { provider, contact, store, now: () => 1000, fetch: async () => new Response('Busy', { status: 503 }) }));
  const lock = (await store.read('locks/public-nominatim.json'))!.value as { until: number; next: number };
  assert.equal(lock.until, 0); assert.equal(lock.next, 2100);
});
test('managed providers can run without public-Nominatim storage and identify the application', async () => {
  let agent = '';
  const results = await search('Managed', new AbortController().signal, { provider: 'https://managed.example.com/search', contact, production: true, fetch: async (_url, options) => { agent = new Headers(options?.headers).get('User-Agent') || ''; return response(); } });
  assert.equal(results.length, 1); assert.match(agent, /citymap.example.com/);
});
test('unsafe numeric search IDs are preserved from the original JSON token', async () => {
  const results = await search('Large', new AbortController().signal, { provider: 'https://managed.example.com/search', contact, fetch: async () => new Response('[{"osm_id":9007199254740993}]') });
  assert.equal((results[0] as { osm_id: string }).osm_id, '9007199254740993');
});
test('malformed queries and insecure remote providers are rejected before fetch', async () => {
  await assert.rejects(search('', new AbortController().signal, { provider, contact }));
  await assert.rejects(search('test', new AbortController().signal, { provider: 'http://remote.example.com/search', contact }));
});


test('cancelled public search propagates abort to storage/provider and releases with a separate budget', async () => {
  const backing = memoryStore();
  const signals: AbortSignal[] = [];
  const store = {
    async read(key: string, signal?: AbortSignal) { if (signal) signals.push(signal); return backing.read(key); },
    async comparePut(key: string, value: unknown, etag?: string, signal?: AbortSignal) { if (signal) signals.push(signal); return backing.comparePut(key, value, etag); },
  };
  const abort = new AbortController();
  const fetcher = (async (_url, init) => { abort.abort(new DOMException('Cancelled', 'AbortError')); init!.signal!.throwIfAborted(); return new Response('[]'); }) as typeof fetch;
  await assert.rejects(search('Cancel lease test', abort.signal, { provider: 'https://nominatim.openstreetmap.org/search', contact: 'https://citymap.example', store, fetch: fetcher }), /Cancelled/);
  assert.ok(signals.some(signal => signal.aborted));
  assert.ok(!signals.at(-1)!.aborted);
  const lock = await backing.read('locks/public-nominatim.json');
  assert.equal((lock!.value as { token: string }).token, '');
});
