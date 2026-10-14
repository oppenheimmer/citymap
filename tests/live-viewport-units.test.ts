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
import { cameraFromView, viewFromCamera } from '../src/lib/view.ts';
import { loadCity } from '../src/lib/load-city.ts';
import type { Camera, Origin } from '../src/lib/domain.ts';

const origin: Origin = [85.8245, 20.2961];
const tile = { z: 13, x: 6049, y: 3600 };
/** The cell at zoom `z` holding the origin. */
const originTile = (z: number) => { const n = 2 ** z; return { z, x: Math.floor((origin[0] + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + origin[1] * Math.PI / 360)) / Math.PI) / 2 * n) }; };

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
  worker.send({ type: 'fetch', id: 7, cells: [{ tile, rank: 1 }], origin, overpass: 'http://localhost/roads' });
  const message = await reply;
  assert.equal(message.type, 'cells');
  if (message.type !== 'cells') return;
  assert.match(queries[0], /residential/); assert.doesNotMatch(queries[0], /area|primary/);
  const positions = new Float32Array(message.cells[0].positions), rect = tileRect(tile, origin);
  assert.deepEqual([message.id, message.cells.length, message.cells[0].segments, positions.length, message.snapshotAt], [7, 1, 1, 4, '2026-10-01T00:00:00Z']);
  assert.ok(Math.abs(positions[0] - rect.left) < 0.01 && Math.abs(positions[2] - rect.right) < 0.01, 'The street is clipped to the cell edges');
  assert.ok(message.bytes > 0 && message.fetchMs >= 0 && message.decodeMs >= 0);
});

test('one request fetches several cells, and each keeps only its own rank, clipped to it', async t => {
  const east = { ...tile, x: tile.x + 1 }, major = { z: 11, x: tile.x >> 2, y: tile.y >> 2 };
  const [south, west, north] = tileBBox(tile), far = tileBBox(east)[3];
  const queries: string[] = [];
  const worker = await cellsWorker(t, async body => {
    queries.push(body);
    // One street across both street cells, and a major road through the major cell.
    return new Response(JSON.stringify({ elements: [
      { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [{ lat: (south + north) / 2, lon: west - 0.01 }, { lat: (south + north) / 2, lon: far + 0.01 }] },
      { type: 'way', id: 2, tags: { highway: 'primary' }, geometry: [{ lat: (south + north) / 2, lon: west - 1 }, { lat: (south + north) / 2, lon: far + 1 }] },
    ] }));
  });
  const reply = worker.next();
  worker.send({ type: 'fetch', id: 8, cells: [{ tile, rank: 1 }, { tile: east, rank: 1 }, { tile: major, rank: 0 }], origin, overpass: 'http://localhost/roads' });
  const message = await reply;
  assert.equal(message.type, 'cells');
  if (message.type !== 'cells') return;
  assert.equal(queries.length, 1); assert.match(queries[0], /\[timeout:50\].*;\(way.*;way.*;way.*;\);out geom qt;$/);
  const [first, second, roads] = message.cells.map(cell => new Float32Array(cell.positions));
  const rect = tileRect(tile, origin), next = tileRect(east, origin), wide = tileRect(major, origin);
  // The street meets exactly at the shared edge; the major road is only in the major cell.
  assert.deepEqual([first.length, second.length, roads.length], [4, 4, 4]);
  assert.ok(Math.abs(first[0] - rect.left) < 0.01 && first[2] === second[0] && Math.abs(second[2] - next.right) < 0.01);
  assert.ok(Math.abs(roads[0] - wide.left) < 0.01 && Math.abs(roads[2] - wide.right) < 0.01);
});

