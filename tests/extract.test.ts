import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boundaryGeometry, coordinate, touchesBoundary } from '../tools/city-data/boundary.ts';
import { extractCities } from '../tools/city-data/extract.ts';
import { syntheticCity } from '../tools/city-data/fixtures.ts';
import { buildDataset } from '../tools/city-data/build.ts';
import type { CityMetadata } from '../src/lib/data/city-types.ts';

const ring = (w: number, s: number, e: number, n: number) => [[w,s],[e,s],[e,n],[w,n],[w,s]];
const polygon = { type: 'Polygon', coordinates: [ring(0,0,10,10), ring(3,3,7,7)] };
const road = (points: number[][]) => points.map(([lon,lat]) => coordinate(lon,lat));

for (const [name, points, expected] of [
  ['both endpoints outside a crossing', [[-1,5],[11,5]], true],
  ['fully inside a hole', [[4,4],[6,6]], false],
  ['crossing a hole', [[2,5],[8,5]], true],
  ['touching a hole edge', [[3,4],[3,6]], true],
  ['coastline/boundary edge', [[0,0],[10,0]], true],
  ['touching a corner', [[-1,-1],[0,0]], true],
  ['neighboring city outside', [[11,1],[12,1]], false],
  ['inside covered land', [[1,1],[2,2]], true],
] as const) test(`complete-way selection: ${name}`, () => {
  assert.equal(touchesBoundary(road(points.map(point => [...point])), boundaryGeometry(polygon)), expected);
});

test('antimeridian rings and crossings use the short span without selecting Greenwich', () => {
  const geometry = boundaryGeometry({ type: 'Polygon', coordinates: [ring(179,-1,-179,1)] });
  assert.equal(touchesBoundary(road([[179.5,0],[-179.5,0]]), geometry), true);
  assert.equal(touchesBoundary(road([[178,0],[-178,0]]), geometry), true);
  assert.equal(touchesBoundary(road([[0,0],[1,0]]), geometry), false);
});
test('multipolygon islands are selected independently', () => {
  const geometry = boundaryGeometry({ type: 'MultiPolygon', coordinates: [[ring(0,0,1,1)], [ring(10,10,11,11)]] });
  assert.equal(touchesBoundary(road([[10.2,10.2],[10.8,10.8]]), geometry), true);
  assert.equal(touchesBoundary(road([[5,5],[6,6]]), geometry), false);
});
for (const [name, coordinates] of [
  ['open', [[[0,0],[2,0],[2,2],[0,2]]]],
  ['self-crossing', [[[0,0],[2,2],[0,2],[2,0],[0,0]]]],
  ['outside hole', [ring(0,0,1,1),ring(2,2,3,3)]],
  ['intersecting holes', [ring(0,0,10,10),ring(2,2,5,5),ring(4,4,6,6)]],
] as const) test(`ambiguous ${name} boundary is rejected`, () => {
  assert.throws(() => boundaryGeometry({ type: 'Polygon', coordinates }));
});

const metadata = (): CityMetadata => syntheticCity(1, '123', [0,0]).metadata;
async function* primitives(values: unknown[]) { yield* values; }
const node = (id: string, lon: number, lat: number) => ({ type: 'node', id, lon, lat });
const way = (id: string, nodes: string[]) => ({ type: 'way', id, nodes, tags: { highway: 'unfamiliar', bridge: 'yes', layer: '-1' } });

test('disk-backed extraction preserves huge IDs, complete outside endpoints, tags and unique referenced nodes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-extract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a = '9007199254740993', b = '9007199254740994';
  const reports = await extractCities(root, [{ metadata: metadata(), geometry: polygon }], primitives([
    node(a,-1,5), node(b,11,5), node('3',11,11), node('4',12,12), node('5',4,4), node('6',6,6),
    way('9007199254740995',[a,b]), way('8',['3','4']), way('9',['5','6']),
  ]));
  assert.equal(reports[0].ways,1); assert.equal(reports[0].nodes,2); assert.equal(reports[0].segments,1);
  const input = JSON.parse(await readFile(path.join(root,reports[0].input),'utf8'));
  assert.deepEqual(input.elements.map((e: { id: string }) => e.id),[a,b,'9007199254740995']);
  assert.deepEqual(input.elements[2].nodes,[a,b]);
  assert.equal(buildDataset(input).manifest.segment_count,1);
  assert.deepEqual(await readdir(root),[reports[0].input]);
});

for (const [name, values] of [
  ['missing node', [node('1',1,1),way('2',['1','99'])]],
  ['duplicate node', [node('1',1,1),node('1',2,2)]],
  ['duplicate way', [node('1',1,1),node('2',2,2),way('3',['1','2']),way('3',['1','2'])]],
  ['late node', [node('1',1,1),node('2',2,2),way('3',['1','2']),node('4',3,3)]],
  ['empty city', [node('1',11,11),node('2',12,12),way('3',['1','2'])]],
  ['invalid tags', [node('1',1,1),node('2',2,2),{ ...way('3',['1','2']),tags:{ highway:'road',layer:'1.5' } }]],
] as const) test(`failed ${name} extraction preserves old city input and removes temporary indexes`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-extract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = `${metadata().city_key}.json`; await writeFile(path.join(root,file),'previous');
  await assert.rejects(extractCities(root,[{ metadata: metadata(), geometry: polygon }],primitives([...values])));
  assert.equal(await readFile(path.join(root,file),'utf8'),'previous'); assert.deepEqual(await readdir(root),[file]);
});

test('cancellation rolls back the index without replacing existing output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-extract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const stop = new AbortController(); stop.abort(new Error('Cancelled'));
  await assert.rejects(extractCities(root,[{ metadata: metadata(), geometry: polygon }],primitives([node('1',1,1)]),stop.signal),/Cancelled/);
  assert.deepEqual(await readdir(root),[]);
});
