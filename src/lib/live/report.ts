import type { LiveCoverage } from './viewport.ts';
import type { FailureCode } from './overpass.ts';
import type { FailureOutcome } from './scheduler.ts';

export interface LoadFailure {
  /** Milliseconds after this map session started. */
  atMs: number;
  code: FailureCode;
  status?: number;
  retryAfterMs?: number;
  elapsedMs?: number;
  outcome: FailureOutcome;
}

const LABELS: Record<FailureCode, string> = {
  rate_limited: 'Request limit reached', provider_busy: 'Road service busy',
  provider_unavailable: 'Road service not responding', unreachable: 'Connection failed',
  timeout_or_resource_limit: 'Query exceeded its time or memory limit',
  response_too_large: 'Road response too large', invalid_request: 'Query rejected',
  decode_failure: 'Invalid road data', cancelled: 'Request cancelled',
};
export const failureLabel = (code: FailureCode) => LABELS[code];

/** Explicit fields only: no queries, coordinates, credentials or provider response text. */
export function loadReport(provider: string, coverage: LiveCoverage) {
  let origin: string | undefined;
  try { const url = new URL(provider); if (['https:', 'http:'].includes(url.protocol)) origin = url.origin; } catch { /* Invalid configuration has no provider identity. */ }
  const s = coverage.stats;
  return {
    version: 1, generatedAt: new Date().toISOString(), provider: origin,
    requests: s.requests, cachedRegions: s.cached, downloadedBytes: s.bytes,
    loadedRegions: s.regions, segments: s.segments, splits: s.splits,
    firstRoadMs: s.firstRoadMs, medianFetchMs: s.medianFetchMs,
    failures: { ...s.failures }, recentFailures: s.recentFailures.map(({ atMs, code, status, retryAfterMs, elapsedMs, outcome }) => ({ atMs, code, status, retryAfterMs, elapsedMs, outcome })),
    coverage: { required: coverage.required, ready: coverage.ready, failed: coverage.failed, complete: coverage.complete },
    loading: { paused: coverage.paused, reason: coverage.pauseReason, requestBudgetSpent: coverage.exhausted, waitMs: coverage.cooldown, waiting: coverage.waiting },
  };
}
