import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupProvider, canFailOver, providerOrigin } from '../src/lib/live/providers.ts';
import { CellFailure, isPublicOverpass } from '../src/lib/live/overpass.ts';
import { LiveViewport } from '../src/lib/live/viewport.ts';
import type { Clock } from '../src/lib/live/scheduler.ts';
import type { CellCommand, CellReply, CellRequest } from '../src/lib/worker-protocol.ts';
import type { SceneController } from '../src/lib/SceneController.ts';
import type { CellCache, CachedCell } from '../src/lib/live/cell-cache.ts';
import { cameraFromView } from '../src/lib/view.ts';

const primary = 'https://primary.example/api/interpreter', backup = 'https://backup.example/api/interpreter';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('one optional backup validates public URLs and rejects duplicate public-service aliases', () => {
  assert.equal(backupProvider(primary, ''), undefined); assert.equal(backupProvider(primary), undefined);
  assert.equal(backupProvider(primary, backup), backup);
  for (const value of [primary, 'http://example.com/api', 'https://name:secret@example.com/api', 'https://example.com/api#fragment', '/mirror', 'not-a-url']) assert.throws(() => backupProvider(primary, value));
  assert.throws(() => backupProvider('https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'));
  assert.throws(() => backupProvider('https://overpass-api.de/api/interpreter', 'https://gall.openstreetmap.de/api/interpreter'));
  for (const host of ['gall.openstreetmap.de', 'lambert.openstreetmap.de']) assert.equal(isPublicOverpass(`https://${host}/api/interpreter`), true);
  assert.equal(providerOrigin('https://name:secret@example.com/path?key=hidden'), 'https://example.com');
  assert.equal(providerOrigin('bad url'), undefined); assert.equal(providerOrigin('file:///tmp/provider'), undefined);
});

test('failover eligibility excludes limits, resource/query/data errors and readable Retry-After', () => {
  for (const failure of [new CellFailure('unreachable'), new CellFailure('provider_unavailable', { status: 500 }), new CellFailure('provider_unavailable', { status: 501 })]) assert.equal(canFailOver(failure), true);
  for (const failure of [
    new CellFailure('provider_unavailable'), new CellFailure('provider_unavailable', { status: 500, retryAfter: 0 }),
    new CellFailure('unreachable', { retryAfter: 10_000 }), new CellFailure('rate_limited', { status: 429 }),
    new CellFailure('provider_busy', { status: 504 }), new CellFailure('timeout_or_resource_limit'),
    new CellFailure('invalid_request'), new CellFailure('decode_failure'), new CellFailure('cancelled'), new CellFailure('response_too_large'),
  ]) assert.equal(canFailOver(failure), false, failure.code);
});

function harness(options: { records?: Map<string, CachedCell>; older?: boolean; forceNetwork?: boolean } = {}) {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  const clock: Clock = { now: () => now, random: () => 0.5, set(callback, ms) { timers.set(++next, { at: now + ms, callback }); return next; }, clear(handle) { timers.delete(handle as number); } };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].callback(); await flush();
    }
    now = until; await flush();
  };
  const requests: CellRequest[] = [], writes: string[] = [];
  const worker = { onmessage: undefined as undefined | ((event: { data: CellReply }) => void), onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') requests.push(command); }, terminate() {} };
  const origin: [number, number] = [139.1, 35.1];
  const camera = cameraFromView({ lon: origin[0], lat: origin[1], width: 500, height: 500 }, origin);
  const scene = { frame: () => camera, rotation: 0, appendGeometry: async () => undefined, removeOwner: () => 0 } as unknown as SceneController;
  const records = options.records;
  const cache = records || options.older ? {
    async get(key: string, _origin: unknown, allowStale = false) {
      return records?.get(key) || (options.older && allowStale ? { positions: new Float32Array([0, 0, 1, 1]), fetchedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, stale: true } : undefined);
    },
    async defer(key: string, _origin: unknown, buffers: Float32Array[], meta: { fetchedAt: number }) {
      writes.push(key); records?.set(key, { positions: Float32Array.from(buffers.flatMap(buffer => [...buffer])), ...meta, stale: false }); return true;
    }, close() {},
  } as unknown as CellCache : undefined;
  const viewport = new LiveViewport(scene, origin, 'major', { overpass: primary, fallback: backup, concurrency: 4, budgetBytes: 1e9, clock, cache, forceNetwork: options.forceNetwork, createWorker: () => worker as unknown as Worker }, () => {});
  const fail = (request: CellRequest, code: CellReply & { type: 'failure' }) => worker.onmessage!({ data: { ...code, id: request.id } });
  const success = (request: CellRequest) => worker.onmessage!({ data: { type: 'cells', id: request.id, cells: request.cells.map(() => ({ positions: new Float32Array([0, 0, 1, 1]).buffer, segments: 1 })), bytes: 16, fetchMs: 1, decodeMs: 0 } });
  return { viewport, requests, writes, advance, success, fail };
}
const unavailable = { type: 'failure', id: 0, code: 'provider_unavailable', status: 500 } as const;

