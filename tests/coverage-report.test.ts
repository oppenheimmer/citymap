import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../tools/city-data/build.ts';
import { syntheticCity } from '../tools/city-data/fixtures.ts';
import { coverageReport } from '../tools/city-data/report.ts';

const input = syntheticCity(2);
input.metadata.source.kind = 'osm-extract'; input.metadata.country = 'MC';
const manifest = buildDataset(input, 8).manifest;
const at = new Date(Date.parse(manifest.source.snapshot_at) + 30 * 86_400_000).toISOString();

test('coverage report separates explicit gaps, counts exact bytes and marks stale source snapshots', () => {
  const gap = { city_key: 'osm-relation-42', name: 'Missing city', country: 'FR', reason: 'ambiguous-boundary' };
  const report = coverageReport([manifest], [gap], at);
  assert.equal(report.city_count, 1); assert.equal(report.gap_count, 1); assert.equal(report.refresh_due_count, 1);
  assert.equal(report.stored_bytes, manifest.chunks.reduce((n,c) => n+c.wire_bytes, 0));
  assert.equal(report.cities[0].age_days, 30); assert.deepEqual(report.gaps, [gap]);
  assert.equal(coverageReport([manifest], [], at, 31).refresh_due_count, 0);
  assert.deepEqual(report.countries, [{ country:'FR', city_count:0, gap_count:1 }, { country:'MC', city_count:1, gap_count:0 }]);
});

test('coverage report refuses invented coverage, duplicate cities and invalid dates/budgets', () => {
  assert.throws(() => coverageReport([buildDataset(syntheticCity(2), 8).manifest], [], at), /real city/);
  assert.throws(() => coverageReport([manifest,manifest], [], at), /one current/);
  assert.throws(() => coverageReport([manifest], [{city_key:manifest.city_key}], at), /unique typed/);
  assert.throws(() => coverageReport([manifest], [{city_key:'osm-relation-42',name:'City',country:'FR',reason:'full'}], at), /gap reason/);
  assert.throws(() => coverageReport([manifest], [], '2020-01-01T00:00:00.000Z'), /newer/);
  assert.throws(() => coverageReport([manifest], [], 'invalid'), /timestamp/);
  assert.throws(() => coverageReport([manifest], [], at, 0), /budget/);
});
