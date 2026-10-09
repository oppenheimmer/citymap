import Pbf from 'pbf';
import { responseBytes } from '../lib/data/response-body.ts';
import { place } from '../proto/place.js';
import { decodeChunk, geometryStats, manifestKey, roadPoints, validateManifest } from '../lib/data/city-cache.ts';
import type { ChunkDescriptor, CityManifest, CityRoadChunk, PointE7 } from '../lib/data/city-types.ts';
import { osmGeometry, pointBounds, polylineGeometry, projector, MAX_SEGMENTS } from '../lib/geometry.ts';
import { overpassQuery, roadRank } from '../lib/domain.ts';
import { BUNDLED_CITIES } from '../lib/bundled-cities.ts';
import type { LoadProgress, RoadDetail, RoadRank, SourceInfo } from '../lib/domain.ts';
import { RequestError, request } from '../lib/request.ts';
import type { WorkerCommand, WorkerLoad, WorkerResult } from '../lib/worker-protocol.ts';

const scope = self as unknown as { onmessage: (event: MessageEvent<WorkerCommand>) => void; postMessage: (message: WorkerResult, transfer?: Transferable[]) => void };
const abort = new AbortController();
let segmentCount = 0;
let started = false;
let r2RevisionSelected = false;
// Cached and fixture datasets contain every road class; live downloads only the requested ones.
let coverage: RoadDetail = 'all';
const progress = (progress: LoadProgress) => scope.postMessage({ type: 'progress', progress });
const sendChunk = (positions: Float32Array, frame: Pick<ReturnType<typeof projector>, 'bounds' | 'origin'>, index: number, rank: RoadRank) => {
  segmentCount += positions.length / 4;
  scope.postMessage({ type: 'chunk', positions: positions.buffer as ArrayBuffer, bounds: frame.bounds, origin: frame.origin, index, rank }, [positions.buffer as ArrayBuffer]);
};
// Major roads first, so the first frames show the city's structure.
const sendParts = (geometry: ReturnType<typeof osmGeometry>) => { for (const part of geometry.parts) sendChunk(part.positions, geometry, 0, part.rank); };
const LARGE_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
// A slow or unreachable dataset pointer falls back to live roads instead of holding the map.
const POINTER_DEADLINE = 8_000;
// Later chunks download while earlier ones are validated, projected and drawn.
const CHUNK_WINDOW = 3;
// Overpass may compute for up to its 120 s query timeout before streaming; longer stalls fail.
const OVERPASS_IDLE = 130_000;
const preparation = { downloadMs: 0, decodeMs: 0, indexMs: 0, projectMs: 0 };
function measure<T>(phase: keyof typeof preparation, work: () => T): T {
  const start = performance.now();
  try { return work(); } finally { preparation[phase] += performance.now() - start; }
}
let reportedAt = 0;
/** Throttled byte progress. Final reports always send, so the bar reaches the end. */
function reportBytes(message: string, bytes: number, total?: number, extra: Partial<LoadProgress> = {}, final = false) {
  const now = performance.now();
  if (!final && now - reportedAt < 100) return;
  reportedAt = now;
  progress({ stage: 'download', message, bytes, totalBytes: total, ...extra });
}
/** Content-Length, or undefined when absent. It counts encoded bytes, so the UI drops it if exceeded. */
function contentLength(response: Response) {
  const length = Number(response.headers.get('Content-Length'));
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}
type ByteProgress = (bytes: number, total: number | undefined, final: boolean) => void;

async function downloaded(url: string, options: RequestInit, limit: number, deadline?: number, onBytes?: ByteProgress): Promise<Uint8Array<ArrayBuffer>> {
  const start = performance.now();
  try {
    const response = await request(url, { ...options, signal: abort.signal }, deadline);
    const total = contentLength(response);
    const bytes = await responseBytes(response, limit, onBytes && (received => onBytes(received, total, false)));
    onBytes?.(bytes.byteLength, total, true);
    return bytes;
  }
  finally { preparation.downloadMs += performance.now() - start; }
}
function json(bytes: Uint8Array) { return measure('decodeMs', () => JSON.parse(new TextDecoder().decode(bytes))); }
function preparedJson(value: unknown) {
  const result = osmGeometry(value); preparation.indexMs += result.indexMs; preparation.projectMs += result.projectMs; return result;
}

