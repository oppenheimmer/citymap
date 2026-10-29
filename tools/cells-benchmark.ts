import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { batchCellRoads, cellRoads } from '../src/lib/live/cell-roads.ts';
import { coverTiles, tileRect } from '../src/lib/live/grid.ts';
import { pointBounds, projector } from '../src/lib/geometry.ts';
import { frameCorners } from '../src/lib/view.ts';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: '.benchmarks/cells.json' },
  runs: { type: 'string', default: '25' },
} });
const runs = Number(values.runs);
assert(Number.isInteger(runs) && runs >= 5 && runs <= 100, 'Use --runs 5..100');
const bytes = gunzipSync(await readFile(new URL('../tests/fixtures/real-city/monaco.json.gz', import.meta.url)));
const data: { elements: { type: string; lon: number; lat: number }[] } = JSON.parse(bytes.toString());
const bounds = pointBounds(data.elements.filter(e => e.type === 'node').map(e => [e.lon, e.lat]));
const projection = projector(bounds);
const tiles = coverTiles(frameCorners(projection.bounds), projection.origin, 14, 36)!.slice(0, 2);
const cells = tiles.flatMap(tile => ([0, 1, 2] as const).map(rank => ({ box: tileRect(tile, projection.origin), rank })));
const methods = {
  independent: () => cells.map(cell => cellRoads(data, projection.project, cell.box, cell.rank)),
  batch: () => batchCellRoads(data, projection.project, cells),
};
const hashes = (results: ReturnType<typeof batchCellRoads>) => results.map(cell => ({
  segments: cell.segments,
  sha256: createHash('sha256').update(new Uint8Array(cell.positions.buffer)).digest('hex'),
}));
const coverage = hashes(methods.independent());
assert.deepEqual(hashes(methods.batch()), coverage, 'Batch processing changed road coverage');
for (let i = 0; i < 5; i++) { methods.independent(); methods.batch(); }
const timings: Record<keyof typeof methods, number[]> = { independent: [], batch: [] };
for (let i = 0; i < runs; i++) {
  // Alternate order so warm-up and GC do not always favour the same method.
  for (const name of (i % 2 ? ['batch', 'independent'] : ['independent', 'batch']) as (keyof typeof methods)[]) {
    const start = performance.now(); methods[name](); timings[name].push(performance.now() - start);
  }
}
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
};
const report = {
  measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model, runs,
  fixtureSha256: createHash('sha256').update(bytes).digest('hex'), tiles, coverage,
  independent: summary(timings.independent), batch: summary(timings.batch),
  limits: ['Local real-city geometry processing only; excludes network, browser drawing and GPU work.'],
};
await mkdir(path.dirname(values.output), { recursive: true });
await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: values.output, independent: report.independent, batch: report.batch }));
