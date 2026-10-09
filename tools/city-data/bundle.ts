import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { assert } from '../../src/lib/data/city-cache.ts';
import { BUNDLED_CITIES } from '../../src/lib/bundled-cities.ts';
import { buildDataset, DEFAULT_POINT_BUDGET } from './build.ts';

// Selected real-city inputs (complete-way JSON, gzip) for the cities shipped in public/data.
const INPUTS: Record<string, string> = { 'osm-relation-1124039': 'tests/fixtures/real-city/monaco.json.gz' };
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'public/data');

await rm(path.join(output, 'v2'), { recursive: true, force: true });
for (const key of BUNDLED_CITIES) {
  const input = INPUTS[key];
  assert(input, `No bundled input for ${key}`);
  const dataset = buildDataset(JSON.parse(gunzipSync(await readFile(path.join(root, input))).toString('utf8')), DEFAULT_POINT_BUDGET);
  assert(dataset.manifest.city_key === key && dataset.manifest.source.kind === 'osm-extract', `${input} is not real data for ${key}`);
  for (const object of dataset.objects) {
    const file = path.join(output, object.key);
    await mkdir(path.dirname(file), { recursive: true });
    // Static hosts do not send Content-Encoding for stored gzip, so chunks ship decoded.
    // The loader verifies decoded sizes and hashes from the manifest.
    await writeFile(file, object.headers['Content-Encoding'] === 'gzip' ? gunzipSync(object.bytes) : object.bytes);
  }
  console.log(`Bundled ${key}: revision ${dataset.manifest.dataset_revision}, ${dataset.manifest.segment_count} segments`);
}
