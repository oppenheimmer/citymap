import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { CellCommand, CellReply, CellRequest, WorkerLoad, WorkerResult } from '../src/lib/worker-protocol.ts';
import { cellLevel, tileBBox, tileRect } from '../src/lib/live/grid.ts';
import { LIVE_LIMITS, LiveViewport } from '../src/lib/live/viewport.ts';
import type { SceneController } from '../src/lib/SceneController.ts';
import { liveStart, START_METRES } from '../src/lib/live/start.ts';
import { translate } from '../src/lib/live/cell-cache.ts';
import { projector } from '../src/lib/geometry.ts';
import { metresPerSceneUnit } from '../src/lib/scale-bar.ts';
import { viewFromCamera } from '../src/lib/view.ts';
import { loadCity } from '../src/lib/load-city.ts';
import type { Camera, Origin } from '../src/lib/domain.ts';

const origin: Origin = [85.8245, 20.2961];
const tile = { z: 13, x: 6049, y: 3600 };

async function cellsWorker(t: TestContext, route: (body: string, signal: AbortSignal) => Promise<Response>) {
  const replies: CellReply[] = [];
  let notify = () => {};
  const scope = { onmessage: undefined as undefined | ((event: { data: CellCommand }) => void), postMessage(message: CellReply) { replies.push(message); notify(); } };
  Object.defineProperty(globalThis, 'self', { value: scope, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, 'self'); });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => route(new URLSearchParams(String(init.body)).get('data')!, init.signal!));
  await import(`../src/workers/cells.worker.ts?run=${Math.random()}`);
  const send = (command: CellCommand) => scope.onmessage!({ data: command });
  const next = () => new Promise<CellReply>(resolve => { const count = replies.length; notify = () => { if (replies.length > count) resolve(replies[count]); }; });
  return { send, next, replies };
}

test('the cells worker fetches one rank of one cell and returns clipped, projected segments', async t => {
  const [south, west, north, east] = tileBBox(tile);
  const queries: string[] = [];
  const worker = await cellsWorker(t, async body => {
    queries.push(body);
    // One street crossing the whole cell from west to east, plus a road of another rank.
    return new Response(JSON.stringify({ osm3s: { timestamp_osm_base: '2026-10-01T00:00:00Z' }, elements: [
      { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [{ lat: (south + north) / 2, lon: west - 0.01 }, { lat: (south + north) / 2, lon: east + 0.01 }] },
      { type: 'way', id: 2, tags: { highway: 'primary' }, geometry: [{ lat: south, lon: west }, { lat: north, lon: east }] },
    ] }));
  });
  const reply = worker.next();
  worker.send({ type: 'fetch', id: 7, tile, rank: 1, origin, overpass: 'http://localhost/roads' });
  const message = await reply;
  assert.equal(message.type, 'cell');
  if (message.type !== 'cell') return;
  assert.match(queries[0], /residential/); assert.doesNotMatch(queries[0], /area|primary/);
  const positions = new Float32Array(message.positions), rect = tileRect(tile, origin);
  assert.deepEqual([message.id, message.segments, positions.length, message.snapshotAt], [7, 1, 4, '2026-10-01T00:00:00Z']);
  assert.ok(Math.abs(positions[0] - rect.left) < 0.01 && Math.abs(positions[2] - rect.right) < 0.01, 'The street is clipped to the cell edges');
  assert.ok(message.bytes > 0 && message.fetchMs >= 0 && message.decodeMs >= 0);
});

test('the cells worker reports typed failures, rejects invalid requests and stays silent after an abort', async t => {
  let requests = 0, aborted = false;
  const worker = await cellsWorker(t, async (_body, signal) => {
    if (++requests === 1) return new Response(JSON.stringify({ remark: 'runtime error: Query timed out' }));
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }));
  });
  let reply = worker.next();
  worker.send({ type: 'fetch', id: 1, tile, rank: 1, origin, overpass: 'http://localhost/roads' });
  let message = await reply;
  assert.deepEqual([message.type, message.type === 'failure' && message.code, message.type === 'failure' && message.remark], ['failure', 'timeout_or_resource_limit', 'runtime error: Query timed out']);
  reply = worker.next();
  worker.send({ type: 'fetch', id: 2, tile: { z: 13, x: 9000, y: -1 }, rank: 1, origin, overpass: 'http://localhost/roads' });
  message = await reply;
  assert.deepEqual([message.type, message.type === 'failure' && message.code], ['failure', 'invalid_request']);
  assert.equal(requests, 1, 'Invalid requests never reach the road service');
  worker.send({ type: 'fetch', id: 3, tile, rank: 1, origin, overpass: 'http://localhost/roads' });
  await new Promise(resolve => setImmediate(resolve));
  worker.send({ type: 'abort', id: 3 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborted, true);
  assert.equal(worker.replies.filter(entry => entry.id === 3).length, 0);
});

