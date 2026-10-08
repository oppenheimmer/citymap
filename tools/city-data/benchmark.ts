import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir, cpus, platform, arch } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import Pbf from 'pbf';
import { place } from '../../src/proto/place.js';
import type { LegacyPlace } from '../../src/proto/place.js';
import { assert, decodeChunk, integer, roadPoints } from '../../src/lib/data/city-cache.ts';
import { buildDataset, normalizeInput } from './build.ts';
import { PILOT_CASES, syntheticCity } from './fixtures.ts';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: '.city-data/benchmark.json' }, input: { type: 'string' },
  'chunk-points': { type: 'string', default: '32768' },
} });
const chunkPoints = Number(values['chunk-points']); integer(chunkPoints, '--chunk-points', 2, 1_000_000);
const fixtures = values.input ? [{ input: JSON.parse(await readFile(values.input, 'utf8')) }] : PILOT_CASES.map(fixture => ({ input: syntheticCity(fixture.roads, fixture.id, fixture.origin) }));
const temporary = await mkdtemp(path.join(tmpdir(), 'citymap-benchmark-'));
const run = promisify(execFile);
const rows = [];
try {
  for (const { input } of fixtures) {
    const normalized = normalizeInput(input);
    const fixture = { name: normalized.metadata.city_key, id: normalized.metadata.boundary.osm_id, roads: normalized.roads.length };
    const legacy: LegacyPlace = {
      version: 1, id: fixture.id, name: input.metadata.name, date: input.metadata.source.snapshot_at,
      nodes: [], ways: [],
    };
    const expected = new Map<number, { lon: number; lat: number }>();
    for (const value of input.elements) {
      const e = value as Record<string, unknown>;
      if (e.type === 'node') {
        const node = { id: Number(e.id), lon: e.lon as number, lat: e.lat as number };
        assert(Number.isSafeInteger(node.id), 'Legacy comparison requires safe numeric node IDs');
        legacy.nodes.push(node);
        expected.set(node.id, node);
      } else {
        legacy.ways.push({ nodes: (e.nodes as string[]).map(Number) });
      }
    }
    const pbf = new Pbf();
    place.write(legacy, pbf);
    const v1 = pbf.finish();
    let legacyError = 0;
    for (const node of place.read(new Pbf(v1)).nodes) {
      const source = expected.get(node.id)!;
      legacyError = Math.max(legacyError, Math.abs(source.lon - node.lon), Math.abs(source.lat - node.lat));
    }
    const sourceRoads = normalizeInput(input).roads;
    const expectedSegments = sourceRoads.reduce((sum, road) => sum + road.coordinate_deltas_e7.length / 2, 0);
    for (const format of ['v1', 'v2-single', 'v2-chunks'] as const) {
      let wires: Uint8Array[], decodedBytes: number, geometryMatches: boolean;
      if (format === 'v1') {
        wires = [gzipSync(v1, { level: 9 })];
        decodedBytes = v1.byteLength;
        geometryMatches = legacyError === 0;
      } else {
        const built = buildDataset(input, format === 'v2-single' ? 1_000_000 : chunkPoints);
        wires = built.objects.filter(object => object.key.endsWith('.pbf')).map(object => object.bytes);
        decodedBytes = built.manifest.chunks.reduce((sum, chunk) => sum + chunk.decoded_bytes, 0);
        const actual = new Map<string, number[][]>();
        for (const chunk of built.chunks) {
          const decoded = decodeChunk(gunzipSync(wires[chunk.chunk_index]));
          for (const road of decoded.roads) {
            const points = actual.get(road.osm_way_id) ?? [];
            const part = roadPoints(road);
            points.push(...(road.fragment_index === 0 ? part : part.slice(1)));
            actual.set(road.osm_way_id, points);
          }
        }
        geometryMatches = actual.size === sourceRoads.length && sourceRoads.every(road => JSON.stringify(roadPoints(road)) === JSON.stringify(actual.get(road.osm_way_id)));
        assert(geometryMatches, 'Version-2 geometry parity failed');
      }
      const files = [];
      for (let index = 0; index < wires.length; index++) {
        const file = path.join(temporary, `${fixture.name}-${format}-${index}.pbf`);
        await writeFile(file, wires[index]);
        files.push(file);
      }
      const { stdout } = await run(process.execPath, ['--expose-gc', fileURLToPath(new URL('./benchmark-child.ts', import.meta.url)), format, ...files], { encoding: 'utf8' });
      const measured = JSON.parse(stdout);
      assert(measured.segments === expectedSegments, 'Benchmark segment count mismatch');
      rows.push({
        fixture: fixture.name, source_kind: normalized.metadata.source.kind, source: normalized.metadata.source, ways: fixture.roads, format, chunks: wires.length,
        wire_bytes: wires.reduce((sum, bytes) => sum + bytes.byteLength, 0), decoded_bytes: decodedBytes,
        geometry_matches_e7: geometryMatches, max_coordinate_error_degrees: format === 'v1' ? legacyError : 0,
        ...measured,
      });
      console.log(`${fixture.name} ${format}: ${rows.at(-1)!.wire_bytes} gzip bytes, ${measured.total_cpu_ms} ms CPU, ${wires.length} chunks`);
    }
  }
  const report = {
    recorded_at: new Date().toISOString(), node: process.version, os: `${platform()}/${arch()}`, cpu: cpus()[0]?.model,
    methodology: 'Fixed input (synthetic grids by default or explicit real-city JSON); 1 warmup + 10 measured iterations, medians; separate child per format with GC before samples; gzip inflation, protobuf decoding, validation and coordinate walking. Chunked sequential. Wire sizes exclude manifests/HTTP headers. Heap increments are sampled, RSS includes process/runtime overhead. No network, projection, WebGL, export or first-frame measurements.',
    rows,
  };
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
