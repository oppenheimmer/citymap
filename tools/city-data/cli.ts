import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assert, integer, manifestKey } from '../../src/lib/data/city-cache.ts';
import { buildDataset, DEFAULT_POINT_BUDGET, stableJson } from './build.ts';
import { validateDataset, writeDataset } from './files.ts';
import { PILOT_CASES, syntheticCity } from './fixtures.ts';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string' }, output: { type: 'string', default: '.city-data' },
      manifest: { type: 'string' }, 'max-points': { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('build --input city.json [--output .city-data] [--max-points 262144]\nvalidate --manifest v2/cities/<key>/<revision>/manifest.json [--output .city-data]\npilot [--output .city-data] [--max-points 32768]');
    return;
  }
  assert(positionals.length === 1, 'Expected exactly one command: build, validate, or pilot');
  const root = path.resolve(values.output);
  const command = positionals[0];
  if (command === 'validate') {
    assert(values.manifest, '--manifest must be an object key relative to --output');
    const { manifest } = await validateDataset(root, values.manifest);
    console.log(`Validated ${manifest.city_key}: ${manifest.chunks.length} chunks, ${manifest.unique_way_count} ways, ${manifest.segment_count} segments`);
    return;
  }
  const maxPoints = values['max-points'] === undefined ? (command === 'pilot' ? 32768 : DEFAULT_POINT_BUDGET) : Number(values['max-points']);
  integer(maxPoints, '--max-points', 2, 1_000_000);
  if (command === 'build') {
    assert(values.input, '--input is required');
    const input: unknown = JSON.parse(await readFile(values.input, 'utf8'));
    const built = buildDataset(input, maxPoints);
    const planKey = await writeDataset(root, built);
    const key = manifestKey(built.manifest.city_key, built.manifest.dataset_revision);
    await validateDataset(root, key);
    console.log(`Built and validated ${key}\nLocal upload plan: ${planKey}`);
  } else if (command === 'pilot') {
    const cases = [];
    for (const fixture of PILOT_CASES) {
      const built = buildDataset(syntheticCity(fixture.roads, fixture.id, fixture.origin), maxPoints);
      const plan = await writeDataset(root, built);
      const key = manifestKey(built.manifest.city_key, built.manifest.dataset_revision);
      await validateDataset(root, key);
      cases.push({ name: fixture.name, manifest: key, upload_plan: plan, roads: fixture.roads, chunks: built.manifest.chunks.length });
      console.log(`Validated synthetic ${fixture.name}: ${fixture.roads} ways, ${built.manifest.chunks.length} chunks`);
    }
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'pilot.local.json'), stableJson({ source_kind: 'synthetic', cases }) + '\n');
  } else {
    throw new Error(`Unknown command ${command}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
