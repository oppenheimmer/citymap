import { ROAD_DETAILS } from './domain.ts';
import type { Boundary, Design, Geometry } from './domain.ts';

const DATABASE = 'citymap-geometry';
// Format 2 added the projection origin for geographic views; 3 adds road ranks and coverage.
const FORMAT = 3;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CITY_BYTES = 32 * 1024 * 1024;
interface CacheRecord { format: number; geometry: { buffers: ArrayBuffer[]; ranks: Geometry['ranks']; coverage: Geometry['coverage']; bounds: Geometry['bounds']; origin: Geometry['origin']; source: Geometry['source']; segmentCount: number } }
interface CacheMeta { key: string; bytes: number; lastUsed: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('cities'); request.result.createObjectStore('metadata', { keyPath: 'key' }); };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Local cache is busy'));
  });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
}

export async function getCity(key: string): Promise<Geometry | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const transaction = db.transaction(['cities', 'metadata'], 'readwrite');
    let value: CacheRecord | undefined;
    const request = transaction.objectStore('cities').get(key);
    request.onsuccess = () => {
      value = request.result;
      const metadata = transaction.objectStore('metadata').get(key);
      metadata.onsuccess = () => { if (metadata.result) transaction.objectStore('metadata').put({ ...metadata.result, lastUsed: Date.now() }); };
    };
    await complete(transaction);
    if (!value || value.format !== FORMAT || value.geometry?.source?.complete !== true) return;
    const g = value.geometry;
    if (!Array.isArray(g.buffers) || !g.buffers.length || g.buffers.some(buffer => !(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 16)) return;
    const count = g.buffers.reduce((sum, buffer) => sum + buffer.byteLength / 16, 0);
    if (count !== g.segmentCount || count * 16 > MAX_CITY_BYTES || !g.bounds || ![g.bounds.left, g.bounds.right, g.bounds.bottom, g.bounds.top].every(Number.isFinite) || g.bounds.left >= g.bounds.right || g.bounds.bottom >= g.bounds.top) return;
    if (!Array.isArray(g.origin) || g.origin.length !== 2 || !g.origin.every(Number.isFinite) || Math.abs(g.origin[0]) > 180 || Math.abs(g.origin[1]) >= 90) return;
    if (!Array.isArray(g.ranks) || g.ranks.length !== g.buffers.length || !g.ranks.every(rank => rank === 0 || rank === 1 || rank === 2) || !ROAD_DETAILS.includes(g.coverage)) return;
    if (!['fixture','live','legacy','r2'].includes(g.source.kind)) return;
    if (g.source.kind === 'r2' && (!/^[a-f0-9]{64}$/.test(g.source.revision || '') || !/^[a-f0-9]{64}$/.test(g.source.manifestSha256 || ''))) return;
    return { buffers: g.buffers.map(buffer => new Float32Array(buffer)), ranks: [...g.ranks], coverage: g.coverage, bounds: g.bounds, origin: [g.origin[0], g.origin[1]], segmentCount: count, source: { ...g.source, local: true } };
  } catch { return; }
  finally { db?.close(); }
}

export async function putCity(key: string, geometry: Geometry): Promise<boolean> {
  const bytes = geometry.buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (!geometry.source.complete || !bytes || bytes > MAX_CITY_BYTES) return false;
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const transaction = db.transaction(['cities', 'metadata'], 'readwrite');
    const metadata = transaction.objectStore('metadata');
    const cities = transaction.objectStore('cities');
    const request = metadata.getAll();
    request.onsuccess = () => {
      const records = (request.result as CacheMeta[]).filter(record => record.key !== key).sort((a, b) => a.lastUsed - b.lastUsed);
      let total = records.reduce((sum, record) => sum + record.bytes, 0) + bytes;
      for (const record of records) {
        if (total <= MAX_TOTAL_BYTES) break;
        cities.delete(record.key); metadata.delete(record.key); total -= record.bytes;
      }
      const record: CacheRecord = { format: FORMAT, geometry: { ...geometry, source: { ...geometry.source, local: false }, buffers: geometry.buffers.map(buffer => buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength ? buffer.buffer as ArrayBuffer : buffer.slice().buffer as ArrayBuffer) } };
      cities.put(record, key);
      metadata.put({ key, bytes, lastUsed: Date.now() });
    };
    await complete(transaction);
    return true;
  } catch { return false; }
  finally { db?.close(); }
}

export async function clearCityCache(): Promise<boolean> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const transaction = db.transaction(['cities', 'metadata'], 'readwrite');
    transaction.objectStore('cities').clear(); transaction.objectStore('metadata').clear();
    await complete(transaction);
    return true;
  } catch { return false; }
  finally { db?.close(); }
}

export interface SavedDesign { id: string; name: string; boundary: Boundary; design: Design; savedAt: string }
const DESIGNS = 'citymap:designs:v1';
function read<T>(key: string): T[] { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.slice(0, 20) : []; } catch { return []; } }
function write(key: string, value: unknown): boolean { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
export function designs(): SavedDesign[] { return read<SavedDesign>(DESIGNS).filter(value => value && typeof value.id === 'string' && typeof value.name === 'string' && value.boundary && value.design?.label); }
export function saveDesign(boundary: Boundary, design: Design): boolean {
  const record: SavedDesign = { id: crypto.randomUUID(), name: design.label.text || boundary.name, boundary, design, savedAt: new Date().toISOString() };
  return write(DESIGNS, [record, ...designs()].slice(0, 20));
}
export function removeDesign(id: string): boolean { return write(DESIGNS, designs().filter(design => design.id !== id)); }