test('the existing delayed retry changes provider once and reports actual request origins', async () => {
  const h = harness();
  try {
    assert.equal(h.requests.length, 1); h.fail(h.requests[0], unavailable); await flush();
    await h.advance(1999); assert.equal(h.requests.length, 1);
    await h.advance(1); assert.equal(h.requests[1].overpass, backup);
    assert.deepEqual(h.requests[1].cells, h.requests[0].cells);
    h.success(h.requests[1]); await flush();
    const report = h.viewport.report();
    assert.equal(report.failovers, 1); assert.equal(report.requests, 2); assert.equal(report.provider, 'https://backup.example');
    assert.deepEqual(report.requestsByProvider, { 'https://primary.example': 1, 'https://backup.example': 1 });
    assert.equal(report.recentFailures[0].provider, 'https://primary.example');
    assert.equal(h.viewport.coverage().complete, true);
  } finally { h.viewport.dispose(); }
});

test('a failed backup spends the original retry allowance and manual retry stays on that backup', async () => {
  const h = harness();
  try {
    h.fail(h.requests[0], unavailable); await flush(); await h.advance(2000);
    h.fail(h.requests[1], unavailable); await flush(); await h.advance(60_000);
    assert.equal(h.requests.length, 2); assert.equal(h.viewport.coverage().failed, 1);
    h.viewport.retry(); assert.equal(h.requests[2].overpass, backup);
    assert.equal(h.viewport.report().failovers, 1);
  } finally { h.viewport.dispose(); }
});

for (const [code, status, wait, retryAfter] of [
  ['rate_limited', 429, 5000, undefined], ['provider_busy', 504, 10_000, undefined], ['provider_unavailable', 500, 6000, 6000],
] as const) test(`${code} ${status} preserves the primary and its requested cooldown`, async () => {
  const h = harness();
  try {
    h.fail(h.requests[0], { type: 'failure', id: 0, code, status, retryAfter }); await flush();
    await h.advance(wait - 1); assert.equal(h.requests.length, 1);
    await h.advance(1); assert.equal(h.requests[1].overpass, primary); assert.equal(h.viewport.report().failovers, 0);
  } finally { h.viewport.dispose(); }
});

test('cache recovery prevents an unused backup switch and cancellation sends no backup query', async () => {
  const h = harness({ older: true }); await flush();
  try {
    h.fail(h.requests[0], unavailable); await flush(); await h.advance(20_000);
    assert.equal(h.requests.length, 1); assert.equal(h.viewport.report().failovers, 0); assert.equal(h.viewport.report().olderRegions, 1);
  } finally { h.viewport.dispose(); }
  const cancelled = harness();
  cancelled.fail(cancelled.requests[0], unavailable); await flush(); cancelled.viewport.dispose();
  await cancelled.advance(20_000); assert.equal(cancelled.requests.length, 1);
});

test('backup geometry retains its provider cache key and a new session reads it without a primary query', async () => {
  const records = new Map<string, CachedCell>(), h = harness({ records }); await flush();
  try {
    h.fail(h.requests[0], unavailable); await flush(); await h.advance(2000);
    h.success(h.requests[1]); await flush();
    assert.equal(records.size, 1); assert.ok([...records.keys()][0].includes(`|${backup}|`));
  } finally { h.viewport.dispose(); }
  const revisit = harness({ records }); await flush();
  try {
    assert.equal(revisit.requests.length, 0); assert.equal(revisit.viewport.coverage().complete, true);
    assert.deepEqual(revisit.viewport.report().sources, ['https://backup.example']);
  } finally { revisit.viewport.dispose(); }
});

test('split cells from different providers keep separate records without mislabelling a mixed parent', async () => {
  const h = harness({ records: new Map() }); await flush();
  try {
    h.fail(h.requests[0], { type: 'failure', id: 0, code: 'timeout_or_resource_limit' }); await flush();
    h.success(h.requests[1]); await flush();
    h.fail(h.requests[2], unavailable); await flush(); await h.advance(2000);
    for (let i = 3; i < 6; i++) { h.success(h.requests[i]); await flush(); }
    assert.equal(h.viewport.coverage().complete, true);
    assert.equal(h.writes.length, 4); assert.ok(h.writes.every(key => key.includes('|0:12/')));
    assert.equal(h.writes.filter(key => key.includes(`|${primary}|`)).length, 1);
    assert.equal(h.writes.filter(key => key.includes(`|${backup}|`)).length, 3);
    assert.deepEqual(h.viewport.report().sources.sort(), ['https://backup.example', 'https://primary.example']);
  } finally { h.viewport.dispose(); }
});
