import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { R2, r2Config } from './r2.ts';
import type { R2Listing, R2Response } from './r2.ts';

export interface MapStore {
  list(prefix: string, limit?: number, cursor?: string, signal?: AbortSignal): Promise<R2Listing>;
  request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, headers?: Record<string, string>, signal?: AbortSignal, limit?: number): Promise<R2Response>;
}
const CITY = /^osm-(node|way|relation)-[1-9][0-9]*$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class CacheError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}
function check(condition: unknown, message: string, status = 502): asserts condition { if (!condition) throw new CacheError(message, status); }

/** Publish a new catalog without this city before deleting any of its geometry. */
export async function retireCity(store: MapStore, city: string, signal: AbortSignal) {
  check(CITY.test(city), 'Invalid city.', 400);
  const response = await store.request('GET', 'v2/catalog.json', undefined, {}, signal, 1024 * 1024);
  if (response.status === 404) return;
  check(response.status === 200 && response.headers.get('ETag'), 'The R2 catalog could not be read. No city files were removed.');
  const root = JSON.parse(response.body.toString());
  check(root.index_version === 1 && /^[a-f0-9]{64}$/.test(root.catalog_revision) && Array.isArray(root.countries) && root.countries.length <= 250, 'Invalid R2 catalog.');
  const entries: Record<string, unknown>[] = [], seen = new Set<string>();
  let catalogBytes = 0;
  for (const country of root.countries) {
    check(/^[A-Z]{2}$/.test(country.country) && country.key === `v2/catalogs/${root.catalog_revision}/${country.country}.json` && /^[a-f0-9]{64}$/.test(country.sha256), 'Invalid country index reference.');
    const file = await store.request('GET', country.key, undefined, {}, signal, 2 * 1024 * 1024);
    catalogBytes += file.body.byteLength;
    check(catalogBytes <= 8 * 1024 * 1024, 'The catalog is too large for browser administration. Use a batch maintenance tool.');
    check(file.status === 200 && hash(file.body.toString()) === country.sha256, 'R2 country index could not be verified.');
    const index = JSON.parse(file.body.toString());
    check(index.index_version === 1 && index.catalog_revision === root.catalog_revision && index.country === country.country && Array.isArray(index.cities) && index.cities.length === country.city_count, 'Invalid R2 country index.');
    for (const entry of index.cities) {
      check(CITY.test(entry.city_key) && entry.country === country.country && !seen.has(entry.city_key), 'Invalid R2 city entry.');
      seen.add(entry.city_key); entries.push(entry);
      check(entries.length <= 50_000, 'The catalog is too large for browser administration. Use a batch maintenance tool.');
    }
  }
  check(seen.size === root.city_count, 'R2 catalog totals differ.');
  if (!seen.has(city)) return;
  const remaining = entries.filter(entry => entry.city_key !== city);
  const revision = hash(JSON.stringify(remaining)), countries = [];
  for (const country of [...new Set(remaining.map(entry => String(entry.country)))].sort()) {
    const cities = remaining.filter(entry => entry.country === country);
    const body = Buffer.from(JSON.stringify({ index_version: 1, catalog_revision: revision, country, cities }) + '\n');
    const key = `v2/catalogs/${revision}/${country}.json`;
    const written = await store.request('PUT', key, body, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable', 'If-None-Match': '*' }, signal);
    check([200, 201, 412].includes(written.status), 'The updated country index could not be saved.');
    if (written.status === 412) {
      const existing = await store.request('GET', key, undefined, {}, signal, 2 * 1024 * 1024);
      check(existing.status === 200 && existing.body.equals(body), 'The updated country index changed concurrently.', 409);
    }
    countries.push({ country, key, city_count: cities.length, sha256: hash(body.toString()) });
  }
  const written = await store.request('PUT', 'v2/catalog.json', Buffer.from(JSON.stringify({ index_version: 1, catalog_revision: revision, city_count: remaining.length, countries }) + '\n'), { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, must-revalidate', 'If-Match': response.headers.get('ETag')! }, signal);
  check([200, 201].includes(written.status), 'The catalog changed. Retry after publishing has finished.', 409);
}

/** A bounded, resumable batch. Always starts at the beginning after mutations. */
export async function deleteMaps(store: MapStore, city: string | undefined, signal: AbortSignal) {
  check(city === undefined || CITY.test(city), 'Invalid city.', 400);
  const prefix = city ? `v2/cities/${city}/` : 'v2/';
  if (city) await retireCity(store, city, signal);
  // Retire public pointers first. Missing pointers are an idempotent success.
  const pointer = await store.request('DELETE', city ? `${prefix}latest.json` : 'v2/catalog.json', undefined, {}, signal);
  check([200, 204, 404].includes(pointer.status), 'The map pointer could not be removed. Retry later.');
  const page = await store.list(prefix, 100, undefined, signal);
  check(page.objects.length <= 100 && page.objects.every(object => object.key.startsWith(prefix)), 'Invalid deletion listing.');
  let deleted = 0, failed = 0;
  // Bound concurrency and wait for every started deletion before responding.
  let index = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < page.objects.length) {
      const object = page.objects[index++];
      try {
        const response = await store.request('DELETE', object.key, undefined, {}, signal);
        if ([200, 204, 404].includes(response.status)) deleted++; else failed++;
      } catch { failed++; }
    }
  }));
  check(!failed, `${deleted} map files removed; ${failed} could not be removed. Retry to finish.`);
  return { deleted, remaining: !!page.cursor };
}

