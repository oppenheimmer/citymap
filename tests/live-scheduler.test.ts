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

/** One request: `task` is its first leaf; `resolve` takes one result, or one per leaf. */
interface Call { task: LeafTask; tasks: LeafTask[]; signal: AbortSignal; settled: boolean; resolve(value: string | string[]): void; reject(error: unknown): void }
function harness(options: Partial<SchedulerOptions> = {}, lookup?: (task: LeafTask) => string | undefined) {
  const clock = fakeClock(), calls: Call[] = [], loaded: { leaf: string; job: string; result: string; cached: boolean }[] = [], outcomes: string[] = [];
  const scheduler = new CellScheduler<string>({ concurrency: 1, maxDepth: 2, retries: 1, maxRequests: 100, pauseAfter: 4, clock, ...options }, {
    execute: (tasks, signal) => new Promise((resolve, reject) => {
      const call: Call = { task: tasks[0], tasks, signal, settled: false, resolve: value => { call.settled = true; resolve(Array.isArray(value) ? value : [value]); }, reject: error => { call.settled = true; reject(error); } };
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

test('a busy provider makes every request wait 10, 20, 40 then 60 s, never failing or splitting cells, then pauses', async () => {
  const h = harness({ concurrency: 1, pauseAfter: 5 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  for (const [index, wait] of [10_000, 20_000, 40_000, 60_000].entries()) {
    h.calls[index].reject(fail('provider_busy')); await flush();
    assert.equal(h.scheduler.cooldownUntil - h.clock.now(), wait); assert.equal(h.scheduler.cooldownReason, 'provider_busy');
    assert.equal(h.scheduler.status('a'), 'pending');
    await h.clock.advance(wait - 1); assert.equal(h.calls.length, index + 1);
    await h.clock.advance(1); assert.equal(h.calls.length, index + 2);
  }
  assert.ok(h.calls.every(call => call.task.job === 'a' && call.task.depth === 0));
  h.calls[4].reject(fail('provider_busy')); await flush();
  assert.deepEqual([h.scheduler.paused, h.scheduler.pauseReason], [true, 'provider_busy']);
  assert.ok(h.outcomes.every(outcome => outcome.endsWith(':provider_busy:cooldown')));
  // A rate limit asking for up to five minutes is waited out without pausing.
  const patient = harness({ concurrency: 1 });
  patient.scheduler.want([job('a', 1)]);
  patient.calls[0].reject(fail('rate_limited', 240_000)); await flush();
  assert.equal(patient.scheduler.paused, false); assert.equal(patient.scheduler.cooldownReason, 'rate_limited');
  await patient.clock.advance(240_000); assert.equal(patient.calls.length, 2);
});

test('repeated provider failures pause the session until an explicit retry', async () => {
  const h = harness({ concurrency: 1, pauseAfter: 3, retries: 0 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3), job('d', 4)]);
  for (let i = 0; i < 2; i++) { h.calls[i].reject(fail('provider_unavailable')); await flush(); await h.clock.advance(2000 * 2 ** i); }
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
  assert.equal(blocked.calls.length, 1);
  await blocked.clock.advance(2000);
  blocked.calls[1].reject(fail('unreachable')); await flush();
  assert.deepEqual([blocked.scheduler.paused, blocked.scheduler.pauseReason], [true, 'unreachable']);
});

test('an explicit retry resumes a paused session but waits out an active rate-limit cooldown', async () => {
  const h = harness({ concurrency: 1, pauseAfter: 2, retries: 0 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  h.calls[0].reject(fail('provider_unavailable')); await flush();
  await h.clock.advance(2000);
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
  assert.equal(h.scheduler.status('a'), 'failed');
  await h.clock.advance(4000); assert.equal(h.clock.pending(), 0);
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

test('requests combine the next cells in priority order, and each cell gets its own result', async () => {
  const h = harness({ concurrency: 1, batch: 3 });
  h.scheduler.want([job('d', 4), job('b', 2), job('a', 1), job('c', 3)]);
  assert.deepEqual(h.calls.map(call => call.tasks.map(task => task.job)), [['a', 'b', 'c']]);
  assert.equal(h.scheduler.inFlight, 1); assert.equal(h.scheduler.status('c'), 'loading'); assert.equal(h.scheduler.status('d'), 'pending');
  h.calls[0].resolve(['A', 'B', 'C']); await flush();
  assert.deepEqual(h.loaded.map(entry => `${entry.job}=${entry.result}`), ['a=A', 'b=B', 'c=C']);
  assert.deepEqual(h.calls[1].tasks.map(task => task.job), ['d']);
  assert.equal(h.scheduler.requests, 2);
});

test('a combined request that runs out of time retries its cells alone, then splits; later requests combine fewer', async () => {
  const h = harness({ concurrency: 1, batch: 4 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3), job('d', 4), job('e', 5), job('f', 6)]);
  h.calls[0].reject(fail('timeout_or_resource_limit')); await flush();
  assert.deepEqual(h.outcomes, ['13/1/10:timeout_or_resource_limit:alone']);
  // The failed cells now load one per request, before the cells after them.
  assert.deepEqual(h.calls[1].tasks.map(task => task.job), ['a']);
  h.calls[1].reject(fail('timeout_or_resource_limit')); await flush();
  assert.deepEqual(h.calls[2].tasks.map(task => task.leaf), ['14/2/20']);
  for (let i = 2; i < 6; i++) { h.calls[i].resolve('quarter'); await flush(); }
  assert.equal(h.scheduler.status('a'), 'ready');
  for (const name of ['b', 'c', 'd']) { assert.deepEqual(h.calls.at(-1)!.tasks.map(task => task.job), [name]); h.calls.at(-1)!.resolve(name); await flush(); }
  // The cells never tried together combine again, but only two at a time now.
  assert.deepEqual(h.calls.at(-1)!.tasks.map(task => task.job), ['e', 'f']);
  // Invalid requests and bad data are no verdict on a combined request's cells either.
  const other = harness({ concurrency: 1, batch: 2 });
  other.scheduler.want([job('a', 1), job('b', 2)]);
  other.calls[0].reject(fail('invalid_request')); await flush();
  other.calls[1].reject(fail('invalid_request')); await flush();
  assert.equal(other.scheduler.status('a'), 'failed'); assert.deepEqual(other.calls[2].tasks.map(task => task.job), ['b']);
});

test('a rate limit on a combined request counts once and repeats the same request after the wait', async () => {
  const h = harness({ concurrency: 1, batch: 2, pauseAfter: 2 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  h.calls[0].reject(fail('rate_limited', 5000)); await flush();
  assert.equal(h.scheduler.paused, false); assert.deepEqual(h.outcomes, ['13/1/10:rate_limited:cooldown']);
  await h.clock.advance(5000);
  assert.deepEqual(h.calls[1].tasks.map(task => task.job), ['a', 'b']);
});

test('a server outage retries the same batch after a global wait without fanning out into untouched cells', async () => {
  const h = harness({ batch: 2, retries: 1, pauseAfter: 5 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3)]);
  h.calls[0].reject(new CellFailure('provider_unavailable', { status: 500 })); await flush();
  assert.deepEqual(h.outcomes, ['13/1/10:provider_unavailable:retry']);
  await h.clock.advance(1999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.deepEqual(h.calls[1].tasks.map(task => task.job), ['a', 'b']);
  h.calls[1].reject(fail('provider_unavailable', 8000)); await flush();
  assert.equal(h.scheduler.status('a'), 'failed'); assert.equal(h.scheduler.status('b'), 'failed');
  await h.clock.advance(7999); assert.equal(h.calls.length, 2, 'Untouched cells respect the provider wait too');
  h.scheduler.retry(); assert.equal(h.calls.length, 2, 'Explicit retry keeps the cooldown');
  await h.clock.advance(1); assert.deepEqual(h.calls[2].tasks.map(task => task.job), ['a', 'b']);
  h.calls[2].resolve(['A', 'B']); await flush();
  assert.deepEqual(h.calls[3].tasks.map(task => task.job), ['c']);
});

test('a later failure cannot shorten a cooldown already requested by another in-flight query', async () => {
  const h = harness({ concurrency: 2 });
  h.scheduler.want([job('a', 1), job('b', 2), job('c', 3)]);
  h.calls[0].reject(fail('rate_limited', 30_000)); await flush();
  h.calls[1].reject(fail('provider_busy', 1000)); await flush();
  await h.clock.advance(29_999); assert.equal(h.calls.length, 2);
  await h.clock.advance(1); assert.equal(h.calls.length, 4);
});

test('a combined request runs on while any of its cells is wanted or retained, and is aborted when none is', async () => {
  const h = harness({ concurrency: 1, batch: 2 });
  h.scheduler.want([job('a', 1), job('b', 2)]);
  const shared = h.calls[0];
  h.scheduler.want([job('b', 2)]);
  assert.equal(shared.signal.aborted, false); assert.equal(h.scheduler.status('a'), undefined);
  shared.resolve(['A', 'B']); await flush();
  // The result of the cell no longer wanted is dropped.
  assert.deepEqual(h.loaded.map(entry => entry.job), ['b']);
  h.scheduler.want([job('c', 3), job('d', 4)]);
  h.scheduler.want([job('e', 5)], ['d']);
  assert.equal(h.calls[1].signal.aborted, false);
  h.scheduler.want([job('e', 5)]);
  assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.scheduler.inFlight, 1);
  assert.deepEqual(h.calls[2].tasks.map(task => task.job), ['e']);
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
