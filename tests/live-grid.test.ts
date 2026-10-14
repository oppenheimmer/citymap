import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellLevel, children, coverTiles, groundDistance, tileBBox, tileDistance, tileKey, tileRect } from '../src/lib/live/grid.ts';
import type { Point, Tile } from '../src/lib/live/grid.ts';
import { projector } from '../src/lib/geometry.ts';
import { fitCamera, frameCorners } from '../src/lib/view.ts';
import type { Origin } from '../src/lib/domain.ts';

const near = (a: number, b: number, tolerance: number) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const bhubaneswar: Origin = [85.8245, 20.2961];
const project = (origin: Origin) => projector([origin[0], origin[1], origin[0], origin[1]]).project;
/** The tile containing a point, from the slippy-map formulas. */
const tileAt = (lon: number, lat: number, z: number): Tile => {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return { z, x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n) };
};
const square = (origin: Origin, half: number, dx = 0, dy = 0): Point[] => {
  const [x, y] = project(origin)(origin[0], origin[1]);
  return [[x - half + dx, y + half + dy], [x + half + dx, y + half + dy], [x + half + dx, y - half + dy], [x - half + dx, y - half + dy]];
};

test('cell rectangles match the scene projector at every corner', () => {
  for (const origin of [bhubaneswar, [139.7, 35.68], [-122.42, 37.77], [18.42, -33.92], [25.0, 69.5]] as Origin[]) {
    const tile = tileAt(origin[0] + 0.03, origin[1] - 0.02, 13), [s, w, n, e] = tileBBox(tile), rect = tileRect(tile, origin), p = project(origin);
    const [left, top] = p(w, n), [right, bottom] = p(e, s);
    for (const [a, b] of [[rect.left, left], [rect.right, right], [rect.top, top], [rect.bottom, bottom]]) near(a, b, 1e-6);
    assert.ok(rect.left < rect.right && rect.bottom < rect.top);
  }
});

test('neighbouring cells share exact edges, and children tile their parent', () => {
  const tile = tileAt(...bhubaneswar, 13), rect = tileRect(tile, bhubaneswar);
  assert.equal(tileRect({ ...tile, x: tile.x + 1 }, bhubaneswar).left, rect.right);
  assert.equal(tileRect({ ...tile, y: tile.y + 1 }, bhubaneswar).top, rect.bottom);
  const parts = children(tile).map(child => tileRect(child, bhubaneswar));
  assert.deepEqual(children(tile).map(tileKey), [`14/${tile.x * 2}/${tile.y * 2}`, `14/${tile.x * 2 + 1}/${tile.y * 2}`, `14/${tile.x * 2}/${tile.y * 2 + 1}`, `14/${tile.x * 2 + 1}/${tile.y * 2 + 1}`]);
  near(Math.min(...parts.map(part => part.left)), rect.left, 1e-6); near(Math.max(...parts.map(part => part.right)), rect.right, 1e-6);
  near(Math.min(...parts.map(part => part.bottom)), rect.bottom, 1e-6); near(Math.max(...parts.map(part => part.top)), rect.top, 1e-6);
});

test('cell levels keep a similar ground size from the equator towards the poles', () => {
  assert.deepEqual([0, 1, 2].map(rank => cellLevel(rank as 0 | 1 | 2, 0)), [11, 13, 14]);
  assert.deepEqual([0, 1, 2].map(rank => cellLevel(rank as 0 | 1 | 2, bhubaneswar[1])), [11, 13, 14]);
  assert.deepEqual([0, 1, 2].map(rank => cellLevel(rank as 0 | 1 | 2, -60)), [10, 12, 13]);
  assert.ok(cellLevel(1, 89.9) >= 9 && cellLevel(1, 89.9) === cellLevel(1, 85.0511));
  // About 4.6 km of ground per streets cell at Bhubaneswar.
  const [s, w, n, e] = tileBBox(tileAt(...bhubaneswar, cellLevel(1, bhubaneswar[1])));
  near((e - w) * 111.32 * Math.cos(bhubaneswar[1] * Math.PI / 180), 4.6, 0.1); near((n - s) * 110.57, 4.6, 0.1);
});

test('viewport cover is ordered from the centre, stable under small pans and bounded', () => {
  const view = square(bhubaneswar, 2500);
  const tiles = coverTiles(view, bhubaneswar, 13, 36)!;
  assert.ok(tiles.length >= 2 && tiles.length <= 4, `${tiles.length} tiles`);
  assert.deepEqual(tiles[0], tileAt(...bhubaneswar, 13));
  for (const [dx, dy] of [[1, 0], [0, -1], [3, 2]]) assert.deepEqual(coverTiles(square(bhubaneswar, 2500, dx, dy), bhubaneswar, 13, 36)!.map(tileKey).sort(), tiles.map(tileKey).sort());
  // A 100 km view at street level would need hundreds of cells, so nothing is requested.
  assert.equal(coverTiles(square(bhubaneswar, 50_000), bhubaneswar, 13, 36), undefined);
  assert.ok(coverTiles(square(bhubaneswar, 50_000), bhubaneswar, 11, 36)!.length <= 36);
  assert.equal(coverTiles(square(bhubaneswar, 1e9), bhubaneswar, 13, 36), undefined);
  assert.equal(coverTiles([[NaN, 0], [1, 0], [1, 1], [0, 1]], bhubaneswar, 13, 36), undefined);
  // Every listed tile intersects, and none is listed twice.
  assert.equal(new Set(tiles.map(tileKey)).size, tiles.length);
});

