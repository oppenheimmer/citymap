import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPacer, providerPacer } from '../src/lib/live/provider-pacer.ts';
import type { PacerEnvironment, ProviderWait } from '../src/lib/live/provider-pacer.ts';
import { CellFailure } from '../src/lib/live/overpass.ts';
import type { Clock } from '../src/lib/live/scheduler.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const provider = 'https://overpass-api.de/api/interpreter';
function harness({ locks = true, denied = false, rejectedLock = false } = {}) {
  let time = 0, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(), storage = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  const clock: Clock & { advance(ms: number): Promise<void> } = {
    now: () => time, random: () => 0.5,
    set(callback, ms) { timers.set(++next, { at: time + ms, callback }); return next; },
    clear(handle) { timers.delete(handle as number); },
    async advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); time = due[1].at; due[1].callback(); await flush();
      }
      time = until; await flush();
    },
  };
  const env: PacerEnvironment = {
    clock,
    storage: { getItem(key) { if (denied) throw new Error('Denied'); return storage.get(key) ?? null; }, setItem(key, value) { if (denied) throw new Error('Denied'); storage.set(key, value); } },
    lock: locks ? async (key, signal, work) => {
      if (rejectedLock) throw new DOMException('Denied', 'SecurityError');
      const prior = tails.get(key) || Promise.resolve();
      let release!: () => void;
      tails.set(key, new Promise<void>(resolve => { release = resolve; }));
      await prior;
      try { if (!signal.aborted) await work(); } finally { release(); }
    } : undefined,
  };
  const calls: { at: number; resolve(value: string): void; reject(error: unknown): void }[] = [];
  const waits: (ProviderWait | undefined)[] = [];
  const run = (pacer: ProviderPacer, signal = new AbortController().signal, reserveMs = 30_000) => pacer.run(signal, reserveMs, () => new Promise<string>((resolve, reject) => { calls.push({ at: time, resolve, reject }); }), state => waits.push(state));
  return { env, clock, calls, waits, storage, timers, run, create: () => new ProviderPacer(provider, env) };
}

test('successful results return immediately while the next request waits in proportion to elapsed time', async () => {
  const h = harness(), pacer = h.create();
  const first = h.run(pacer), second = h.run(pacer);
  await flush(); assert.equal(h.calls.length, 1);
  await h.clock.advance(4000); h.calls[0].resolve('roads');
  assert.equal(await first, 'roads', 'Drawing does not wait for cooldown');
  await h.clock.advance(4499); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls[1].at, 8500);
  h.calls[1].resolve('next'); assert.equal(await second, 'next');
  await h.clock.advance(1125); assert.equal(h.timers.size, 0);
});

test('independent tab instances serialize requests and share provider-requested waits', async () => {
  const h = harness();
  const first = h.run(h.create()).catch(error => error), second = h.run(h.create());
  await flush(); assert.equal(h.calls.length, 1);
  h.calls[0].reject(new CellFailure('rate_limited', { status: 429, retryAfter: 15_000 }));
  assert.equal((await first).status, 429);
  await h.clock.advance(14_999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls[1].at, 15_000);
  h.calls[1].resolve('ok'); await second; await h.clock.advance(1125);
});

test('shared outage backoff survives new map sessions and resets after a successful response', async () => {
  const h = harness();
  const first = h.run(h.create()).catch(error => error); await flush();
  h.calls[0].reject(new CellFailure('provider_unavailable')); await first;
  const second = h.run(h.create()).catch(error => error);
  await h.clock.advance(1999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); h.calls[1].reject(new CellFailure('provider_unavailable')); await second;
  const success = h.run(h.create());
  await h.clock.advance(3999); assert.equal(h.calls.length, 2);
  await h.clock.advance(1); h.calls[2].resolve('ok'); await success;
  await h.clock.advance(1125);
  const result = h.run(h.create()).catch(error => error); await flush();
  h.calls[3].reject(new CellFailure('unreachable')); await result;
  const state = JSON.parse([...h.storage.values()][0]);
  assert.equal(state.failures, 1); assert.equal(state.until - h.clock.now(), 2000);
  await h.clock.advance(2000);
});

