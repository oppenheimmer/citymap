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
function queue() {
  const store = memoryStore(), clock = { time: 1000, calls: [] as string[], waits: [] as number[] };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const options = {
    provider, contact, store, production: true, now: () => clock.time,
    // Advance the injected clock instead of sleeping in real time.
    sleep: async (ms: number) => { clock.waits.push(ms); clock.time += ms; await new Promise(resolve => setImmediate(resolve)); },
    fetch: (async (url: URL) => { clock.calls.push(url.searchParams.get('q')!); await held; return response(); }) as typeof fetch,
  };
  return { store, clock, options, release };
}
test('concurrent searches queue behind the shared lease instead of failing', async () => {
  const { clock, options, release } = queue();
  const first = search('First', new AbortController().signal, options);
  await new Promise(resolve => setImmediate(resolve));
  const second = search('Second', new AbortController().signal, options);
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(clock.calls, ['First']);
  release(); await first; assert.equal((await second).length, 1);
  assert.deepEqual(clock.calls, ['First', 'Second']);
  // Polls are short; the queued request never waits for the 60-second crash-recovery lease.
  assert.ok(clock.waits.every(ms => ms <= 1100)); assert.ok(clock.time - 1000 < 8000);
});
test('an identical queued query reuses the result fetched ahead of it and cached queries bypass the provider', async () => {
  const { clock, options, release } = queue();
  const first = search('First', new AbortController().signal, options);
  await new Promise(resolve => setImmediate(resolve));
  const same = search('first', new AbortController().signal, options);
  release(); await first; await same;
  assert.deepEqual(clock.calls, ['First']);
  await search('FIRST', new AbortController().signal, options); assert.deepEqual(clock.calls, ['First']);
});
test('a stuck lease returns a short retry hint after the bounded queue', async () => {
  const { store, clock, options } = queue();
  await store.comparePut('locks/public-nominatim.json', { token: 'crashed', until: clock.time + 60_000, next: 0 });
  await assert.rejects(search('Stuck', new AbortController().signal, options), error => error instanceof SearchError && error.status === 429 && error.retryAfter === 2);
  assert.deepEqual(clock.calls, []); assert.ok(clock.time - 1000 <= 8000);
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