test('rotated footprints cover only the tiles they touch', () => {
  const tile = tileAt(...bhubaneswar, 13), rect = tileRect(tile, bhubaneswar);
  const camera = { left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top };
  const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2, size = camera.right - camera.left;
  // A long, thin frame turned 45° crosses the diagonal neighbours but not the other two.
  const thin = { left: cx - size, right: cx + size, bottom: cy - size * 0.02, top: cy + size * 0.02 };
  const turned = coverTiles(frameCorners(thin, 45), bhubaneswar, 13, 36)!.map(tileKey);
  const axis = coverTiles(frameCorners(thin, 0), bhubaneswar, 13, 36)!.map(tileKey);
  assert.deepEqual(axis.sort(), [-1, 0, 1].map(dx => tileKey({ ...tile, x: tile.x + dx })).sort());
  assert.ok(turned.includes(tileKey(tile)) && turned.includes(tileKey({ ...tile, x: tile.x + 1, y: tile.y - 1 })) && turned.includes(tileKey({ ...tile, x: tile.x - 1, y: tile.y + 1 })));
  assert.ok(!turned.includes(tileKey({ ...tile, x: tile.x + 1, y: tile.y + 1 })) && !turned.includes(tileKey({ ...tile, x: tile.x - 1, y: tile.y - 1 })));
});

test('export frame corners match the SVG export transform at every rotation', () => {
  const camera = { left: -300, right: 500, bottom: -100, top: 500 }, width = 1200, height = 800;
  for (const rotation of [0, 30, 90, 135, 180]) {
    const c = fitCamera(camera, width / height), cx = (c.left + c.right) / 2, cy = (c.top + c.bottom) / 2, unit = width / (c.right - c.left);
    const r = rotation * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    const px = (x: number, y: number) => width / 2 + ((x - cx) * cos + (y - cy) * sin) * unit;
    const py = (x: number, y: number) => height / 2 - ((y - cy) * cos - (x - cx) * sin) * unit;
    const corners = frameCorners(c, rotation);
    for (const [[x, y], [ex, ey]] of corners.map((corner, i) => [corner, [[0, 0], [width, 0], [width, height], [0, height]][i]] as const)) { near(px(x, y), ex, 1e-6); near(py(x, y), ey, 1e-6); }
  }
  const padded = frameCorners(camera, 0, 1.5);
  assert.deepEqual(padded[0], [-500, 650]);
});

test('cells beside the antimeridian wrap to valid columns and draw on the origin side', () => {
  const origin: Origin = [179.98, -16.5], z = 13, n = 2 ** z;
  const [x, y] = project(origin)(origin[0], origin[1]);
  const tiles = coverTiles([[x - 3000, y + 3000], [x + 3000, y + 3000], [x + 3000, y - 3000], [x - 3000, y - 3000]], origin, z, 36)!;
  const columns = new Set(tiles.map(tile => tile.x));
  assert.ok(columns.has(0) && columns.has(n - 1));
  for (const tile of tiles) {
    const [s, w, north, e] = tileBBox(tile);
    assert.ok(tile.x >= 0 && tile.x < n && w < e && w >= -180 && e <= 180 && s < north);
    const rect = tileRect(tile, origin);
    assert.ok(Math.abs((rect.left + rect.right) / 2 - x) < 20_000, 'Every cell draws beside the origin');
  }
  const east = tileRect({ z, x: 0, y: tiles[0].y }, origin), west = tileRect({ z, x: n - 1, y: tiles[0].y }, origin);
  near(east.left, west.right, 1e-6);
  // A point just across the antimeridian projects inside the wrapped cell.
  const [px] = project(origin)(-179.999, -16.5);
  assert.ok(px > east.left && px < east.right);
});

test('polar views clamp to the Mercator limit instead of requesting impossible rows', () => {
  const origin: Origin = [15, 84.9];
  const [x, y] = project(origin)(...origin);
  const tiles = coverTiles([[x - 2000, y + 400_000], [x + 2000, y + 400_000], [x + 2000, y - 2000], [x - 2000, y - 2000]], origin, 10, 64)!;
  assert.ok(tiles.length > 0 && tiles.every(tile => tile.y >= 0));
  assert.ok(tiles.some(tile => tile.y === 0));
});

test('cell distances measure from a point to the nearest part of each cell', () => {
  const home = tileAt(...bhubaneswar, 13);
  assert.equal(tileDistance(home, bhubaneswar), 0);
  // A degree of latitude is about 111 km on the mean-radius sphere; a neighbour cell starts at the edge.
  near(groundDistance([85.8, 20], [85.8, 21]) / 1000, 111.2, 0.1);
  assert.ok(tileDistance({ ...home, x: home.x + 1 }, bhubaneswar) < 4_700);
  const far = tileAt(bhubaneswar[0] + 1, bhubaneswar[1], 13), distance = tileDistance(far, bhubaneswar);
  assert.ok(distance > 100_000 && distance < 105_000, `${distance}`);
  // Across the antimeridian, the short way round.
  const east = { z: 13, x: 0, y: tileAt(-179.99, -16.5, 13).y };
  assert.ok(tileDistance(east, [179.99, -16.5]) < 2_000);
  near(groundDistance([179.99, -16.5], [-179.99, -16.5]), 2_133, 5);
});
