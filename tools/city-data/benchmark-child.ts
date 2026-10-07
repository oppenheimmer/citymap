import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import Pbf from 'pbf';
import { place } from '../../src/proto/place.js';
import { decodeChunk, roadPoints } from '../../src/lib/data/city-cache.ts';

// One fresh process per format excludes generator memory from decode measurements.
const [format, ...files] = process.argv.slice(2);
const wire = files.map(file => readFileSync(file));
const samples: { inflate_ms: number; decode_ms: number; first_chunk_cpu_ms: number; total_cpu_ms: number }[] = [];
let heapIncrement = 0, segmentCount = 0;

for (let iteration = 0; iteration < 11; iteration++) {
  global.gc?.();
  const baselineHeap = process.memoryUsage().heapUsed;
  let inflateTime = 0, decodeTime = 0, firstChunkTime = 0;
  let segments = 0;
  const retained: unknown[] = [];
  const started = performance.now();
  for (const bytes of wire) {
    const a = performance.now();
    const decoded = gunzipSync(bytes);
    const b = performance.now();
    if (format === 'v1') {
      const data = place.read(new Pbf(decoded));
      const nodes = new Map(data.nodes.map(node => [node.id, node]));
      for (const way of data.ways) {
        for (let i = 1; i < way.nodes.length; i++) {
          if (!nodes.has(way.nodes[i - 1]) || !nodes.has(way.nodes[i])) throw new Error('Missing legacy node');
          segments++;
        }
      }
      retained.push(data, nodes);
    } else {
      const chunk = decodeChunk(decoded);
      for (const road of chunk.roads) segments += roadPoints(road).length - 1;
      retained.push(chunk);
    }
    const c = performance.now();
    inflateTime += b - a;
    decodeTime += c - b;
    if (firstChunkTime === 0) firstChunkTime = c - started;
    heapIncrement = Math.max(heapIncrement, process.memoryUsage().heapUsed - baselineHeap);
  }
  const totalTime = performance.now() - started;
  if (iteration > 0) samples.push({ inflate_ms: inflateTime, decode_ms: decodeTime, first_chunk_cpu_ms: firstChunkTime, total_cpu_ms: totalTime });
  segmentCount = segments;
  // Keep all decoded chunks alive through the sample to model complete-city retention.
  if (!retained.length) throw new Error('Empty benchmark');
}

const median = (key: keyof typeof samples[number]) => Number(samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3));
console.log(JSON.stringify({
  inflate_ms: median('inflate_ms'), decode_ms: median('decode_ms'), first_chunk_cpu_ms: median('first_chunk_cpu_ms'), total_cpu_ms: median('total_cpu_ms'),
  sampled_heap_increment_bytes: heapIncrement,
  process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
  segments: segmentCount,
}));