async function checksum(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
interface ReceivedChunk { descriptor: ChunkDescriptor; chunk: CityRoadChunk; points: PointE7[][] }
function* degrees(chunks: ReceivedChunk[]): Generator<[number, number]> {
  for (const { points } of chunks) for (const road of points) for (const [lon, lat] of road) yield [lon / 1e7, lat / 1e7];
}

async function r2(load: WorkerLoad): Promise<SourceInfo> {
  const base = load.providers.cityDataBase;
  const cityKey = load.boundary.key;
  assert(/^osm-(node|way|relation)-[1-9][0-9]*$/.test(cityKey), 'No typed R2 city key');
  progress({ stage: 'cache', message: 'Looking for a cached city dataset…' });
  const pointer = load.boundary.revision && load.boundary.manifestSha256 ? {
    pointer_version: 1, city_key: cityKey, dataset_revision: load.boundary.revision,
    manifest: manifestKey(cityKey, load.boundary.revision), manifest_sha256: load.boundary.manifestSha256,
  } : json(await downloaded(`${base}/v2/cities/${cityKey}/latest.json`, { cache: 'no-cache' }, 16 * 1024, POINTER_DEADLINE));
  assert(pointer.pointer_version === 1 && pointer.city_key === cityKey && /^[a-f0-9]{64}$/.test(pointer.dataset_revision) && pointer.manifest === manifestKey(cityKey, pointer.dataset_revision) && /^[a-f0-9]{64}$/.test(pointer.manifest_sha256), 'Invalid city pointer');
  r2RevisionSelected = true;
  const manifestBytes = await downloaded(`${base}/${pointer.manifest}`, { cache: load.forceNetwork ? 'reload' : 'default' }, 16 * 1024 * 1024, 20_000);
  assert(manifestBytes.byteLength < 16 * 1024 * 1024 && await checksum(manifestBytes) === pointer.manifest_sha256, 'City manifest checksum mismatch');
  const value: unknown = json(manifestBytes);
  validateManifest(value);
  const manifest: CityManifest = value;
  assert(manifest.city_key === cityKey && manifest.dataset_revision === pointer.dataset_revision && manifest.source.kind !== 'synthetic', 'City manifest identity/source mismatch');
  assert(manifest.segment_count <= MAX_SEGMENTS, 'This city exceeds the geometry limit');
  const bytes = manifest.chunks.reduce((sum, chunk) => sum + chunk.wire_bytes, 0);
  if (bytes > LARGE_BYTES && !load.allowLarge) { scope.postMessage({ type: 'large', bytes }); throw new Error('Large download needs confirmation'); }
  const [west, east] = [manifest.bounds[0], manifest.bounds[2]];
  // Canonical manifest bounds span the globe when roads cross the antimeridian. Their wrapped
  // extent is only known after decoding, so those rare cities project once every chunk is valid.
  let projection = east - west > 180 ? undefined : projector(manifest.bounds);
  const deferred: ReceivedChunk[] = [];
  const fragments = new Map<string, { next: number; end: [number, number]; tags: string }>();
  let segments = 0;
  const chunks = manifest.chunks;
  // The manifest knows every chunk's decoded size, so city downloads have an exact total.
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.decoded_bytes, 0);
  const received = chunks.map(() => 0);
  let completed = 0;
  const reportChunks = (final: boolean) => reportBytes('Loading cached road chunks…', received.reduce((sum, bytes) => sum + bytes, 0), totalBytes, { completedChunks: completed, totalChunks: chunks.length }, final);
  const fetchChunk = async (descriptor: ChunkDescriptor) => {
    const decoded = await downloaded(`${base}/${descriptor.key}`, { cache: load.forceNetwork ? 'reload' : 'default' }, 64 * 1024 * 1024, undefined, (bytes, _total, final) => { received[descriptor.index] = bytes; reportChunks(final); });
    assert(decoded.byteLength === descriptor.decoded_bytes && await checksum(decoded) === descriptor.decoded_sha256, 'Cached chunk checksum/size mismatch');
    return { descriptor, chunk: measure('decodeMs', () => decodeChunk(decoded)) };
  };
  const pending: ReturnType<typeof fetchChunk>[] = [];
  const prefetch = (index: number) => {
    if (index >= chunks.length) return;
    const download = fetchChunk(chunks[index]);
    // Failures surface when this chunk is awaited, in manifest order.
    download.catch(() => {});
    pending.push(download);
  };
  const draw = ({ descriptor, chunk, points }: ReceivedChunk) => {
    progress({ stage: 'project', message: 'Preparing road geometry…', completedChunks: descriptor.index, totalChunks: chunks.length });
    for (const rank of [0, 1, 2] as const) {
      const positions = measure('projectMs', () => polylineGeometry(chunk.roads, projection!.project, (_road, index) => points[index], road => roadRank(road.highway) === rank));
      if (!positions.length) continue;
      segments += positions.length / 4;
      sendChunk(positions, projection!, descriptor.index, rank);
    }
    completed = descriptor.index + 1;
    reportChunks(true);
  };
  for (let index = 0; index < CHUNK_WINDOW; index++) prefetch(index);
  // Chunks are consumed in manifest order for deterministic fragment validation.
  for (let index = 0; index < chunks.length; index++) {
    const { descriptor, chunk } = await pending[index];
    prefetch(index + CHUNK_WINDOW);
    const indexingStarted = performance.now();
    assert(chunk.city_key === cityKey && chunk.dataset_revision === manifest.dataset_revision && chunk.chunk_index === descriptor.index && chunk.chunk_count === chunks.length && chunk.detail_level === 0, 'Cached chunks have mixed identity or detail');
    // Decode each road's deltas once for statistics, fragment checks and projection.
    const roadPointsList = chunk.roads.map(roadPoints);
    const stats = geometryStats(chunk.roads, (_road, roadIndex) => roadPointsList[roadIndex]);
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) assert(JSON.stringify(stats[key]) === JSON.stringify(descriptor[key]), 'Chunk geometry metadata mismatch');
    for (const [roadIndex, road] of chunk.roads.entries()) {
      const points = roadPointsList[roadIndex];
      const tags = JSON.stringify([road.highway, road.bridge, road.tunnel, road.layer]);
      const previous = fragments.get(road.osm_way_id);
      assert(road.fragment_index === (previous?.next ?? 0), 'Missing or duplicated road fragment');
      assert(!previous || previous.tags === tags && previous.end[0] === points[0][0] && previous.end[1] === points[0][1], 'Disconnected or inconsistent road fragments');
      fragments.set(road.osm_way_id, { next: road.fragment_index + 1, end: points.at(-1)!, tags });
    }
    preparation.indexMs += performance.now() - indexingStarted;
    const received = { descriptor, chunk, points: roadPointsList };
    if (projection) draw(received); else deferred.push(received);
  }
  if (!projection) {
    projection = projector(pointBounds(degrees(deferred)));
    deferred.forEach(draw);
  }
  assert(segments === manifest.segment_count && fragments.size === manifest.unique_way_count, 'City dataset is incomplete');
  return { kind: 'r2', downloadedAt: new Date().toISOString(), snapshotAt: manifest.source.snapshot_at, revision: manifest.dataset_revision, manifestSha256: pointer.manifest_sha256, complete: true, bundled: load.providers.cityDataBundled || undefined };
}