export function createCacheHandler(env: NodeJS.ProcessEnv = process.env, injected?: MapStore) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const token = env.CACHE_ADMIN_TOKEN || '', origin = env.APP_ORIGIN || '';
      let store = injected;
      const config = r2Config({ ...env, R2_ACCESS_KEY_ID: env.R2_CACHE_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: env.R2_CACHE_SECRET_ACCESS_KEY }, env.R2_DATA_BUCKET || '');
      if (!store && config) store = new R2(config);
      let validOrigin = false;
      try { const url = new URL(origin); validOrigin = url.origin === origin && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); } catch { /* Invalid configuration stays disabled. */ }
      const configured = !!store && token.length >= 32 && token.length <= 512 && validOrigin && !!env.R2_DATA_BUCKET && env.R2_DATA_BUCKET !== env.R2_SEARCH_BUCKET;
      const url = new URL(req.url || '/', 'http://local');
      if (req.method === 'GET' && url.searchParams.get('status') === '1') { res.end(JSON.stringify({ configured })); return; }
      check(configured, 'R2 management is not configured. Local map clearing is still available.', 503);
      check(['GET', 'POST'].includes(req.method || ''), 'Method not allowed.', 405);
      check(!req.headers.origin || req.headers.origin === origin, 'This request must come from the map app.', 403);
      check(req.method !== 'POST' || req.headers.origin === origin, 'This request must come from the map app.', 403);
      const authorization = req.headers.authorization || '';
      check(authorization.length <= 1024 && timingSafeEqual(createHash('sha256').update(authorization).digest(), createHash('sha256').update(`Bearer ${token}`).digest()), 'Administrator key required.', 401);
      const signal = AbortSignal.timeout(20_000);
      if (req.method === 'GET') {
        const cursor = url.searchParams.get('cursor') || undefined;
        check(!cursor || cursor.length <= 4096, 'Invalid cursor.', 400);
        res.end(JSON.stringify(await store!.list('v2/', 1000, cursor, signal))); return;
      }
      check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Send JSON.', 415);
      let text = '';
      for await (const chunk of req) { text += chunk.toString(); check(Buffer.byteLength(text) <= 1024, 'Request too large.', 413); }
      let body;
      try { body = JSON.parse(text); } catch { throw new CacheError('Invalid JSON.', 400); }
      check(body && (body.scope === 'all' || body.scope === 'city' && typeof body.city === 'string' && CITY.test(body.city)), 'Choose all maps or a valid city.', 400);
      res.end(JSON.stringify(await deleteMaps(store!, body.scope === 'city' ? body.city : undefined, signal)));
    } catch (error) {
      res.statusCode = error instanceof CacheError ? error.status : 502;
      res.end(JSON.stringify({ error: error instanceof CacheError ? error.message : 'R2 could not finish this operation. Some files may remain; retry to finish.' }));
    }
  };
}
