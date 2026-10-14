import { MAJOR_ROADS, STREETS } from '../domain.ts';
import type { RoadRank } from '../domain.ts';
import { ResponseLimitError, responseBytes } from '../data/response-body.ts';
import { tileBBox } from './grid.ts';
import type { Tile } from './grid.ts';

/** Bump when a cell query or its output format changes, so cached cells are fetched again. */
export const QUERY_SCHEMA = 1;

/** Overpass tag filter selecting exactly the ways roadRank() assigns to `rank`. */
export function rankFilter(rank: RoadRank): string {
  if (rank === 0) return `["highway"~"^${MAJOR_ROADS}$"]`;
  if (rank === 1) return `["highway"~"^(${STREETS})$"]`;
  // `!~` also matches ways without the key, so require the key first.
  return `["highway"]["highway"!~"^(${MAJOR_ROADS}|${STREETS})$"]`;
}

/**
 * Initial per-cell limits. Small server limits let a public instance admit the query sooner
 * and fail dense cells quickly, so only those cells are split; they are not service promises.
 */
export const CELL_LIMITS = { timeout: 30, maxsize: 64 * 1024 * 1024 };
// Outward rounding keeps ways on a cell edge in both neighbours' results.
const down = (value: number) => Math.floor(value * 1e7) / 1e7, up = (value: number) => Math.ceil(value * 1e7) / 1e7;

/** One road rank's ways intersecting a cell, each with its full geometry. */
export function cellQuery(tile: Tile, rank: RoadRank, limits = CELL_LIMITS): string {
  const [s, w, n, e] = tileBBox(tile);
  const box = [Math.max(-90, down(s)), Math.max(-180, down(w)), Math.min(90, up(n)), Math.min(180, up(e))];
  if (!(box[0] < box[2] && box[1] < box[3])) throw new Error('Invalid cell bounds');
  return `[out:json][timeout:${limits.timeout}][maxsize:${limits.maxsize}];way${rankFilter(rank)}(${box.join(',')});out geom qt;`;
}

/**
 * Why a cell could not load. Resource limits and oversized responses split the cell; rate
 * limits pause the whole session; an unavailable or unreachable provider retries with backoff.
 * `unreachable` is a network-level failure: no connection, a refused or blocked connection,
 * or a response the browser withholds (CORS).
 */
export type FailureCode = 'timeout_or_resource_limit' | 'rate_limited' | 'provider_unavailable' | 'unreachable' | 'invalid_request' | 'response_too_large' | 'decode_failure' | 'cancelled';
export const FAILURE_CODES: readonly FailureCode[] = ['timeout_or_resource_limit', 'rate_limited', 'provider_unavailable', 'unreachable', 'invalid_request', 'response_too_large', 'decode_failure', 'cancelled'];

/**
 * Shared public Overpass instances: one request at a time, whatever the configured
 * concurrency, because aborted queries keep occupying the per-address slots there.
 */
const PUBLIC_OVERPASS = /(^|\.)(overpass-api\.de|overpass\.kumi\.systems|overpass\.private\.coffee|maps\.mail\.ru|overpass\.openstreetmap\.(fr|ru))$/;
export const isPublicOverpass = (url: string) => { try { return PUBLIC_OVERPASS.test(new URL(url).hostname); } catch { return false; } };
export class CellFailure extends Error {
  readonly code: FailureCode;
  readonly status?: number;
  /** Milliseconds the provider asked to wait. */
  readonly retryAfter?: number;
  /** Sanitized provider remark, for development diagnostics only. */
  readonly remark?: string;
  constructor(code: FailureCode, detail: { status?: number; retryAfter?: number; remark?: string; message?: string } = {}) {
    super(detail.message || code);
    this.name = 'CellFailure'; this.code = code; this.status = detail.status; this.retryAfter = detail.retryAfter; this.remark = detail.remark;
  }
}

/** Provider text is untrusted: keep one short line, and never show it to users. */
// eslint-disable-next-line no-control-regex -- strips control characters from provider text.
export const sanitizeRemark = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 240);
export const classifyRemark = (remark: string): FailureCode => /time[sd]? ?out|out of memory|memory|maxsize|too large/i.test(remark) ? 'timeout_or_resource_limit' : 'provider_unavailable';
export const classifyStatus = (status: number): FailureCode => status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : 'invalid_request';
/** Retry-After as milliseconds from delta seconds or an HTTP date. */
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export interface CellFetch {
  url: string;
  query: string;
  signal: AbortSignal;
  /** Response bytes; a larger cell is split rather than read further. */
  maxBytes: number;
  /** Milliseconds to wait for response headers; Overpass computes before it responds. */
  deadline: number;
  /** Milliseconds a started body may go without data. */
  idle: number;
  fetch?: typeof fetch;
}

/** POSTs one cell query. Every failure, including HTTP 200 remarks, is a typed CellFailure. */
export async function fetchCell(options: CellFetch): Promise<{ data: object; bytes: number }> {
  const { signal } = options;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.deadline);
  let response: Response;
  try {
    response = await (options.fetch || fetch)(options.url, { method: 'POST', body: new URLSearchParams({ data: options.query }), signal: AbortSignal.any([signal, deadline.signal]) });
  } catch {
    if (signal.aborted) throw new CellFailure('cancelled');
    throw deadline.signal.aborted ? new CellFailure('provider_unavailable', { message: 'The road service did not respond in time' }) : new CellFailure('unreachable', { message: 'The road service could not be reached' });
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new CellFailure(classifyStatus(response.status), { status: response.status, retryAfter: retryAfter(response.headers.get('Retry-After')) });
  }
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isSafeInteger(length) && length > options.maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new CellFailure('response_too_large', { status: response.status });
  }
  let bytes: Uint8Array;
  try { bytes = await responseBytes(response, options.maxBytes, undefined, options.idle); }
  catch (error) {
    if (signal.aborted) throw new CellFailure('cancelled');
    throw error instanceof ResponseLimitError ? new CellFailure('response_too_large') : new CellFailure('provider_unavailable', { message: 'The road download stalled' });
  }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new CellFailure('decode_failure', { message: 'The road service returned invalid JSON' }); }
  if (!data || typeof data !== 'object') throw new CellFailure('decode_failure', { message: 'The road service returned an invalid response' });
  // Overpass reports runtime errors, such as timeouts, inside an HTTP 200 body.
  const remark = (data as { remark?: unknown }).remark;
  if (typeof remark === 'string') throw new CellFailure(classifyRemark(remark), { remark: sanitizeRemark(remark) });
  return { data, bytes: bytes.byteLength };
}
