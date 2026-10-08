import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, RequestError, sleep } from '../src/lib/request.ts';

test('request preserves method/body/options and never fetches an already cancelled load', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => { calls++; assert.equal(options.method, 'POST'); assert.equal(options.body, 'query'); return new Response('ok'); });
  assert.equal(await (await request('http://localhost/roads', { method: 'POST', body: 'query', signal: new AbortController().signal })).text(), 'ok');
  const abort = new AbortController(); abort.abort(new Error('Cancelled')); await assert.rejects(request('http://localhost/roads', { signal: abort.signal }), /Cancelled/); assert.equal(calls, 1);
});
for (const code of [400, 404, 410, 500]) test(`HTTP ${code} is surfaced without an inappropriate retry`, async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('failed', { status: code }); });
  await assert.rejects(request('http://localhost/roads', { signal: new AbortController().signal }), error => error instanceof RequestError && error.status === code); assert.equal(calls, 1);
});
test('a transient request retries only once and respects a long Retry-After', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 503, headers: { 'Retry-After': '0' } }); });
  await assert.rejects(request('http://localhost/roads', { signal: new AbortController().signal }), RequestError); assert.equal(calls, 2);
  calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); });
  await assert.rejects(request('http://localhost/roads', { signal: new AbortController().signal }), /busy/); assert.equal(calls, 1);
});
test('a successful retry cancels the rejected body and returns the provider response', async t => {
  let calls = 0, cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 2) return new Response('Recovered roads');
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 502, headers: { 'Retry-After': '0' } });
  });
  const response = await request('http://localhost/roads', { signal: new AbortController().signal });
  assert.equal(await response.text(), 'Recovered roads');
  assert.equal(calls, 2); assert.equal(cancelled, 1);
});
test('long numeric and dated provider cooldowns cancel the body without retrying early', async t => {
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  for (const retryAfter of ['60', new Date(now + 60_000).toUTCString()]) {
    let calls = 0, cancelled = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429, headers: { 'Retry-After': retryAfter } });
    });
    await assert.rejects(request('http://localhost/roads', { signal: new AbortController().signal }), error => error instanceof RequestError && error.status === 429);
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  }
});
test('network failures retry once and expose a useful final error', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('network'); });
  await assert.rejects(request('http://localhost/roads', { signal: new AbortController().signal }), /could not be reached/); assert.equal(calls, 2);
});
test('cancellation interrupts backoff and a deadline cancels the active fetch', async t => {
  const abort = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; queueMicrotask(() => abort.abort(new Error('Stop backoff'))); return new Response('', { status: 503 }); });
  await assert.rejects(request('http://localhost/roads', { signal: abort.signal }), /Stop backoff/); assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); }));
  const keepAlive = setTimeout(() => {}, 100); try { await assert.rejects(request('http://localhost/roads', { signal: new AbortController().signal }, 20), { name: 'TimeoutError' }); } finally { clearTimeout(keepAlive); }
  const cancelled = new AbortController(); const wait = sleep(1000, cancelled.signal); cancelled.abort(new Error('Sleep stopped')); await assert.rejects(wait, /Sleep stopped/);
});
