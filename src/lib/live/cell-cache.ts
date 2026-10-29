import type { Origin } from '../domain.ts';
import { mercator, RAD, SCALE, wrapLongitude } from '../view.ts';

const DATABASE = 'citymap-cells';
const FORMAT = 1;
let epoch = 0;
export const cellCacheEpoch = () => epoch;
/**
 * Short-lived, bounded browser copies of live cells. They spare the road service repeat
 * requests; they are not a map archive and may be dropped at any time.
 */
export const CELL_CACHE = { maxBytes: 96 * 1024 * 1024, maxRecordBytes: 16 * 1024 * 1024, ttlMs: 72 * 60 * 60 * 1000, fallbackAgeMs: 30 * 24 * 60 * 60 * 1000 };
interface CellRecord { format: number; origin: Origin; positions: ArrayBuffer; segments: number; fetchedAt: number; snapshotAt?: string }
interface CellMeta { key: string; bytes: number; lastUsed: number; fetchedAt: number }
export interface CachedCell { positions: Float32Array; fetchedAt: number; snapshotAt?: string; stale: boolean }

/**
 * Moves geometry projected for one origin to another. Mercator only translates when the
 * origin changes. Far translations would cost float32 precision, so they are refused.
 */
export function translate(positions: Float32Array, from: Origin, to: Origin): Float32Array | undefined {
  const dx = wrapLongitude(from[0] - to[0]) * RAD * SCALE, dy = (mercator(from[1]) - mercator(to[1])) * SCALE;
  if (!(Math.abs(dx) <= 500_000 && Math.abs(dy) <= 500_000)) return;
  if (!dx && !dy) return positions;
  const moved = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 2) { moved[i] = positions[i] + dx; moved[i + 1] = positions[i + 1] + dy; }
  return moved;
}

function opened(): Promise<IDBDatabase | undefined> {
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('cells'); request.result.createObjectStore('metadata', { keyPath: 'key' }); };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = request.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error); });
}

/** One session's connection to the cell cache. Storage failures behave as cache misses. */
export class CellCache {
  private database?: Promise<IDBDatabase | undefined>;
  private closed = false;
  private writes = 0;
  private readonly now: () => number;
  constructor(now = Date.now) { this.now = now; }
  private connection() { return this.database ??= opened(); }
  private open() { return this.closed ? Promise.resolve(undefined) : this.connection(); }

  async get(key: string, origin: Origin, allowStale = false): Promise<CachedCell | undefined> {
    try {
      const db = await this.open();
      if (!db) return;
      const transaction = db.transaction(['cells', 'metadata'], 'readwrite');
      let record: CellRecord | undefined, usable = false, stale = false;
      const cells = transaction.objectStore('cells'), metadata = transaction.objectStore('metadata');
      const request = cells.get(key);
      request.onsuccess = () => {
        record = request.result;
        if (!record) return;
        const age = this.now() - record.fetchedAt;
        const valid = record.format === FORMAT && record.positions instanceof ArrayBuffer && record.positions.byteLength % 16 === 0 && record.positions.byteLength <= CELL_CACHE.maxRecordBytes && record.segments === record.positions.byteLength / 16
          && Array.isArray(record.origin) && record.origin.length === 2 && record.origin.every(Number.isFinite) && Math.abs(record.origin[0]) <= 180 && Math.abs(record.origin[1]) < 86
          && typeof record.fetchedAt === 'number' && Number.isFinite(age) && age >= -60_000 && age < CELL_CACHE.fallbackAgeMs;
        // Remove invalid records in this transaction, so an old read cannot later
        // delete a newer replacement. A fresh-only miss keeps useful older data.
        if (!valid) { cells.delete(key); metadata.delete(key); return; }
        stale = age >= CELL_CACHE.ttlMs; usable = !stale || allowStale;
        if (!usable) return;
        const meta = metadata.get(key);
        meta.onsuccess = () => { if (meta.result) metadata.put({ ...meta.result, lastUsed: this.now() }); };
      };
      await complete(transaction);
      if (!usable || !record) return;
      const positions = translate(new Float32Array(record.positions), record.origin, origin);
      return positions && { positions, fetchedAt: record.fetchedAt, snapshotAt: typeof record.snapshotAt === 'string' ? record.snapshotAt : undefined, stale };
    } catch { return; }
  }

