import Pbf from 'pbf';
import { responseBytes } from '../lib/data/response-body.ts';
import { place } from '../proto/place.js';
import { decodeChunk, geometryStats, manifestKey, roadPoints, validateManifest } from '../lib/data/city-cache.ts';
import type { CityManifest } from '../lib/data/city-types.ts';
import { osmGeometry, polylineGeometry, projector, MAX_SEGMENTS } from '../lib/geometry.ts';
import { overpassQuery } from '../lib/domain.ts';
import type { LoadProgress, SourceInfo } from '../lib/domain.ts';
import { RequestError, request } from '../lib/request.ts';
import type { WorkerCommand, WorkerLoad, WorkerResult } from '../lib/worker-protocol.ts';

const scope = self as unknown as { onmessage: (event: MessageEvent<WorkerCommand>) => void; postMessage: (message: WorkerResult, transfer?: Transferable[]) => void };
const abort = new AbortController();
let segmentCount = 0;
let started = false;
let r2RevisionSelected = false;
const progress = (progress: LoadProgress) => scope.postMessage({ type: 'progress', progress });
const sendChunk = (positions: Float32Array, bounds: ReturnType<typeof projector>['bounds'], index: number) => {
  segmentCount += positions.length / 4;
  scope.postMessage({ type: 'chunk', positions: positions.buffer as ArrayBuffer, bounds, index }, [positions.buffer as ArrayBuffer]);
};
const LARGE_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const preparation = { downloadMs: 0, decodeMs: 0, indexMs: 0, projectMs: 0 };
function measure<T>(phase: keyof typeof preparation, work: () => T): T {
  const start = performance.now();
  try { return work(); } finally { preparation[phase] += performance.now() - start; }
}
async function downloaded(url: string, options: RequestInit, limit: number, deadline?: number): Promise<Uint8Array<ArrayBuffer>> {
  const start = performance.now();
  try { return await responseBytes(await request(url, { ...options, signal: abort.signal }, deadline), limit); }
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

async function r2(load: WorkerLoad): Promise<SourceInfo> {
  const base = load.providers.cityDataBase;
  const cityKey = load.boundary.key;
  assert(/^osm-(node|way|relation)-[1-9][0-9]*$/.test(cityKey), 'No typed R2 city key');
  progress({ stage: 'cache', message: 'Looking for a cached city dataset…' });
  const pointer = load.boundary.revision && load.boundary.manifestSha256 ? {
    pointer_version: 1, city_key: cityKey, dataset_revision: load.boundary.revision,
    manifest: manifestKey(cityKey, load.boundary.revision), manifest_sha256: load.boundary.manifestSha256,
  } : json(await downloaded(`${base}/v2/cities/${cityKey}/latest.json`, { cache: 'no-cache' }, 16 * 1024, 20_000));
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
  const [west, south, east, north] = manifest.bounds;
  const projection = projector(east - west > 180 ? [east, south, west + 360, north] : manifest.bounds);
  const fragments = new Map<string, { next: number; end: [number, number]; tags: string }>();
  let segments = 0;
  const chunks = manifest.chunks;
  // Two downloads at a time, consumed in manifest order for deterministic fragment validation.
  for (let start = 0; start < chunks.length; start += 2) {
    const received = await Promise.all(chunks.slice(start, start + 2).map(async descriptor => {
      const decoded = await downloaded(`${base}/${descriptor.key}`, { cache: load.forceNetwork ? 'reload' : 'default' }, 64 * 1024 * 1024);
      assert(decoded.byteLength === descriptor.decoded_bytes && await checksum(decoded) === descriptor.decoded_sha256, 'Cached chunk checksum/size mismatch');
      return { descriptor, chunk: measure('decodeMs', () => decodeChunk(decoded)) };
    }));
    for (const { descriptor, chunk } of received) {
      const indexingStarted = performance.now();
      assert(chunk.city_key === cityKey && chunk.dataset_revision === manifest.dataset_revision && chunk.chunk_index === descriptor.index && chunk.chunk_count === chunks.length && chunk.detail_level === 0, 'Cached chunks have mixed identity or detail');
      const stats = geometryStats(chunk.roads);
      for (const key of Object.keys(stats) as (keyof typeof stats)[]) assert(JSON.stringify(stats[key]) === JSON.stringify(descriptor[key]), 'Chunk geometry metadata mismatch');
      for (const road of chunk.roads) {
        const points = roadPoints(road);
        const tags = JSON.stringify([road.highway, road.bridge, road.tunnel, road.layer]);
        const previous = fragments.get(road.osm_way_id);
        assert(road.fragment_index === (previous?.next ?? 0), 'Missing or duplicated road fragment');
        assert(!previous || previous.tags === tags && previous.end[0] === points[0][0] && previous.end[1] === points[0][1], 'Disconnected or inconsistent road fragments');
        fragments.set(road.osm_way_id, { next: road.fragment_index + 1, end: points.at(-1)!, tags });
      }
      preparation.indexMs += performance.now() - indexingStarted;
      progress({ stage: 'project', message: 'Preparing road geometry…', completedChunks: descriptor.index, totalChunks: chunks.length });
      const positions = measure('projectMs', () => polylineGeometry(chunk.roads, projection.project));
      segments += positions.length / 4;
      sendChunk(positions, projection.bounds, descriptor.index);
      progress({ stage: 'download', message: 'Loading cached road chunks…', completedChunks: descriptor.index + 1, totalChunks: chunks.length });
    }
  }
  assert(segments === manifest.segment_count && fragments.size === manifest.unique_way_count, 'City dataset is incomplete');
  return { kind: 'r2', downloadedAt: new Date().toISOString(), snapshotAt: manifest.source.snapshot_at, revision: manifest.dataset_revision, manifestSha256: pointer.manifest_sha256, complete: true };
}

async function loadRoads(load: WorkerLoad): Promise<SourceInfo> {
  if (load.fixtureUrl) {
    progress({ stage: 'download', message: 'Loading sample roads…' });
    const data = json(await downloaded(load.fixtureUrl, { cache: load.forceNetwork ? 'reload' : 'default' }, MAX_BYTES));
    progress({ stage: 'project', message: 'Preparing sample geometry…' });
    const geometry = preparedJson(data);
    sendChunk(geometry.positions, geometry.bounds, 0);
    return { kind: 'fixture', downloadedAt: new Date().toISOString(), snapshotAt: data.metadata?.source?.snapshot_at, complete: true };
  }
  if (load.useCache && load.providers.cityDataBase && /^osm-/.test(load.boundary.key)) {
    try { return await r2(load); }
    catch (error) {
      // Once partial geometry exists, restarting via fallback must use a fresh scene.
      if (r2RevisionSelected || load.boundary.revision || segmentCount > 0) throw error;
      if (error instanceof Error && /confirmation|fragment|incomplete|identity|geometry|checksum/.test(error.message)) throw error;
      if (!(error instanceof RequestError) || ![404, 410].includes(error.status || 0)) throw error;
      progress({ stage: 'cache', message: 'City is not cached. Loading live roads…' });
    }
  }
  if (load.useCache && load.providers.legacyCacheBase && load.boundary.areaId) {
    try {
      progress({ stage: 'download', message: 'Loading the legacy city cache…' });
      const bytes = await downloaded(`${load.providers.legacyCacheBase}/${load.boundary.areaId}.pbf`, { cache: load.forceNetwork ? 'reload' : 'default' }, 64 * 1024 * 1024);
      const data = measure('decodeMs', () => place.read(new Pbf(bytes)));
      assert(data.version === 1, 'Unsupported legacy cache version');
      const elements = [ ...data.nodes.map(node => ({ ...node, type: 'node' })), ...data.ways.map((way, index) => ({ ...way, id: String(index + 1), type: 'way' })) ];
      const geometry = preparedJson({ elements });
      sendChunk(geometry.positions, geometry.bounds, 0);
      return { kind: 'legacy', downloadedAt: new Date().toISOString(), snapshotAt: data.date || undefined, complete: true };
    } catch (error) {
      if (!(error instanceof RequestError) || ![404, 410].includes(error.status || 0)) throw error;
    }
  }
  progress({ stage: 'download', message: 'Downloading live OpenStreetMap roads…' });
  if (!load.allowLarge) { scope.postMessage({ type: 'large', bytes: 0 }); throw new Error('Live download needs confirmation'); }
  const downloadStarted = performance.now();
  const response = await request(load.providers.overpass, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(load.boundary) }), signal: abort.signal });
  const length = Number(response.headers.get('Content-Length'));
  assert(!length || length <= MAX_BYTES, 'This download exceeds the response limit. Choose a smaller area.');
  if (length > LARGE_BYTES && !load.allowLarge) { await response.body?.cancel(); scope.postMessage({ type: 'large', bytes: length }); throw new Error('Large download needs confirmation'); }
  const body = await responseBytes(response, MAX_BYTES);
  preparation.downloadMs += performance.now() - downloadStarted;
  const data = json(body);
  if (typeof data.remark === 'string') throw new Error('The road provider could not complete this query. Retry or choose a smaller area.');
  progress({ stage: 'project', message: 'Indexing and projecting roads…', bytes: length || undefined });
  const geometry = preparedJson(data);
  sendChunk(geometry.positions, geometry.bounds, 0);
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
  loadRoads(event.data as WorkerLoad).then(source => scope.postMessage({ type: 'done', source, segmentCount, preparation })).catch(error => { if (!abort.signal.aborted) scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Road loading failed' }); });
};
