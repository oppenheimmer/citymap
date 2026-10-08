import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assert, object } from '../../src/lib/data/city-cache.ts';
import type { CityManifest } from '../../src/lib/data/city-types.ts';
import { validateDataset } from './files.ts';

export interface CoverageGap { city_key: string; name: string; country: string; reason: 'missing-boundary' | 'ambiguous-boundary' | 'missing-source' }

/** Offline inventory only: never fetch, rebuild, publish or remove a revision. */
export function coverageReport(manifests: CityManifest[], gaps: unknown, now: string, maxAgeDays = 30) {
  const timestamp = Date.parse(now);
  assert(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === now, 'Use a canonical UTC report timestamp');
  assert(Number.isInteger(maxAgeDays) && maxAgeDays >= 1 && maxAgeDays <= 3650, 'Freshness budget must be 1..3650 days');
  assert(manifests.length > 0 && manifests.every(m => m.source.kind === 'osm-extract'), 'Report requires real city datasets');
  const seen = new Set<string>();
  const cities = manifests.map(m => {
    assert(!seen.has(m.city_key), 'Supply one current revision per city'); seen.add(m.city_key);
    const age = timestamp - Date.parse(m.source.snapshot_at);
    assert(Number.isFinite(age) && age >= 0, 'Source snapshot is invalid or newer than the report');
    return { city_key: m.city_key, name: m.name, country: m.country, coverage: 'full',
      boundary_policy: m.boundary.policy, revision: m.dataset_revision, source_date: m.source.snapshot_at,
      age_days: Math.floor(age / 86_400_000), refresh_due: age >= maxAgeDays * 86_400_000,
      segments: m.segment_count, chunks: m.chunks.length,
      stored_bytes: m.chunks.reduce((sum, chunk) => sum + chunk.wire_bytes, 0),
      decoded_bytes: m.chunks.reduce((sum, chunk) => sum + chunk.decoded_bytes, 0),
    };
  }).sort((a,b) => a.city_key.localeCompare(b.city_key, 'en'));
  assert(Array.isArray(gaps), 'Coverage gaps must be an array');
  const missing = gaps.map(value => {
    const gap = object(value, 'coverage gap');
    assert(typeof gap.city_key === 'string' && /^osm-(node|way|relation)-[1-9][0-9]*$/.test(gap.city_key) && !seen.has(gap.city_key), 'Gap needs a unique typed city key');
    assert(typeof gap.name === 'string' && gap.name.trim() && typeof gap.country === 'string' && /^[A-Z]{2}$/.test(gap.country) && gap.country !== 'ZZ', 'Gap needs a name and real country code');
    assert(['missing-boundary','ambiguous-boundary','missing-source'].includes(String(gap.reason)), 'Invalid coverage gap reason');
    seen.add(gap.city_key);
    return { city_key: gap.city_key, name: gap.name, country: gap.country, reason: gap.reason } as CoverageGap;
  }).sort((a,b) => a.city_key.localeCompare(b.city_key, 'en'));
  return { report_version: 1, generated_at: now, max_age_days: maxAgeDays,
    city_count: cities.length, gap_count: missing.length, refresh_due_count: cities.filter(c => c.refresh_due).length,
    stored_bytes: cities.reduce((sum, c) => sum + c.stored_bytes, 0),
    countries: [...new Set([...cities,...missing].map(c => c.country))].sort().map(country => ({ country, city_count: cities.filter(c => c.country === country).length, gap_count: missing.filter(c => c.country === country).length })),
    cities, gaps: missing,
    retention: 'Keep published immutable revisions, pinned links and catalog/rollback references. This report never authorizes deletion.',
  };
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: '.city-data' },
    manifest: { type: 'string', multiple: true }, gaps: { type: 'string' },
    at: { type: 'string' }, 'max-age-days': { type: 'string', default: '30' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('data:report --root <artifacts> --manifest <key> [--manifest <key> ...] [--gaps gaps.json] [--at UTC-ISO] [--max-age-days 30] [--output report.json]\nValidates local revisions and reports coverage/freshness. No network or deletion.'); return; }
  assert(values.manifest?.length, 'Supply the complete current set with --manifest');
  const manifests = [];
  for (const key of values.manifest) manifests.push((await validateDataset(values.root, key)).manifest);
  const report = coverageReport(manifests, values.gaps ? JSON.parse(await readFile(values.gaps, 'utf8')) : [], values.at || new Date().toISOString(), Number(values['max-age-days']));
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(values.output, text); else console.log(text.trimEnd());
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Report failed'); process.exitCode = 1; });