test('the cells worker reports typed failures, rejects invalid requests and stays silent after an abort', async t => {
  let requests = 0, aborted = false;
  const worker = await cellsWorker(t, async (_body, signal) => {
    if (++requests === 1) return new Response(JSON.stringify({ remark: 'runtime error: Query timed out' }));
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }));
  });
  let reply = worker.next();
  worker.send({ type: 'fetch', id: 1, cells: [{ tile, rank: 1 }], origin, overpass: 'http://localhost/roads' });
  let message = await reply;
  assert.deepEqual([message.type, message.type === 'failure' && message.code, message.type === 'failure' && message.remark], ['failure', 'timeout_or_resource_limit', 'runtime error: Query timed out']);
  for (const cells of [[{ tile: { z: 13, x: 9000, y: -1 }, rank: 1 as const }], [], Array.from({ length: 9 }, () => ({ tile, rank: 1 as const }))]) {
    reply = worker.next();
    worker.send({ type: 'fetch', id: 2, cells, origin, overpass: 'http://localhost/roads' });
    message = await reply;
    assert.deepEqual([message.type, message.type === 'failure' && message.code], ['failure', 'invalid_request']);
  }
  assert.equal(requests, 1, 'Invalid requests never reach the road service');
  worker.send({ type: 'fetch', id: 3, cells: [{ tile, rank: 1 }], origin, overpass: 'http://localhost/roads' });
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
  const { z, x, y } = originTile(cellLevel(0, origin[1]));
  const cell = tileRect({ z, x, y }, origin), cx = (cell.left + cell.right) / 2, cy = (cell.bottom + cell.top) / 2;
  const unit = metresPerSceneUnit(origin[1]), halfWidth = 9_000 / unit, halfHeight = 6_000 / unit;
  const camera: Camera = { left: cx - halfWidth, right: cx + halfWidth, bottom: cy - halfHeight, top: cy + halfHeight };
  const requests: CellRequest[] = [];
  const worker = { onmessage: undefined as undefined | ((event: { data: CellReply }) => void), onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') requests.push(command); }, terminate() {} };
  const reply = (request: CellRequest) => worker.onmessage!({ data: { type: 'cells', id: request.id, cells: request.cells.map(() => ({ positions: new ArrayBuffer(0), segments: 0 })), bytes: 0, fetchMs: 1, decodeMs: 0 } });
  const scene = { frame: () => camera, rotation: 0, appendGeometry: async () => undefined, removeOwner: () => 0 } as unknown as SceneController;
  // Unlimited concurrency issues every wanted request at once, in priority order.
  const viewport = new LiveViewport(scene, origin, 'streets', { overpass: 'http://localhost/roads', concurrency: 1000, budgetBytes: 1e9, createWorker: () => worker as unknown as Worker }, () => {});
  try {
    const core = { left: cx - halfWidth * LIVE_LIMITS.core, right: cx + halfWidth * LIVE_LIMITS.core, bottom: cy - halfHeight * LIVE_LIMITS.core, top: cy + halfHeight * LIVE_LIMITS.core };
    type Cell = CellRequest['cells'][number];
    const central = (cell: Cell) => { const box = tileRect(cell.tile, origin); return box.left < core.right && box.right > core.left && box.bottom < core.top && box.top > core.bottom; };
    // Requests combine the next cells in loading order.
    const fetches = requests.flatMap(request => request.cells);
    assert.ok(requests.length < fetches.length && requests.every(request => request.cells.length <= LIVE_LIMITS.batch));
    const first = fetches.findIndex(cell => !central(cell));
    assert.ok(first > 0, 'Both central and outer cells are requested');
    assert.ok(fetches.slice(first).every(cell => !central(cell)), 'Every central cell is requested before any other');
    assert.deepEqual(fetches.slice(0, first).map(cell => cell.rank), [...fetches.slice(0, first).map(cell => cell.rank)].sort(), 'Central major roads come before central streets');
    // Outside the centre, nearby streets come before major roads further out.
    assert.ok(fetches.slice(first).some(cell => cell.rank === 0), 'Major roads reach beyond the centre');
    assert.equal(fetches[first].rank, 1);
    assert.equal(viewport.coverage().exportable, false);
    const centred = requests.filter(request => request.cells.some(central)), outer = requests.filter(request => !centred.includes(request));
    assert.ok(outer.length > 0);
    for (const request of centred) reply(request);
    await new Promise(resolve => setImmediate(resolve));
    const coverage = viewport.coverage();
    assert.equal(coverage.exportable, true); assert.equal(coverage.complete, false);
    // The centre is ready, so an export proceeds at once with the regions available, requesting nothing.
    const asked = requests.length, partial = viewport.exportRegions(camera, 0);
    assert.equal(partial.complete, false); assert.equal(requests.length, asked);
    const key = (cell: Cell) => `${cell.rank}:${cell.tile.z}/${cell.tile.x}/${cell.tile.y}`;
    assert.ok(fetches.slice(0, first).every(cell => partial.regions.has(key(cell))) && partial.regions.size > first, 'The export holds the centre and the frame around it');
    for (const request of outer) reply(request);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(viewport.exportRegions(camera, 0).complete, true);
  } finally { viewport.dispose(); }
});

