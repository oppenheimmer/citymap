import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchCellRoads, cellRoads, clipSegment } from '../src/lib/live/cell-roads.ts';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tileBBox, tileRect } from '../src/lib/live/grid.ts';
import type { Tile } from '../src/lib/live/grid.ts';
import { projector } from '../src/lib/geometry.ts';
import { CellFailure } from '../src/lib/live/overpass.ts';
import type { Origin } from '../src/lib/domain.ts';

const box = { left: 0, right: 10, bottom: 0, top: 10 };
test('segments clip to a half-open cell so border roads belong to exactly one cell', () => {
  assert.deepEqual(clipSegment(1, 1, 9, 9, box), [1, 1, 9, 9]);
  assert.deepEqual(clipSegment(-5, 5, 15, 5, box), [0, 5, 10, 5]);
  assert.equal(clipSegment(-5, -5, -1, 20, box), undefined);
  // Along the right or top edge: the neighbour owns it. Along the left or bottom edge: this cell.
  assert.equal(clipSegment(10, 1, 10, 9, box), undefined);
  assert.equal(clipSegment(1, 10, 9, 10, box), undefined);
  assert.deepEqual(clipSegment(0, 1, 0, 9, box), [0, 1, 0, 9]);
  assert.deepEqual(clipSegment(1, 0, 9, 0, box), [1, 0, 9, 0]);
  // Touching only a corner leaves nothing to draw.
  assert.equal(clipSegment(-1, 11, 1, 9 + 2, box), undefined);
  assert.equal(clipSegment(-1, 1, 0, 0, box), undefined);
});

const origin: Origin = [85.8245, 20.2961];
const { project } = projector([origin[0], origin[1], origin[0], origin[1]]);
const base: Tile = { z: 13, x: 6049, y: 3600 };
const tiles: Tile[] = [base, { ...base, x: base.x + 1 }, { ...base, y: base.y + 1 }, { ...base, x: base.x + 1, y: base.y + 1 }];
const [south, west, north, east] = tileBBox(base);
const [, , , east2] = tileBBox(tiles[1]), [south2] = tileBBox(tiles[2]);
const way = (id: number, highway: string, points: [number, number][]) => ({ type: 'way', id, tags: { highway }, geometry: points.map(([lon, lat]) => ({ lat, lon })) });
const segments = (positions: Float32Array) => Array.from({ length: positions.length / 4 }, (_, i) => [...positions.subarray(i * 4, i * 4 + 4)]);
const length = (list: number[][]) => list.reduce((sum, [x1, y1, x2, y2]) => sum + Math.hypot(x2 - x1, y2 - y1), 0);

test('a road crossing four cells is split at shared edges without gaps or duplicates', () => {
  // A diagonal road from the north-west cell into the south-east cell, through the shared corner region.
  const road = way(1, 'residential', [[west + (east - west) * 0.3, north - (north - south) * 0.2], [east2 - (east2 - east) * 0.25, south2 + (south - south2) * 0.35]]);
  const parts = tiles.map(tile => cellRoads({ elements: [road] }, project, tileRect(tile, origin), 1));
  const pieces = parts.flatMap(part => segments(part.positions));
  const [x1, y1] = project(road.geometry[0].lon, road.geometry[0].lat);
  const [x2, y2] = project(road.geometry[1].lon, road.geometry[1].lat);
  assert.ok(Math.abs(length(pieces) - Math.hypot(x2 - x1, y2 - y1)) < 0.05, 'Clipped pieces add up to the road');
  // Every interior piece endpoint is shared by exactly one other piece.
  const ends = pieces.flatMap(([ax, ay, bx, by]) => [`${ax},${ay}`, `${bx},${by}`]);
  const counts = new Map<string, number>(); for (const end of ends) counts.set(end, (counts.get(end) || 0) + 1);
  assert.equal([...counts.values()].filter(count => count === 1).length, 2, 'Only the road ends are unmatched');
  assert.equal(new Set(pieces.map(piece => piece.join(','))).size, pieces.length);
});

test('a road exactly on a shared cell edge is drawn by one cell only', () => {
  // A north–south street on the meridian between the two northern cells.
  const road = way(2, 'residential', [[east, north - (north - south) * 0.1], [east, south + (north - south) * 0.1]]);
  const drawn = tiles.map(tile => cellRoads({ elements: [road] }, project, tileRect(tile, origin), 1).segments);
  // Rounding decides which side owns it; the half-open rule guarantees exactly one does.
  assert.equal(drawn.reduce((sum, count) => sum + count, 0), 1);
});