async function loadRoads(load: WorkerLoad): Promise<SourceInfo> {
  if (load.fixtureUrl) {
    progress({ stage: 'download', message: 'Loading sample roads…' });
    const data = json(await downloaded(load.fixtureUrl, { cache: load.forceNetwork ? 'reload' : 'default' }, MAX_BYTES, undefined, (bytes, total, final) => reportBytes('Loading sample roads…', bytes, total, {}, final)));
    progress({ stage: 'project', message: 'Preparing sample geometry…' });
    sendParts(preparedJson(data));
    return { kind: 'fixture', downloadedAt: new Date().toISOString(), snapshotAt: data.metadata?.source?.snapshot_at, complete: true };
  }
  // The app's bundled `/data` holds only listed cities; skip the lookup for every other city.
  const datasets = load.providers.cityDataBase && (!load.providers.cityDataBundled || BUNDLED_CITIES.includes(load.boundary.key));
  if (load.useCache && datasets && /^osm-/.test(load.boundary.key)) {
    try { return await r2(load); }
    catch (error) {
      // Before a revision is selected no cached geometry exists, so any pointer failure
      // (missing, unreachable, CORS, 5xx, timeout or invalid) can safely use live roads.
      // A pinned or selected revision fails visibly rather than mixing sources.
      if (abort.signal.aborted || r2RevisionSelected || load.boundary.revision || segmentCount > 0) throw error;
      const missing = error instanceof RequestError && [404, 410].includes(error.status || 0);
      progress({ stage: 'cache', message: missing ? 'City is not cached. Loading live roads…' : 'City cache is unavailable. Loading live roads…' });
    }
  }
  if (load.useCache && load.providers.legacyCacheBase && load.boundary.areaId) {
    try {
      progress({ stage: 'download', message: 'Loading the legacy city cache…' });
      const bytes = await downloaded(`${load.providers.legacyCacheBase}/${load.boundary.areaId}.pbf`, { cache: load.forceNetwork ? 'reload' : 'default' }, 64 * 1024 * 1024, undefined, (received, total, final) => reportBytes('Loading the legacy city cache…', received, total, {}, final));
      const data = measure('decodeMs', () => place.read(new Pbf(bytes)));
      assert(data.version === 1, 'Unsupported legacy cache version');
      const elements = [ ...data.nodes.map(node => ({ ...node, type: 'node' })), ...data.ways.map((way, index) => ({ ...way, id: String(index + 1), type: 'way' })) ];
      sendParts(preparedJson({ elements }));
      return { kind: 'legacy', downloadedAt: new Date().toISOString(), snapshotAt: data.date || undefined, complete: true };
    } catch (error) {
      // Legacy geometry is sent only after a complete decode, so failures can use live roads.
      if (abort.signal.aborted || segmentCount > 0) throw error;
      progress({ stage: 'cache', message: 'Legacy city cache is unavailable. Loading live roads…' });
    }
  }
  // Overpass computes the whole query before streaming, so this wait can be long and silent.
  progress({ stage: 'download', message: 'Waiting for the road service…' });
  if (!load.allowLarge) { scope.postMessage({ type: 'large', bytes: 0 }); throw new Error('Live download needs confirmation'); }
  const downloadStarted = performance.now();
  coverage = load.detail;
  const response = await request(load.providers.overpass, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(load.boundary, load.detail) }), signal: abort.signal }, 150_000);
  const length = Number(response.headers.get('Content-Length'));
  assert(!length || length <= MAX_BYTES, 'This download exceeds the response limit. Choose a smaller area.');
  if (length > LARGE_BYTES && !load.allowLarge) { await response.body?.cancel(); scope.postMessage({ type: 'large', bytes: length }); throw new Error('Large download needs confirmation'); }
  const liveBytes = (bytes: number, final: boolean) => reportBytes('Downloading live roads…', bytes, length || undefined, {}, final);
  const body = await responseBytes(response, MAX_BYTES, bytes => liveBytes(bytes, false), OVERPASS_IDLE);
  liveBytes(body.byteLength, true);
  preparation.downloadMs += performance.now() - downloadStarted;
  const data = json(body);
  if (typeof data.remark === 'string') throw new Error('The road provider could not complete this query. Retry or choose a smaller area.');
  progress({ stage: 'project', message: 'Indexing and projecting roads…' });
  let geometry: ReturnType<typeof osmGeometry>;
  try { geometry = preparedJson(data); }
  catch (error) {
    if (load.detail !== 'all' && error instanceof Error && error.message.startsWith('No roads')) throw new Error('No roads at this road detail were found here. Choose more road detail.', { cause: error });
    throw error;
  }
  sendParts(geometry);
  return { kind: 'live', downloadedAt: new Date().toISOString(), snapshotAt: data.osm3s?.timestamp_osm_base, complete: true };
}

scope.onmessage = async event => {
  if ('type' in event.data && event.data.type === 'cancel') {
    abort.abort();
    // Let the fetch abort reach the browser's network process before termination.
    await new Promise(resolve => setTimeout(resolve, 0));
    scope.postMessage({ type: 'cancelled' });
    return;
  }
  if (started) return;
  started = true;
  loadRoads(event.data as WorkerLoad).then(source => scope.postMessage({ type: 'done', source, segmentCount, coverage, preparation })).catch(error => { if (!abort.signal.aborted) scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Road loading failed' }); });
};