test('exports preserve loaded roads after zooming out beyond their loading limits, at the selected detail', async () => {
  const { z, x, y } = originTile(cellLevel(2, origin[1]));
  const small = tileRect({ z, x, y }, origin), cx = (small.left + small.right) / 2, cy = (small.bottom + small.top) / 2;
  let camera: Camera = { left: cx - (small.right - small.left) / 5, right: cx + (small.right - small.left) / 5, bottom: cy - (small.top - small.bottom) / 5, top: cy + (small.top - small.bottom) / 5 };
  const requests: CellRequest[] = [], drawn = new Set<string>();
  const worker = { onmessage: undefined as undefined | ((event: { data: CellReply }) => void), onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') requests.push(command); }, terminate() {} };
  const reply = (request: CellRequest) => worker.onmessage!({ data: { type: 'cells', id: request.id, cells: request.cells.map(({ tile }) => {
    const box = tileRect(tile, origin);
    return { positions: new Float32Array([box.left, (box.bottom + box.top) / 2, box.right, (box.bottom + box.top) / 2]).buffer, segments: 1 };
  }), bytes: request.cells.length * 16, fetchMs: 1, decodeMs: 0 } });
  const scene = { frame: () => camera, rotation: 0, appendGeometry: async (_positions: Float32Array, _rank: number, _signal: AbortSignal | undefined, owner?: string) => { if (owner) drawn.add(owner); }, removeOwner: (owner: string) => { drawn.delete(owner); return 0; } } as unknown as SceneController;
  const viewport = new LiveViewport(scene, origin, 'all', { overpass: 'http://localhost/roads', concurrency: 1000, budgetBytes: 1e9, createWorker: () => worker as unknown as Worker }, () => {});
  try {
    for (const request of requests) reply(request);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...new Set(requests.flatMap(request => request.cells.map(cell => cell.rank)))].sort(), [0, 1, 2]);
    assert.equal(viewport.coverage().complete, true);
    const loadedDetail = [...drawn].filter(key => !key.startsWith('0:'));
    assert.ok(loadedDetail.length >= 2, 'Streets and finer roads are already drawn before zooming out');
    const loadedRequests = requests.length;
    // The expanded frame is still small enough to load major roads, but exceeds the
    // 36-cell limit for streets and finer roads. Previously loaded detail stays drawn.
    const street = tileRect({ z: z - 2, x: x >> 2, y: y >> 2 }, origin);
    const halfWidth = (street.right - street.left) * 4, halfHeight = (street.top - street.bottom) * 4;
    camera = { left: cx - halfWidth, right: cx + halfWidth, bottom: cy - halfHeight, top: cy + halfHeight };
    viewport.viewChanged();
    await new Promise(resolve => setTimeout(resolve, LIVE_LIMITS.debounceMs + 50));
    assert.deepEqual(viewport.coverage().limited, [1, 2]);
    for (const request of requests.slice(loadedRequests)) reply(request);
    await new Promise(resolve => setImmediate(resolve));
    const exported = viewport.exportRegions(camera, 0);
    assert.ok(loadedDetail.every(key => drawn.has(key)), 'The screen retains the loaded streets and finer roads');
    assert.ok(loadedDetail.every(key => exported.regions.has(key)), 'Export includes every loaded detail owner visible in the frame');
    assert.equal(exported.complete, false, 'Keeping loaded detail does not claim the wide frame is fully loaded');
    assert.ok(requests.slice(loadedRequests).flatMap(request => request.cells).every(cell => cell.rank === 0), 'Neither zooming out nor exporting fetches a limited detail rank');
    viewport.setDetail('major');
    const major = viewport.exportRegions(camera, 0);
    assert.ok(loadedDetail.every(key => !major.regions.has(key)), 'Loaded detail hidden by the selected road setting stays out of export');
  } finally { viewport.dispose(); }
});