test('cancelling a queued map never dispatches or extends the active request reservation', async () => {
  const h = harness(), pacer = h.create(), controller = new AbortController();
  const first = h.run(pacer), cancelled = h.run(pacer, controller.signal).catch(error => error);
  await flush(); const reservation = [...h.storage.values()][0];
  controller.abort(); assert.equal((await cancelled).code, 'cancelled');
  assert.equal([...h.storage.values()][0], reservation);
  h.calls[0].resolve('roads'); await first; await h.clock.advance(1125);
  assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('cancelling an issued query retains its reservation instead of immediately freeing the next map', async () => {
  const h = harness(), controller = new AbortController();
  const first = h.run(h.create(), controller.signal).catch(error => error), next = h.run(h.create());
  await flush(); controller.abort(); h.calls[0].reject(new CellFailure('cancelled'));
  assert.equal((await first).code, 'cancelled'); await flush();
  await h.clock.advance(29_999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls[1].at, 30_000);
  h.calls[1].resolve('next'); await next; await h.clock.advance(1125);
});

test('a stored reservation protects reloads even after the old browser lock disappeared', async () => {
  const h = harness({ locks: false });
  h.storage.set('citymap-overpass-v1:https://overpass-api.de', JSON.stringify({ until: 20_000, reason: 'previous_request', failures: 0 }));
  const result = h.run(h.create()); await flush();
  assert.equal(h.calls.length, 0);
  await h.clock.advance(19_999); assert.equal(h.calls.length, 0);
  await h.clock.advance(1); assert.equal(h.calls[0].at, 20_000);
  h.calls[0].resolve('roads'); await result; await h.clock.advance(1125);
});

test('storage denial still keeps separate tabs serialized throughout the post-request wait', async () => {
  const h = harness({ denied: true });
  const first = h.run(h.create()).catch(error => error), next = h.run(h.create());
  await flush(); h.calls[0].reject(new CellFailure('provider_busy', { retryAfter: 8000 })); await first;
  await h.clock.advance(7999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls.length, 2);
  h.calls[1].resolve('ok'); await next; await h.clock.advance(1125);
});

for (const rejectedLock of [false, true]) test(`in-page pacing works when Web Locks are ${rejectedLock ? 'denied' : 'absent'}`, async () => {
  const h = harness({ locks: rejectedLock, rejectedLock }), pacer = h.create();
  const a = h.run(pacer), b = h.run(pacer); await flush();
  assert.equal(h.calls.length, 1); h.calls[0].resolve('A'); await a;
  await h.clock.advance(1125); assert.equal(h.calls.length, 2);
  h.calls[1].resolve('B'); await b; await h.clock.advance(1125);
});

test('a queued wait cancels cleanly and leaves the original persisted cooldown intact', async () => {
  const h = harness({ locks: false }), controller = new AbortController();
  h.storage.set('citymap-overpass-v1:https://overpass-api.de', JSON.stringify({ until: 5000, reason: 'rate_limited', failures: 1 }));
  const result = h.run(h.create(), controller.signal).catch(error => error); await flush();
  assert.equal(h.timers.size, 1); controller.abort(); assert.equal((await result).code, 'cancelled'); await flush();
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse([...h.storage.values()][0]).until, 5000);
});

test('malformed state is ignored, successful pauses are capped, and long Retry-After remains shared', async () => {
  const h = harness(), key = 'citymap-overpass-v1:https://overpass-api.de';
  h.storage.set(key, '{broken');
  const a = h.run(h.create()); await flush(); await h.clock.advance(120_000);
  h.calls[0].resolve('ok'); await a;
  assert.equal(JSON.parse(h.storage.get(key)!).until - h.clock.now(), 60_000);
  const b = h.run(h.create()).catch(error => error);
  await h.clock.advance(60_000); h.calls[1].reject(new CellFailure('rate_limited', { retryAfter: 600_000 })); await b;
  assert.equal(JSON.parse(h.storage.get(key)!).until - h.clock.now(), 600_000);
  await h.clock.advance(600_000);
});

test('known public providers always share a pacer while private providers opt in', () => {
  assert.equal(providerPacer('https://example.com/roads'), undefined);
  assert.ok(providerPacer('https://example.com/roads', true));
  assert.equal(providerPacer(provider), providerPacer('https://overpass-api.de/other-path?ignored=1'));
  assert.ok(providerPacer(provider, false));
});

test('different provider origins have independent queues without credentials in persisted keys', async () => {
  const h = harness();
  const a = h.run(h.create()), b = h.run(new ProviderPacer('https://alice:secret@example.com/path?key=hidden', h.env));
  await flush(); assert.equal(h.calls.length, 2);
  assert.doesNotMatch([...h.storage.keys()].join(), /alice|secret|path|hidden/);
  h.calls[0].resolve('A'); h.calls[1].resolve('B'); await Promise.all([a, b]); await h.clock.advance(1125);
});