test('a searched city starts at a bounded view of its centre, not its whole area', () => {
  // Roughly Bhubaneswar's administrative bounding box, about 30 by 25 km.
  const boundary = { key: 'osm-relation-1', name: 'Bhubaneswar', kind: 'city', bbox: [20.15, 85.68, 20.42, 85.95] as [number, number, number, number], center: origin as [number, number] };
  const start = liveStart(boundary, undefined, 'streets')!;
  assert.deepEqual(start.origin, origin);
  const view = viewFromCamera(start.camera!, start.origin);
  assert.ok(Math.abs(view.lon - origin[0]) < 1e-9 && Math.abs(view.lat - origin[1]) < 1e-9);
  assert.ok(Math.abs(view.width * metresPerSceneUnit(origin[1]) - START_METRES.streets) < 1);
  // Fit map frames the whole place, which is much larger than the first view.
  assert.ok(start.bounds.right - start.bounds.left > 6 * (start.camera!.right - start.camera!.left));
  // A village smaller than the first view is shown whole.
  const village = liveStart({ key: 'v', name: 'Village', kind: 'village', bbox: [20.29, 85.82, 20.30, 85.83] }, undefined, 'streets')!;
  assert.ok(village.camera!.right - village.camera!.left < start.camera!.right - start.camera!.left);
  // An explicit bounding box is shown whole; a shared view keeps its own camera.
  const box = liveStart({ key: 'b', name: 'Box', kind: 'bounding box', bbox: boundary.bbox }, undefined, 'streets')!;
  assert.deepEqual(box.camera, box.bounds);
  const shared = liveStart(boundary, { lon: 85.9, lat: 20.3, width: 1000, height: 800 }, 'all')!;
  assert.deepEqual([shared.origin, shared.camera], [[85.9, 20.3], undefined]);
  assert.equal(liveStart({ key: 'a', name: 'Area only', kind: 'city', areaId: '3600000001' }, undefined, 'streets'), undefined);
});

test('a bounding box across the antimeridian frames both sides', () => {
  const start = liveStart({ key: 'b', name: 'Fiji', kind: 'bounding box', bbox: [-17, 179.5, -16, -179.5] }, undefined, 'major')!;
  assert.ok(Math.abs(Math.abs(start.origin[0]) - 180) < 1e-9);
  const width = start.bounds.right - start.bounds.left;
  assert.ok(width > 100_000 && width < 150_000, `${width}`);
});

test('cached cells move exactly between projection origins', () => {
  const a: Origin = [85.8, 20.3], b: Origin = [85.83, 20.27];
  const point: [number, number] = [85.81, 20.31];
  const pa = projector([a[0], a[1], a[0], a[1]]).project(...point), pb = projector([b[0], b[1], b[0], b[1]]).project(...point);
  const moved = translate(new Float32Array([...pa, ...pa]), a, b)!;
  assert.ok(Math.abs(moved[0] - pb[0]) < 0.01 && Math.abs(moved[1] - pb[1]) < 0.01);
  const same = new Float32Array([1, 2, 3, 4]);
  assert.equal(translate(same, a, a), same);
  // Far translations would lose float32 precision, so they are cache misses.
  assert.equal(translate(same, a, [100, 20.3]), undefined);
});