test('a map zoomed out too far for any road class to load is exportable at once, unless its centre is beyond the radius', () => {
  // About 150 km across needs far more than 36 major-road cells, so nothing loads.
  const width = 150_000 / metresPerSceneUnit(origin[1]);
  const at = (km: number): Camera => cameraFromView({ lon: origin[0] + km * 1000 / (111_320 * Math.cos(origin[1] * Math.PI / 180)), lat: origin[1], width, height: width * 0.75 }, origin);
  const requests: CellRequest[] = [];
  const worker = { onmessage: undefined, onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') requests.push(command); }, terminate() {} };
  const open = (camera: Camera) => new LiveViewport({ frame: () => camera, rotation: 0, appendGeometry: async () => undefined, removeOwner: () => 0 } as unknown as SceneController, origin, 'major', { overpass: 'http://localhost/roads', concurrency: 1000, budgetBytes: 1e9, createWorker: () => worker as unknown as Worker }, () => {});
  const near = open(at(0));
  try {
    const coverage = near.coverage();
    assert.deepEqual(coverage.limited, [0]); assert.equal(coverage.exportable, true); assert.equal(requests.length, 0);
    assert.equal(near.exportRegions(at(0), 0).complete, false, 'The roads drawn are not the whole frame');
  } finally { near.dispose(); }
  // With its centre 80 km from the start, beyond the 50 km radius, the map cannot be exported.
  const far = open(at(80));
  try {
    const coverage = far.coverage();
    assert.deepEqual(coverage.limited, [0]); assert.equal(coverage.exportable, false);
  } finally { far.dispose(); }
});

test('an export is complete only once every loaded region of its frame is drawn', async () => {
  // A small view in the middle of one major-road cell.
  const cell = tileRect(originTile(cellLevel(0, origin[1])), origin), cx = (cell.left + cell.right) / 2, cy = (cell.bottom + cell.top) / 2;
  const halfWidth = (cell.right - cell.left) / 10, halfHeight = (cell.top - cell.bottom) / 10;
  const camera: Camera = { left: cx - halfWidth, right: cx + halfWidth, bottom: cy - halfHeight, top: cy + halfHeight };
  const requests: CellRequest[] = [];
  const worker = { onmessage: undefined as undefined | ((event: { data: CellReply }) => void), onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') requests.push(command); }, terminate() {} };
  let draw = () => {};
  const drawing = new Promise<void>(resolve => { draw = resolve; });
  const scene = { frame: () => camera, rotation: 0, appendGeometry: async () => { await drawing; return undefined; }, removeOwner: () => 0 } as unknown as SceneController;
  const viewport = new LiveViewport(scene, origin, 'major', { overpass: 'http://localhost/roads', concurrency: 1000, budgetBytes: 1e9, createWorker: () => worker as unknown as Worker }, () => {});
  try {
    for (const request of requests) worker.onmessage!({ data: { type: 'cells', id: request.id, cells: request.cells.map(() => ({ positions: new Float32Array([cx, cy, cx + 1, cy]).buffer, segments: 1 })), bytes: 16, fetchMs: 1, decodeMs: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(viewport.coverage().complete, true);
    assert.equal(viewport.exportRegions(camera, 0).complete, false, 'A loaded region still being drawn is missing from the export');
    draw();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(viewport.exportRegions(camera, 0).complete, true);
  } finally { viewport.dispose(); }
});

test('regions in view are evicted after those out of view, even at road classes too dense to load at this zoom', async () => {
  const { z, x, y } = originTile(cellLevel(1, origin[1]));
  // A square `cells` street cells across, around the street cell `dx` cells east of the start's.
  const around = (dx: number, cells: number): Camera => {
    const box = tileRect({ z, x: x + dx, y }, origin), cx = (box.left + box.right) / 2, cy = (box.bottom + box.top) / 2, half = (box.right - box.left) * cells / 2;
    return { left: cx - half, right: cx + half, bottom: cy - half, top: cy + half };
  };
  let camera = around(0, 0.2);
  const requests: CellRequest[] = [], drawn = new Set<string>();
  const worker = { onmessage: undefined as undefined | ((event: { data: CellReply }) => void), onerror: undefined, postMessage(command: CellCommand) { if (command.type === 'fetch') requests.push(command); }, terminate() {} };
  // Street regions weigh 16 kB and major-road regions 16 bytes: the budget holds two street regions and a few major ones.
  const reply = (request: CellRequest) => worker.onmessage!({ data: { type: 'cells', id: request.id, cells: request.cells.map(({ rank }) => { const segments = rank ? 1000 : 1; return { positions: new Float32Array(segments * 4).buffer, segments }; }), bytes: 0, fetchMs: 1, decodeMs: 0 } });
  const scene = { frame: () => camera, rotation: 0, appendGeometry: async (_positions: Float32Array, _rank: number, _signal: AbortSignal | undefined, owner?: string) => { if (owner) drawn.add(owner); }, removeOwner: (owner: string) => { drawn.delete(owner); return 0; } } as unknown as SceneController;
  const viewport = new LiveViewport(scene, origin, 'streets', { overpass: 'http://localhost/roads', concurrency: 1000, budgetBytes: 2 * 16_000 + 100, createWorker: () => worker as unknown as Worker }, () => {});
  const load = async () => { for (const request of requests.splice(0)) reply(request); await new Promise(resolve => setImmediate(resolve)); };
  const move = async (next: Camera) => { camera = next; viewport.viewChanged(); await new Promise(resolve => setTimeout(resolve, LIVE_LIMITS.debounceMs + 50)); await load(); };
  const shown = `1:${z}/${x}/${y}`, away = `1:${z}/${x + 6}/${y}`;
  try {
    // Streets load beside the start, then about 28 km east.
    await load();
    await move(around(6, 0.2));
    assert.ok(drawn.has(shown) && drawn.has(away));
    // Zoomed out over the start, streets are too dense to load and the eastern ones are out of
    // view; the major roads that load exceed the budget.
    await move(around(0, 8));
    assert.deepEqual(viewport.coverage().limited, [1]);
    assert.ok(drawn.has(shown), 'Streets in view stay drawn');
    assert.ok(!drawn.has(away), 'Streets out of view are evicted first');
  } finally { viewport.dispose(); }
});
