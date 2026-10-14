import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellScheduler } from '../src/lib/live/scheduler.ts';
import type { Clock, JobSpec, LeafTask, SchedulerOptions } from '../src/lib/live/scheduler.ts';
import { CellFailure } from '../src/lib/live/overpass.ts';
import type { FailureCode } from '../src/lib/live/overpass.ts';

function fakeClock() {
  let time = 0, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: Clock & { advance(ms: number): Promise<void>; pending(): number } = {
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
      time = until;
    },
    pending: () => timers.size,
  };
  return clock;
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { task: LeafTask; signal: AbortSignal; settled: boolean; resolve(value: string): void; reject(error: unknown): void }
function harness(options: Partial<SchedulerOptions> = {}, lookup?: (task: LeafTask) => string | undefined) {
  const clock = fakeClock(), calls: Call[] = [], loaded: { leaf: string; job: string; result: string; cached: boolean }[] = [], outcomes: string[] = [];
  const scheduler = new CellScheduler<string>({ concurrency: 1, maxDepth: 2, retries: 1, maxRequests: 100, pauseAfter: 4, clock, ...options }, {
    execute: (task, signal) => new Promise((resolve, reject) => {
      const call: Call = { task, signal, settled: false, resolve: value => { call.settled = true; resolve(value); }, reject: error => { call.settled = true; reject(error); } };
      calls.push(call);
    }),
    lookup: lookup && (async task => lookup(task)),
    loaded: (task, result, cached) => loaded.push({ leaf: task.leaf, job: task.job, result, cached }),
    changed: () => {},
    failed: (task, failure, outcome) => outcomes.push(`${task.leaf}:${failure.code}:${outcome}`),
  });
  return { clock, calls, loaded, outcomes, scheduler, active: () => calls.filter(call => !call.settled && !call.signal.aborted) };
}
const job = (key: string, priority: number, x = priority): JobSpec => ({ key, tile: { z: 13, x, y: 10 }, rank: 1, priority });
const fail = (code: FailureCode, retryAfter?: number) => new CellFailure(code, { retryAfter });

test('jobs load one at a time in priority order and a repeated want never duplicates requests', async () => {
  const h = harness();
  h.scheduler.want([job('c', 3), job('a', 1), job('b', 2)]);
  h.scheduler.want([job('c', 3), job('a', 1), job('b', 2)]);
  assert.deepEqual(h.calls.map(call => call.task.job), ['a']);
  h.calls[0].resolve('A'); await flush();
  assert.deepEqual(h.calls.map(call => call.task.job), ['a', 'b']);
  assert.equal(h.scheduler.status('a'), 'ready'); assert.equal(h.scheduler.status('b'), 'loading'); assert.equal(h.scheduler.status('c'), 'pending');
  h.calls[1].resolve('B'); await flush(); h.calls[2].resolve('C'); await flush();
  assert.deepEqual(h.loaded.map(entry => entry.result), ['A', 'B', 'C']);
  assert.equal(h.scheduler.requests, 3);
});

test('a moved view drops queued work and aborts requests outside the retained area', async () => {
  const h = harness({ concurrency: 2 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3)]);
  assert.deepEqual(h.active().map(call => call.task.job), ['a', 'b']);
  // `a` is still nearby (retained); `b` is far away; `c` never started.
  h.scheduler.want([job('d', 1)], ['a']);
  assert.equal(h.calls[0].signal.aborted, false); assert.equal(h.calls[1].signal.aborted, true);
  assert.deepEqual(h.active().map(call => call.task.job), ['a', 'd']);
  assert.equal(h.scheduler.status('c'), undefined);
  // A late result of the aborted request is ignored.
  h.calls[1].resolve('stale'); h.calls[0].resolve('A'); await flush();
  assert.deepEqual(h.loaded.map(entry => entry.result), ['A']);
  // A finished region stays loaded after it scrolls out of view, until forgotten.
  h.scheduler.want([]);
  assert.equal(h.scheduler.status('a'), 'ready');
  h.scheduler.forget('a'); assert.equal(h.scheduler.status('a'), undefined);
});

test('a dense cell splits into bounded quarters; the job is ready when every quarter is', async () => {
  const h = harness({ concurrency: 1, maxDepth: 1 });
  h.scheduler.want([job('a', 1)]);
  h.calls[0].reject(fail('timeout_or_resource_limit')); await flush();
  assert.deepEqual(h.outcomes, ['13/1/10:timeout_or_resource_limit:split']);
  const quarters = ['14/2/20', '14/3/20', '14/2/21', '14/3/21'];
  for (const [index, leaf] of quarters.entries()) {
    assert.equal(h.calls[index + 1].task.leaf, leaf); assert.equal(h.calls[index + 1].task.depth, 1);
    assert.equal(h.scheduler.status('a'), 'loading');
    if (index === 1) h.calls[index + 1].reject(fail('response_too_large')); else h.calls[index + 1].resolve(leaf);
    await flush();
  }
  // At the depth limit a quarter fails instead of splitting again; the others stay loaded.
  assert.equal(h.calls.length, 5); assert.equal(h.scheduler.status('a'), 'failed'); assert.equal(h.scheduler.failure('a'), 'response_too_large');
  assert.deepEqual(h.loaded.map(entry => entry.leaf), ['14/2/20', '14/2/21', '14/3/21']);
  h.scheduler.retry(); assert.equal(h.calls.at(-1)!.task.leaf, '14/3/20');
  h.calls.at(-1)!.resolve('ok'); await flush(); assert.equal(h.scheduler.status('a'), 'ready');
});