  /** Stores a complete cell, evicting the least recently used cells beyond the size limit. */
  async put(key: string, origin: Origin, buffers: Float32Array[], meta: { fetchedAt: number; snapshotAt?: string }, expectedEpoch = epoch): Promise<boolean> {
    if (this.closed) return false;
    this.writes++;
    try { return await this.write(key, origin, buffers, meta, expectedEpoch); }
    finally { this.finished(); }
  }

  /** Registers a save now; closing this session drains registered saves before closing its connection. */
  defer(key: string, origin: Origin, buffers: Float32Array[], meta: { fetchedAt: number; snapshotAt?: string }, expectedEpoch = epoch): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.writes++;
    return new Promise(resolve => {
      const save = () => { void this.write(key, origin, buffers, meta, expectedEpoch).then(resolve, () => resolve(false)).finally(() => this.finished()); };
      try {
        if ('requestIdleCallback' in globalThis) { requestIdleCallback(save, { timeout: 2000 }); return; }
      } catch { /* A denied idle API falls back to a normal task. */ }
      setTimeout(save, 0);
    });
  }

  private async write(key: string, origin: Origin, buffers: Float32Array[], meta: { fetchedAt: number; snapshotAt?: string }, expectedEpoch: number): Promise<boolean> {
    const bytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    if (expectedEpoch !== epoch || bytes > CELL_CACHE.maxRecordBytes) return false;
    const positions = new Float32Array(bytes / 4);
    let offset = 0;
    for (const buffer of buffers) { positions.set(buffer, offset); offset += buffer.length; }
    try {
      const db = await this.connection();
      if (!db || expectedEpoch !== epoch) return false;
      const transaction = db.transaction(['cells', 'metadata'], 'readwrite');
      const cells = transaction.objectStore('cells'), metadata = transaction.objectStore('metadata');
      const all = metadata.getAll();
      all.onsuccess = () => {
        const now = this.now();
        const records = (all.result as CellMeta[]).filter(record => record.key !== key).sort((a, b) => a.lastUsed - b.lastUsed);
        let total = records.reduce((sum, record) => sum + record.bytes, 0) + bytes;
        for (const record of records) {
          if (total <= CELL_CACHE.maxBytes && now - record.fetchedAt < CELL_CACHE.fallbackAgeMs) continue;
          cells.delete(record.key); metadata.delete(record.key); total -= record.bytes;
        }
        const record: CellRecord = { format: FORMAT, origin: [origin[0], origin[1]], positions: positions.buffer, segments: bytes / 16, fetchedAt: meta.fetchedAt, snapshotAt: meta.snapshotAt };
        cells.put(record, key);
        metadata.put({ key, bytes, lastUsed: now, fetchedAt: meta.fetchedAt } satisfies CellMeta);
      };
      await complete(transaction);
      return true;
    } catch { return false; }
  }

  private finished() { this.writes--; this.closeWhenDrained(); }
  private closeWhenDrained() {
    if (!this.closed || this.writes) return;
    void this.database?.then(db => db?.close()); this.database = undefined;
  }
  close() { this.closed = true; this.closeWhenDrained(); }
}

export async function clearCellCache(): Promise<boolean> {
  epoch++;
  const db = await opened();
  if (!db) return false;
  try {
    const transaction = db.transaction(['cells', 'metadata'], 'readwrite');
    transaction.objectStore('cells').clear(); transaction.objectStore('metadata').clear();
    await complete(transaction);
    return true;
  } catch { return false; } finally { db.close(); }
}
