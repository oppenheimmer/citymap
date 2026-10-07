import { sha256, stableJson } from './build.ts';
import type { CityInput } from './build.ts';

export const PILOT_CASES = [
  { name: 'small', roads: 64, id: '1', origin: [-122.42, 37.77] },
  { name: 'medium', roads: 4096, id: '2', origin: [139.69, 35.68] },
  { name: 'large', roads: 32768, id: '3', origin: [18.42, -33.92] },
] as const;

// Generated grids test sizes and shared-node layouts without downloading public-provider data.
// These IDs and boundaries are fictional and must never be included in a public city catalog.
export function syntheticCity(roadCount = 64, id = '1', origin: readonly number[] = [-122.42, 37.77]): CityInput {
  const elements: Record<string, unknown>[] = [];
  const nodes = new Map<string, string>();
  let nodeIndex = 0;
  const point = (x: number, y: number) => {
    const key = `${x}/${y}`;
    let id = nodes.get(key);
    if (!id) {
      id = String(1_000_000_000_000 + nodeIndex++);
      nodes.set(key, id);
      elements.push({ type: 'node', id, lon: Number((origin[0] + x * 0.00007).toFixed(7)), lat: Number((origin[1] + y * 0.00007).toFixed(7)) });
    }
    return id;
  };
  for (let i = 0; i < roadCount; i++) {
    const row = Math.floor(i / 64), col = i % 64;
    const references = Array.from({ length: 9 }, (_, k) => point(col * 8 + k, row));
    elements.push({
      type: 'way', id: String(9_000_000 + i), nodes: references,
      tags: { highway: i % 7 === 0 ? 'primary' : 'residential', bridge: i % 17 === 0 ? 'yes' : 'no', layer: i % 17 === 0 ? '1' : '0' },
    });
  }
  return {
    metadata: {
      city_key: `osm-relation-${id}`,
      name: `Synthetic grid (${roadCount} roads)`, country: 'ZZ', area_ids: [],
      source: { kind: 'synthetic', url: 'https://example.invalid/citymap/synthetic-grid', sha256: sha256(stableJson(elements)), snapshot_at: '2026-10-07T00:00:00.000Z' },
      boundary: { osm_type: 'relation', osm_id: id, version: '1', policy: 'preselected-complete-ways', sha256: sha256(`synthetic-grid/${id}/${roadCount}/${origin.join(',')}`) },
      built_at: '2026-10-07T00:00:00.000Z',
    },
    elements,
  };
}