test('load-city hands viewport loads to the live loader and never caches them as a city', async t => {
  const workers: { emit(value: WorkerResult): void; terminated: number; sent?: WorkerLoad }[] = [];
  class FixtureWorker {
    onmessage?: (event: MessageEvent<WorkerResult>) => void; onerror?: () => void; terminated = 0; sent?: WorkerLoad;
    constructor() { workers.push(this); }
    postMessage(value: WorkerLoad) { this.sent = value; }
    terminate() { this.terminated++; }
    emit(value: WorkerResult) { this.onmessage?.({ data: value } as MessageEvent<WorkerResult>); }
  }
  Object.defineProperty(globalThis, 'Worker', { value: FixtureWorker, configurable: true });
  t.after(() => { Reflect.deleteProperty(globalThis, 'Worker'); });
  const events: string[] = [];
  const options: WorkerLoad = { boundary: { key: 'osm-relation-1', name: 'City', kind: 'city', bbox: [20, 85, 21, 86] }, providers: { search: '', overpass: 'http://localhost/roads', cityDataBase: '', legacyCacheBase: '' }, useCache: false, allowLarge: true, detail: 'streets', viewport: true };
  const callbacks = { progress: () => {}, chunk: async () => { events.push('chunk'); }, done: async () => { events.push('done'); }, error: (message: string) => { events.push(`error:${message}`); }, large: () => { events.push('large'); } };
  t.after(loadCity(options, { ...callbacks, viewport: async () => { events.push('viewport'); } }));
  workers[0].emit({ type: 'viewport' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['viewport']); assert.equal(workers[0].terminated, 1); assert.equal(workers[0].sent?.viewport, true);
  // A worker that hands over without a viewport load is an error, not a blank map.
  t.after(loadCity({ ...options, viewport: undefined }, callbacks));
  workers[1].emit({ type: 'viewport' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['viewport', 'error:Live map loading is unavailable']);
});

test('the centre of the view loads first, makes the map exportable, and exports the rest as available', async () => {
  // A view centred in one major-road cell, wide enough to reach its neighbours east and west.
  const z = cellLevel(0, origin[1]), n = 2 ** z;
  const x = Math.floor((origin[0] + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + origin[1] * Math.PI / 360)) / Math.PI) / 2 * n);
  const cell = tileRect({ z, x, y }, origin), cx = (cell.left + cell.right) / 2, cy = (cell.bottom + cell.top) / 2;
  const unit = metresPerSceneUnit(origin[1]), halfWidth = 9_000 / unit, halfHeight = 6_000 / unit;
  const camera: Camera = { left: cx - halfWidth, right: cx + halfWidth, bottom: cy - halfHeight, top: cy + halfHeight };
  const fetches: CellRequest[] = [];
  const worker = { onmessage: undefined as undefined | ((event: { data: CellReply }) => void), onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') fetches.push(command); }, terminate() {} };
  const reply = (id: number) => worker.onmessage!({ data: { type: 'cell', id, positions: new ArrayBuffer(0), segments: 0, bytes: 0, fetchMs: 1, decodeMs: 0 } });
  const scene = { camera: () => camera, rotation: 0, appendGeometry: async () => undefined, removeOwner: () => 0 } as unknown as SceneController;
  // Unlimited concurrency issues every wanted request at once, in priority order.
  const viewport = new LiveViewport(scene, origin, 'streets', { overpass: 'http://localhost/roads', concurrency: 1000, budgetBytes: 1e9, createWorker: () => worker as unknown as Worker }, () => {});
  try {
    const core = { left: cx - halfWidth * LIVE_LIMITS.core, right: cx + halfWidth * LIVE_LIMITS.core, bottom: cy - halfHeight * LIVE_LIMITS.core, top: cy + halfHeight * LIVE_LIMITS.core };
    const central = (request: CellRequest) => { const box = tileRect(request.tile, origin); return box.left < core.right && box.right > core.left && box.bottom < core.top && box.top > core.bottom; };
    const first = fetches.findIndex(request => !central(request));
    assert.ok(first > 0, 'Both central and outer cells are requested');
    assert.ok(fetches.slice(first).every(request => !central(request)), 'Every central cell is requested before any other');
    assert.deepEqual(fetches.slice(0, first).map(request => request.rank), [...fetches.slice(0, first).map(request => request.rank)].sort(), 'Central major roads come before central streets');
    // Outside the centre, nearby streets come before major roads further out.
    assert.ok(fetches.slice(first).some(request => request.rank === 0), 'Major roads reach beyond the centre');
    assert.equal(fetches[first].rank, 1);
    assert.equal(viewport.coverage().exportable, false);
    for (const request of fetches.slice(0, first)) reply(request.id);
    await new Promise(resolve => setImmediate(resolve));
    const coverage = viewport.coverage();
    assert.equal(coverage.exportable, true); assert.equal(coverage.complete, false);
    // The centre is ready, so an export proceeds at once with the regions available.
    const progress: number[] = [];
    const partial = await viewport.prepareExport(camera, 0, new AbortController().signal, ready => progress.push(ready));
    assert.equal(partial.complete, false); assert.deepEqual(progress, []);
    const key = (request: CellRequest) => `${request.rank}:${request.tile.z}/${request.tile.x}/${request.tile.y}`;
    assert.ok(fetches.slice(0, first).every(request => partial.regions.has(key(request))) && partial.regions.size > first, 'The export holds the centre and the frame around it');
    for (const request of fetches.slice(first)) reply(request.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await viewport.prepareExport(camera, 0, new AbortController().signal, () => {})).complete, true);
  } finally { viewport.dispose(); }
});
