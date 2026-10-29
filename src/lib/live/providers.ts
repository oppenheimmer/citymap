import { publicUrl } from '../domain.ts';
import type { CellFailure } from './overpass.ts';

/** Provider identity for reports and the page: never includes paths, queries or credentials. */
export function providerOrigin(value: string): string | undefined {
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) return url.origin; } catch { /* No identity for invalid configuration. */ }
}

function publicService(host: string): string | undefined {
  if (/(^|\.)overpass-api\.de$/.test(host) || ['gall.openstreetmap.de', 'lambert.openstreetmap.de'].includes(host)) return 'main';
  if (/(^|\.)(overpass\.kumi\.systems|overpass\.private\.coffee)$/.test(host)) return 'coffee';
}

/** One explicitly configured backup. Do not treat aliases of a public service as independent mirrors. */
export function backupProvider(primary: string, configured?: string): string | undefined {
  if (!configured?.trim()) return;
  let absolute: string;
  try { absolute = new URL(configured).href; } catch { throw new Error('The backup road service needs an absolute HTTPS URL'); }
  const backup = publicUrl(absolute), a = new URL(primary), b = new URL(backup);
  const family = publicService(a.hostname);
  if (a.href.replace(/\/+$/, '') === backup || family && family === publicService(b.hostname)) throw new Error('The backup road service must be different from the primary service');
  return backup;
}

/** Reuse the scheduler's one delayed retry; do not switch around limits or query/data failures. */
export function canFailOver(failure: CellFailure): boolean {
  return failure.retryAfter === undefined && (failure.code === 'unreachable' || failure.code === 'provider_unavailable' && (failure.status === 500 || failure.status === 501));
}
