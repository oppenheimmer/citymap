import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildDataset, sha256, stableJson } from './city-data/build.ts';
import { PILOT_CASES } from './city-data/fixtures.ts';
import type { CityInput } from './city-data/build.ts';

const root = fileURLToPath(new URL('../public/fixtures/', import.meta.url));
// Sample maps exist only for tests; production builds ship no fixtures.
const testBuild = process.env.VITE_TEST_FIXTURES === '1';
await rm(root, { recursive: true, force: true });
if (testBuild) await mkdir(root, { recursive: true });
let generated = 0;
for (const fixture of testBuild ? PILOT_CASES : []) {
  const half = fixture.roads / 2;
  const elements: Record<string, unknown>[] = [];
  const nodes = new Map<string, string>();
  const extent = fixture.name === 'small' ? 0.008 : fixture.name === 'medium' ? 0.04 : 0.1;
  for (let i = 0; i < fixture.roads; i++) {
    const vertical = i >= half;
    const offset = (i % half) / (half - 1);
    const refs = [];
    for (let k = 0; k < 9; k++) {
      const x = vertical ? offset : k / 8, y = vertical ? k / 8 : offset;
      const lon = Number((fixture.origin[0] + x * extent).toFixed(7));
      const lat = Number((fixture.origin[1] + y * extent).toFixed(7));
      const key = `${lon}/${lat}`;
      let nodeId = nodes.get(key);
      if (!nodeId) {
        nodeId = String(nodes.size + 1);
        nodes.set(key, nodeId);
        elements.push({ type: 'node', id: nodeId, lon, lat });
      }
      refs.push(nodeId);
    }
    elements.push({ type: 'way', id: String(1_000_000 + i), nodes: refs, tags: { highway: i % 8 === 0 ? 'primary' : 'residential' } });
  }
  const input: CityInput = {
    metadata: {
      city_key: `osm-relation-${fixture.id}`, name: `${fixture.name[0].toUpperCase()}${fixture.name.slice(1)} synthetic grid`, country: 'ZZ', area_ids: [],
      source: { kind: 'synthetic', url: 'https://example.invalid/citymap/browser-grid', sha256: sha256(stableJson(elements)), snapshot_at: '2026-10-07T00:00:00.000Z' },
      boundary: { osm_type: 'relation', osm_id: fixture.id, version: '1', sha256: sha256(`browser-grid/${fixture.id}/${extent}`), policy: 'preselected-complete-ways' },
      built_at: '2026-10-07T00:00:00.000Z',
    }, elements,
  };
  // Reuse the generator's string-ID, coordinate, node-reference and segment validation.
  buildDataset(input);
  const file = `${fixture.name}.json`;
  await writeFile(new URL(file, `file://${root}`), stableJson(input) + '\n');
  generated++;
}
console.log(`Generated ${generated} validated browser fixtures`);