test('only the requested rank is kept, and an empty cell is a valid result', () => {
  const inside = (f: number): [number, number] => [west + (east - west) * f, south + (north - south) * f];
  const elements = [way(3, 'primary', [inside(0.1), inside(0.2)]), way(4, 'residential', [inside(0.3), inside(0.4)]), way(5, 'footway', [inside(0.5), inside(0.6)]), way(6, 'service', [inside(0.6), inside(0.7), inside(0.8)])];
  const rect = tileRect(base, origin);
  assert.deepEqual(([0, 1, 2] as const).map(rank => cellRoads({ elements }, project, rect, rank).segments), [1, 1, 3]);
  const empty = cellRoads({ elements: [], osm3s: { timestamp_osm_base: '2026-10-01T00:00:00Z' } }, project, rect, 1);
  assert.deepEqual([empty.segments, empty.positions.length, empty.snapshotAt], [0, 0, '2026-10-01T00:00:00Z']);
  // Duplicate ways and one-node ways add nothing.
  assert.equal(cellRoads({ elements: [elements[1], elements[1], way(7, 'residential', [inside(0.5)])] }, project, rect, 1).segments, 1);
  // Exact-length output, so no unused bytes are transferred.
  const clipped = cellRoads({ elements: [way(8, 'residential', [[west - 1, south - 1], [west - 0.5, south - 0.5], inside(0.5)])] }, project, rect, 1);
  assert.equal(clipped.positions.buffer.byteLength, clipped.segments * 16);
});

test('separate nodes and inline geometry produce the same segments', () => {
  const a: [number, number] = [west + (east - west) * 0.2, south + (north - south) * 0.3], b: [number, number] = [west + (east - west) * 0.7, south + (north - south) * 0.6];
  const rect = tileRect(base, origin);
  const inline = cellRoads({ elements: [way(9, 'residential', [a, b])] }, project, rect, 1);
  const separate = cellRoads({ elements: [{ type: 'node', id: 1, lon: a[0], lat: a[1] }, { type: 'node', id: 2, lon: b[0], lat: b[1] }, { type: 'way', id: 9, nodes: [1, 2], tags: { highway: 'residential' } }] }, project, rect, 1);
  assert.deepEqual([...separate.positions], [...inline.positions]);
});

test('corrupt or incomplete responses fail as decode errors instead of drawing partial roads', () => {
  const rect = tileRect(base, origin);
  const decode = (value: unknown) => { try { cellRoads(value, project, rect, 1); } catch (error) { assert.ok(error instanceof CellFailure); return error.code; } };
  assert.equal(decode({}), 'decode_failure');
  assert.equal(decode({ elements: [{ type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } }] }), 'decode_failure');
  assert.equal(decode({ elements: [way(1, 'residential', [[200, 0], [0, 0]])] }), 'decode_failure');
  assert.equal(decode({ elements: [{ type: 'way', id: 1, tags: { highway: 'residential' } }] }), 'decode_failure');
  assert.equal(decode({ elements: [null] }), 'decode_failure');
  // Other ranks are skipped before their geometry is read.
  assert.equal(decode({ elements: [{ type: 'way', id: 1, tags: { highway: 'footway' } }] }), undefined);
});

test('a combined response projects each selected way once, with identical cell seams and ranks', () => {
  const a: [number, number] = [west + (east - west) * 0.2, south + (north - south) * 0.3];
  const b: [number, number] = [east2 - (east2 - east) * 0.2, south2 + (south - south2) * 0.3];
  const elements = [way(1, 'primary', [a, b]), way(2, 'residential', [a, b]), way(3, 'footway', [a, b])];
  const cells = tiles.flatMap(tile => ([0, 1, 2] as const).map(rank => ({ box: tileRect(tile, origin), rank })));
  let projected = 0;
  const results = batchCellRoads({ elements }, (lon, lat) => { projected++; return project(lon, lat); }, cells);
  assert.equal(projected, 6, 'The same way is not projected again for each cell');
  cells.forEach((cell, index) => assert.deepEqual(results[index], cellRoads({ elements }, project, cell.box, cell.rank)));
});

test('real Monaco batch output preserves the exact pre-optimization coordinates at every rank', async () => {
  const data = JSON.parse(gunzipSync(await readFile(new URL('./fixtures/real-city/monaco.json.gz', import.meta.url))).toString());
  // Use the source bounds to reproduce the original projector, including its translation.
  const nodes = data.elements.filter((element: { type: string }) => element.type === 'node');
  const xs = nodes.map((node: { lon: number }) => node.lon), ys = nodes.map((node: { lat: number }) => node.lat);
  const projection = projector([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  const cells = [5974, 5973].flatMap(y => ([0, 1, 2] as const).map(rank => ({ box: tileRect({ z: 14, x: 8529, y }, projection.origin), rank })));
  const results = batchCellRoads(data, projection.project, cells);
  assert.deepEqual(results.map(result => result.segments), [1886, 1803, 5800, 138, 149, 561]);
  assert.deepEqual(results.map(result => createHash('sha256').update(new Uint8Array(result.positions.buffer)).digest('hex')), [
    '785f82412cf64876a6df8e40ff356e32b2934e40f3068c34bc061378058aa514',
    'fe069c3cda8a06f2b39884151c0bd782e284b5b373a9955c85ad2db03fb02a99',
    '9281f8e1d5448e64e72511dba15323038d3b51703e69958d622bf5d59efc3198',
    'e37ddbfeadd20c12c482739f365633eb448e3a3fabe7bb5a76851eee706f062e',
    '3611f201c528f5041139e06d013fe41a5935d7c1fa36e111cc91557fae9e10ca',
    'afa484ea912f13872d289769f60ea69126fb9c99ec3c87bea0621c3c6932d6ef',
  ]);
});
