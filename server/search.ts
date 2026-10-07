import { responseBytes } from '../src/lib/data/response-body.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { R2, memoryStore, r2Config, r2Store } from './r2.ts';
import type { JSONStore } from './r2.ts';

export class SearchError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  constructor(message: string, status: number, retryAfter?: number) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
interface Lock { token: string; until: number; next: number }
export interface SearchOptions { provider: string; contact: string; apiKey?: string; store?: JSONStore; production?: boolean; fetch?: typeof fetch; now?: () => number }
const development = memoryStore();

export async function search(query: string, signal: AbortSignal, options: SearchOptions): Promise<unknown[]> {
  const q = query.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters in submitted search text.
  if (!q || q.length > 256 || /[\u0000-\u001f]/.test(q)) throw new SearchError('Enter a city name of at most 256 characters.', 400);
  const provider = new URL(options.provider);
  if (!(provider.protocol === 'https:' || provider.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(provider.hostname)) || provider.username || provider.password) throw new SearchError('Invalid search provider configuration.', 503);
  const isPublic = provider.hostname === 'nominatim.openstreetmap.org';
  const store = options.store || (options.production && isPublic ? undefined : development);
  if (isPublic && !store) throw new SearchError('Search is not configured. Set a managed provider or private R2 search storage.', 503);
  const now = options.now || Date.now;
  const cacheKey = `search/v1/${createHash('sha256').update(`${provider.href}\n${q.toLowerCase()}`).digest('hex')}.json`;
  const cached = await store?.read(cacheKey);
  const cacheValue = cached?.value as { expires?: number; results?: unknown[] } | undefined;
  if (cacheValue?.expires && cacheValue.expires > now() && Array.isArray(cacheValue.results)) return cacheValue.results;
  const lockKey = 'locks/public-nominatim.json';
  let token: string | undefined;
  if (isPublic) {
    const previous = await store!.read(lockKey);
    const lock = previous?.value as Lock | undefined;
    if (lock && (typeof lock.token !== 'string' || !Number.isFinite(lock.until) || !Number.isFinite(lock.next))) throw new SearchError('Search rate storage is invalid.', 503);
    const wait = Math.max(lock?.until || 0, lock?.next || 0) - now();
    if (wait > 0) throw new SearchError('Search is busy. Retry shortly.', 429, Math.max(1, Math.ceil(wait / 1000)));
    token = randomUUID();
    if (!await store!.comparePut(lockKey, { token, until: now() + 60_000, next: 0 }, previous?.etag)) throw new SearchError('Search is busy. Retry shortly.', 429, 1);
  }
  try {
    const url = new URL(provider);
    url.searchParams.set('q', q); url.searchParams.set('format', 'jsonv2'); url.searchParams.set('limit', '8');
    const headers: Record<string, string> = { 'User-Agent': `Citymap/2.0 (+${options.contact})`, Accept: 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await (options.fetch || fetch)(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) throw new SearchError('The search provider is unavailable. Retry later.', response.status === 429 ? 429 : 502, response.status === 429 ? Math.max(1, Number(response.headers.get('Retry-After')) || 5) : undefined);
    const text = new TextDecoder().decode(await responseBytes(response, 1024 * 1024));
    if (text.length > 1024 * 1024) throw new SearchError('Search returned an oversized response.', 502);
    const results: unknown = JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => key === 'osm_id' && typeof value === 'number' && !Number.isSafeInteger(value) && context?.source ? context.source : value);
    if (!Array.isArray(results) || results.length > 100) throw new SearchError('Search returned an invalid response.', 502);
    // A cache write failure must not discard an otherwise valid provider result.
    await store?.comparePut(cacheKey, { expires: now() + 7 * 24 * 60 * 60 * 1000, results }, cached?.etag).catch(() => false);
    return results;
  } finally {
    if (token) {
      try {
        const held = await store!.read(lockKey);
        if ((held?.value as Lock | undefined)?.token === token) await store!.comparePut(lockKey, { token: '', until: 0, next: now() + 1100 }, held?.etag);
      } catch { /* A failed release remains protected by the expiring lease. */ }
    }
  }
}

export function createSearchHandler(env: NodeJS.ProcessEnv = process.env, production = env.NODE_ENV === 'production') {
  const config = r2Config(env, env.R2_SEARCH_BUCKET || '');
  const store = config ? r2Store(new R2(config)) : production ? undefined : development;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    try {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new SearchError('Use GET for city search.', 405); }
      const url = new URL(req.url || '/', 'http://localhost');
      const results = await search(url.searchParams.get('q') || '', abort.signal, { provider: env.SEARCH_PROVIDER_URL || 'https://nominatim.openstreetmap.org/search', contact: env.APP_ORIGIN || 'https://github.com/oppenheimmer/citymap', apiKey: env.SEARCH_PROVIDER_API_KEY, store, production });
      res.statusCode = 200; res.end(JSON.stringify(results));
    } catch (error) {
      if (abort.signal.aborted) return;
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = error instanceof SearchError ? error.status : 503;
      if (error instanceof SearchError && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.end(JSON.stringify({ error: error instanceof SearchError ? error.message : 'Search storage or provider is unavailable.' }));
    }
  };
}