test('rate limits pause every request for the requested time and never split cells', async () => {
  const h = harness({ concurrency: 1 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  h.calls[0].reject(fail('rate_limited', 30_000)); await flush();
  assert.deepEqual(h.outcomes, ['13/1/10:rate_limited:cooldown']);
  assert.equal(h.scheduler.cooldownUntil, 30_000);
  await h.clock.advance(29_999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].task.leaf, '13/1/10');
  // Without Retry-After the wait backs off; very short waits are lengthened.
  h.calls[1].reject(fail('rate_limited', 0)); await flush();
  assert.equal(h.scheduler.cooldownUntil - h.clock.now(), 1000);
  await h.clock.advance(1000); h.calls[2].resolve('A'); await flush();
  assert.equal(h.calls[3].task.job, 'b'); assert.ok(h.calls.every(call => call.task.depth === 0));
});

test('repeated provider failures pause the session until an explicit retry', async () => {
  const h = harness({ concurrency: 1, pauseAfter: 3, retries: 0 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3), job('d', 4)]);
  for (let i = 0; i < 2; i++) { h.calls[i].reject(fail('provider_unavailable')); await flush(); }
  h.calls[2].reject(fail('rate_limited', 500_000)); await flush();
  assert.equal(h.scheduler.paused, true); assert.equal(h.calls.length, 3);
  // The failure that paused loading is kept to explain it.
  assert.equal(h.scheduler.pauseReason, 'rate_limited');
  await h.clock.advance(1_000_000); assert.equal(h.calls.length, 3);
  h.scheduler.retry(); assert.equal(h.scheduler.paused, false); assert.equal(h.scheduler.pauseReason, undefined);
  assert.deepEqual(h.active().map(call => call.task.job), ['a']);
  // An unreachable provider is retried like an unavailable one, and pauses with its own reason.
  const blocked = harness({ concurrency: 1, pauseAfter: 2, retries: 1 });
  blocked.scheduler.want([job('a', 1), job('b', 2)]);
  blocked.calls[0].reject(fail('unreachable')); await flush();
  assert.deepEqual(blocked.outcomes, ['13/1/10:unreachable:retry']);
  blocked.calls[1].reject(fail('unreachable')); await flush();
  assert.deepEqual([blocked.scheduler.paused, blocked.scheduler.pauseReason], [true, 'unreachable']);
});

test('an explicit retry resumes a paused session but waits out an active rate-limit cooldown', async () => {
  const h = harness({ concurrency: 1, pauseAfter: 2, retries: 0 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  h.calls[0].reject(fail('provider_unavailable')); await flush();
  h.calls[1].reject(fail('rate_limited', 30_000)); await flush();
  assert.equal(h.scheduler.paused, true);
  h.scheduler.retry();
  assert.equal(h.scheduler.paused, false); assert.equal(h.calls.length, 2);
  await h.clock.advance(29_999); assert.equal(h.calls.length, 2);
  await h.clock.advance(1); assert.deepEqual(h.active().map(call => call.task.job), ['a']);
});

test('a transiently unavailable provider is retried once with backoff, then the cell fails', async () => {
  const h = harness({ concurrency: 1, retries: 1 });
  h.scheduler.want([job('a', 1)]);
  h.calls[0].reject(fail('provider_unavailable')); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.scheduler.status('a'), 'pending');
  await h.clock.advance(1999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls.length, 2);
  h.calls[1].reject(fail('provider_unavailable')); await flush();
  assert.equal(h.scheduler.status('a'), 'failed'); assert.equal(h.clock.pending(), 0);
  // Invalid requests and decode failures are not retried.
  const other = harness();
  other.scheduler.want([job('a', 1), job('b', 2)]);
  other.calls[0].reject(fail('invalid_request')); await flush(); other.calls[1].reject(new Error('unexpected')); await flush();
  assert.deepEqual(other.outcomes, ['13/1/10:invalid_request:failed', '13/2/10:decode_failure:failed']);
});

test('a session request budget stops runaway loading until retried', async () => {
  const h = harness({ concurrency: 1, maxRequests: 2 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3)]);
  h.calls[0].resolve('A'); await flush(); h.calls[1].resolve('B'); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.scheduler.exhausted, true);
  h.scheduler.retry(); assert.equal(h.calls.length, 3);
});

test('a cache lookup serves whole jobs without requests and misses fall through to the provider', async () => {
  const h = harness({ concurrency: 1 }, task => task.job === 'a' ? 'cached-a' : undefined);
  h.scheduler.want([job('a', 1), job('b', 2)]);
  assert.equal(h.scheduler.status('a'), 'loading'); assert.equal(h.calls.length, 0);
  await flush();
  assert.deepEqual(h.loaded, [{ leaf: '13/1/10', job: 'a', result: 'cached-a', cached: true }]);
  assert.deepEqual(h.calls.map(call => call.task.job), ['b']);
  assert.equal(h.scheduler.requests, 1);
});

test('disposal aborts every request and ignores later results', async () => {
  const h = harness({ concurrency: 2 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  h.scheduler.dispose();
  assert.ok(h.calls.every(call => call.signal.aborted));
  h.calls[0].resolve('late'); await flush();
  assert.deepEqual(h.loaded, []);
  h.scheduler.want([job('c', 1)]); assert.equal(h.calls.length, 2);
});
