import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadCity } from '../src/lib/load-city.ts';
import type { LoadCallbacks } from '../src/lib/load-city.ts';
import type { Geometry } from '../src/lib/domain.ts';
import type { WorkerLoad, WorkerResult } from '../src/lib/worker-protocol.ts';

const options: WorkerLoad = {
  boundary: { key: 'local-test', name: 'Local city', kind: 'test', areaId: '3600000101' },
  providers: { search: 'http://localhost/search', overpass: 'http://localhost/roads', cityDataBase: '', legacyCacheBase: '' },
  useCache: false,
  allowLarge: true,
};
const bounds = { left: -1, bottom: -1, right: 2, top: 2 };
const source = { kind: 'live' as const, complete: true, downloadedAt: '2026-10-08T00:00:00.000Z' };
const chunk = (): WorkerResult => ({ type: 'chunk', positions: new Float32Array([0, 0, 1, 1]).buffer, bounds, index: 0 });
const done = (): WorkerResult => ({ type: 'done', source, segmentCount: 1 });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

function harness(t: TestContext, overrides: Partial<LoadCallbacks> = {}) {
  const events: string[] = [], errors: string[] = [], geometries: Geometry[] = [], workers: FixtureWorker[] = [];
  class FixtureWorker {
    onmessage?: (event: MessageEvent<WorkerResult>) => void;
    onerror?: () => void;
    sent?: WorkerLoad;
    terminated = 0;
    readonly url: URL;
    readonly workerOptions: WorkerOptions;
    constructor(url: URL, workerOptions: WorkerOptions) {
      this.url = url; this.workerOptions = workerOptions; workers.push(this);
    }
    postMessage(value: WorkerLoad) { this.sent = value; }
    terminate() { this.terminated++; }
    emit(value: WorkerResult) { this.onmessage?.({ data: value } as MessageEvent<WorkerResult>); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { value: FixtureWorker, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  });
  const stop = loadCity(options, {
    progress: () => { events.push('progress'); },
    chunk: async () => { events.push('chunk'); },
    done: async geometry => { geometries.push(geometry); events.push('done'); },
    error: message => { errors.push(message); },
    large: () => { events.push('large'); },
    ...overrides,
  });
  t.after(stop);
  return { stop, events, errors, geometries, worker: workers[0] };
}

test('worker delivery waits for drawing before reporting complete geometry', async t => {
  const drawing = gate();
  const h = harness(t, { chunk: async () => { await drawing.promise; h.events.push('chunk'); } });
  assert.deepEqual(h.worker.sent, options);
  assert.match(h.worker.url.pathname, /roads\.worker\.ts$/);
  assert.equal(h.worker.workerOptions.type, 'module');
  h.worker.emit({ type: 'progress', progress: { stage: 'download', message: 'Downloading' } });
  h.worker.emit(chunk()); h.worker.emit(done());
  await flush(); assert.deepEqual(h.events, ['progress']);
  drawing.resolve(); await flush();
  assert.deepEqual(h.events, ['progress', 'chunk', 'done']);
  assert.deepEqual([...h.geometries[0].buffers[0]], [0, 0, 1, 1]);
  assert.deepEqual(h.geometries[0].source, source);
  assert.equal(h.geometries[0].segmentCount, 1);
  assert.equal(h.worker.terminated, 1);
  assert.deepEqual(h.errors, []);
});

test('stopping a load rejects queued and late worker messages and is idempotent', async t => {
  const h = harness(t);
  h.worker.emit(chunk()); h.stop(); h.stop(); h.worker.emit(done());
  await flush();
  assert.deepEqual(h.events, []); assert.deepEqual(h.errors, []);
  assert.equal(h.worker.terminated, 1);
});

test('cancelling during drawing prevents a queued completion from replacing the city', async t => {
  const drawing = gate();
  const h = harness(t, { chunk: async () => { await drawing.promise; } });
  h.worker.emit(chunk()); h.worker.emit(done()); await flush();
  h.stop(); drawing.resolve(); await flush();
  assert.deepEqual(h.geometries, []); assert.deepEqual(h.errors, []);
  assert.equal(h.worker.terminated, 1);
});

test('drawing failures terminate the worker and report one recoverable error', async t => {
  const h = harness(t, { chunk: async () => { throw new Error('Upload failed'); } });
  h.worker.emit(chunk()); h.worker.emit(done()); await flush();
  assert.deepEqual(h.errors, ['Upload failed']); assert.deepEqual(h.geometries, []);
  assert.equal(h.worker.terminated, 1);
});

const invalid: [string, WorkerResult[]][] = [
  ['empty buffer', [{ type: 'chunk', positions: new ArrayBuffer(0), bounds, index: 0 }]],
  ['unaligned buffer', [{ type: 'chunk', positions: new Float32Array(3).buffer, bounds, index: 0 }]],
  ['no geometry', [done()]],
  ['segment mismatch', [chunk(), { ...done(), type: 'done', source, segmentCount: 2 }]],
  ['incomplete source', [chunk(), { type: 'done', source: { ...source, complete: false }, segmentCount: 1 }]],
];
for (const [name, messages] of invalid) test(`worker ${name} cannot produce an exportable city`, async t => {
  const h = harness(t);
  messages.forEach(message => h.worker.emit(message)); await flush();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0], /Invalid prepared|incomplete geometry/);
  assert.deepEqual(h.geometries, []); assert.equal(h.worker.terminated, 1);
});

test('size confirmation stops processing without publishing partial geometry', async t => {
  const h = harness(t);
  h.worker.emit({ type: 'large', bytes: 32 * 1024 * 1024 }); h.worker.emit(done()); await flush();
  assert.deepEqual(h.events, ['large']); assert.deepEqual(h.geometries, []);
  assert.equal(h.worker.terminated, 1);
});
test('worker failures terminate processing and report one recoverable error', t => {
  const failed = harness(t);
  failed.worker.onerror?.(); failed.worker.onerror?.();
  assert.deepEqual(failed.errors, ['Background processing failed. Retry or choose a smaller area.']);
  assert.equal(failed.worker.terminated, 1);
});
