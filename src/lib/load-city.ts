import { getCity, putCity } from './city-storage.ts';
import type { Geometry, LoadProgress, Origin } from './domain.ts';
import type { WorkerLoad, WorkerResult } from './worker-protocol.ts';

export interface LoadCallbacks {
  progress(progress: LoadProgress): void;
  chunk(positions: Float32Array, bounds: Geometry['bounds'], origin: Origin): Promise<void>;
  done(geometry: Geometry): Promise<void>;
  error(message: string): void;
  large(bytes: number): void;
}

/** Local geometry for this load. A pinned revision may already be saved under the city key. */
async function cachedCity(options: WorkerLoad): Promise<Geometry | undefined> {
  const { key, revision, manifestSha256 } = options.boundary;
  if (!revision) return getCity(key);
  const pinned = await getCity(`${key}@${revision}`);
  if (pinned) return pinned;
  const latest = await getCity(key);
  return latest?.source.kind === 'r2' && latest.source.revision === revision && latest.source.manifestSha256 === manifestSha256 ? latest : undefined;
}

export function loadCity(options: WorkerLoad & { forceNetwork?: boolean }, callbacks: LoadCallbacks): () => void {
  const cacheKey = options.boundary.revision ? `${options.boundary.key}@${options.boundary.revision}` : options.boundary.key;
  let disposed = false;
  let worker: Worker | undefined;
  const buffers: Float32Array[] = [];
  let bounds: Geometry['bounds'] | undefined;
  let origin: Origin | undefined;
  const stop = () => {
    disposed = true;
    const current = worker; worker = undefined;
    if (!current) return;
    // Abort the worker's fetch before terminating background execution.
    let terminated = false;
    const finish = () => {
      if (terminated) return;
      terminated = true; clearTimeout(deadline); current.terminate();
    };
    const deadline = setTimeout(finish, 100);
    current.onmessage = (event: MessageEvent<WorkerResult>) => { if (event.data.type === 'cancelled') finish(); };
    current.onerror = finish;
    try { current.postMessage({ type: 'cancel' }); } catch { finish(); }
  };
  (async () => {
    if (options.useCache && !options.forceNetwork) {
      callbacks.progress({ stage: 'cache', message: 'Checking saved city geometry…' });
      const cached = await cachedCity(options);
      if (disposed) return;
      if (cached) {
        for (const buffer of cached.buffers) { if (disposed) return; await callbacks.chunk(buffer, cached.bounds, cached.origin); }
        if (!disposed) await callbacks.done(cached);
        return;
      }
    }
    if (disposed) return;
    worker = new Worker(new URL('../workers/roads.worker.ts', import.meta.url), { type: 'module' });
    let queue = Promise.resolve();
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      queue = queue.then(async () => {
        if (disposed) return;
        const message = event.data;
        if (message.type === 'progress') callbacks.progress(message.progress);
        else if (message.type === 'chunk') {
          const positions = new Float32Array(message.positions);
          if (positions.length % 4 || !positions.length) throw new Error('Invalid prepared geometry buffer');
          buffers.push(positions); bounds = message.bounds; origin = message.origin;
          await callbacks.chunk(positions, bounds, origin);
        } else if (message.type === 'done') {
          worker?.terminate(); worker = undefined;
          if (!bounds || !origin || buffers.reduce((sum, buffer) => sum + buffer.length / 4, 0) !== message.segmentCount || !message.source.complete) throw new Error('City loading finished with incomplete geometry');
          const geometry: Geometry = { buffers, bounds, origin, segmentCount: message.segmentCount, source: message.source, preparation: message.preparation };
          await callbacks.done(geometry);
          if (!disposed && options.useCache) {
            const persist = () => { if (!disposed) void putCity(cacheKey, geometry); };
            if ('requestIdleCallback' in window) window.requestIdleCallback(persist, { timeout: 2000 });
            else setTimeout(persist, 0);
          }
        } else if (message.type === 'large') { stop(); callbacks.large(message.bytes); }
        else if (message.type === 'error') { stop(); callbacks.error(message.message); }
      }).catch(error => { if (!disposed) { stop(); callbacks.error(error instanceof Error ? error.message : 'City loading failed'); } });
    };
    worker.onerror = () => { if (!disposed) { stop(); callbacks.error('Background processing failed. Retry or choose a smaller area.'); } };
    worker.postMessage(options);
  })().catch(error => { if (!disposed) { stop(); callbacks.error(error instanceof Error ? error.message : 'City loading failed'); } });
  return stop;
}
