import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bbox, boundaryFromNominatim, DEFAULT_DESIGN, id, overpassQuery } from '../src/lib/domain.ts';
import { osmGeometry, pointBounds, projector } from '../src/lib/geometry.ts';
import { parseUrl, shareUrl } from '../src/lib/url-state.ts';
import { cameraFromView, viewFromCamera } from '../src/lib/view.ts';

test('typed boundary IDs and area offsets preserve large integers', () => {
  const result = boundaryFromNominatim({ osm_type: 'relation', osm_id: '9007199254740993', display_name: 'Large ID city', boundingbox: ['35', '36', '139', '140'] });
  assert.equal(result.osmId, '9007199254740993'); assert.equal(result.areaId, '9007202854740993');
  assert.throws(() => id(9007199254740992)); assert.throws(() => id('1);out;'));
});

test('bounding boxes and queries validate ranges and support antimeridian selection', () => {
  assert.deepEqual(bbox([-10, 170, 10, -170]), [-10, 170, 10, -170]);
  assert.match(overpassQuery({ key: 'test', name: 'test', kind: 'bbox', bbox: [-10, 170, 10, -170] }), /170,10,180/);
  assert.match(overpassQuery({ key: 'test', name: 'test', kind: 'bbox', bbox: [-10, 170, 10, -170] }), /-180,10,-170/);
  for (const box of [[1, 2, 1, 3], [-91, 0, 1, 2], [0, 181, 1, 2], [0, 0, 1, NaN]]) assert.throws(() => bbox(box));
});

test('legacy links restore validated targets, cache and automatic-loading intent', () => {
  const state = parseUrl('?q=Tokyo&areaId=3600123&cache=false&auto=1');
  assert.equal(state.boundary?.areaId, '3600123'); assert.equal(state.cache, false); assert.equal(state.auto, true);
  const node = parseUrl('?osm_id=123&bbox=35,139,36,140');
  assert.deepEqual(node.boundary?.bbox, [35, 139, 36, 140]); assert.equal(node.boundary?.osmType, undefined);
  assert.ok(parseUrl('?bbox=35,,36,140&auto=1').warning);
  assert.equal(parseUrl('?areaId=invalid&auto=1').auto, false);
  assert.ok(parseUrl('?v=99&areaId=123').warning);
});

test('complete design links round-trip the view, Unicode labels, colors, opacity and immutable revision', () => {
  const boundary = { key: 'osm-relation-123', name: '東京', kind: 'city', osmType: 'relation' as const, osmId: '123', areaId: '3600000123', revision: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
  const design = { ...DEFAULT_DESIGN, roadColor: '#125634', roadOpacity: 0.25, backgroundOpacity: 0.5, label: { ...DEFAULT_DESIGN.label, text: '東京 & <test>', x: 0.1, y: 0.3, size: 52, opacity: 0.4 }, view: { lon: 139.7671234, lat: 35.6812345, width: 1234.5, height: 987.25 } };
  const url = shareUrl('https://citymap.example.com', '/', boundary, design, false);
  const restored = parseUrl(new URL(url).search);
  assert.deepEqual(restored.design, design); assert.equal(restored.boundary?.revision, boundary.revision); assert.equal(restored.cache, false);
  assert.equal(parseUrl('?roads=bad&roadOpacity=-1&labelX=999&view=NaN,0,1,2').design.roadOpacity, 0.8);
  for (const view of ['181,0,1,1', '0,86,1,1', '0,0,0,1', '0,0,1,-1', '0,0,1']) assert.equal(parseUrl(`?view=${view}`).design.view, undefined);
});

const near = (a: number, b: number, tolerance: number) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
test('geographic views match the projector and restore the same place when data extents differ', () => {
  const place: [number, number] = [139.7, 35.68];
  const a = projector([139.6, 35.6, 139.8, 35.8]), b = projector([139.6, 35.6, 139.81, 35.83]);
  const [x, y] = a.project(...place);
  const view = viewFromCamera({ left: x - 500, right: x + 500, bottom: y - 300, top: y + 300 }, a.origin);
  near(view.lon, place[0], 1e-9); near(view.lat, place[1], 1e-9); near(view.width, 1000, 1e-9); near(view.height, 600, 1e-9);
  // Scene units differ by hundreds of metres between the two extents; the view does not.
  const [bx, by] = b.project(...place), restored = cameraFromView(view, b.origin);
  assert.ok(Math.abs(bx - x) > 100);
  near((restored.left + restored.right) / 2, bx, 1e-6); near((restored.bottom + restored.top) / 2, by, 1e-6);
});
test('views and extents stay correct across the antimeridian', () => {
  const bounds = pointBounds([[179.2, -16.8], [-179.6, -16.2], [179.9, -16.5]]);
  assert.deepEqual(bounds, [179.2, -16.8, 180.4, -16.2]);
  const projection = projector(bounds), [x, y] = projection.project(-179.6, -16.2);
  assert.ok(projection.bounds.right - projection.bounds.left > 100_000);
  const view = viewFromCamera({ left: x - 10, right: x + 10, bottom: y - 10, top: y + 10 }, projection.origin);
  near(view.lon, -179.6, 1e-9); near(view.lat, -16.2, 1e-9);
  const camera = cameraFromView(view, projection.origin);
  near((camera.left + camera.right) / 2, x, 1e-6); near((camera.bottom + camera.top) / 2, y, 1e-6);
});

const elements = [
  { type: 'node' as const, id: '1', lon: 139, lat: 35 },
  { type: 'node' as const, id: '2', lon: 139.01, lat: 35.005 },
  { type: 'node' as const, id: '3', lon: 139.02, lat: 35.01 },
  { type: 'way' as const, id: '10', nodes: ['1', '2', '3'] },
];
test('worker geometry preserves the recorded projection coordinates', () => {
  const geometry = osmGeometry({ elements });
  // Fixed coordinates recorded from the migration baseline; no old renderer code is needed.
  const expected = [-632.0178578849882, -928.7823110199533, 480, -249.99999999720603,
    480, -249.99999999720603, 1592.0178578849882, 428.8237967430614];
  assert.equal(geometry.segments, 2);
  expected.forEach((value, index) => assert.ok(Math.abs(Math.fround(value) - geometry.positions[index]) < 0.002));
});
test('missing middle nodes are rejected, rather than connected across a gap', () => {
  assert.throws(() => osmGeometry({ elements: elements.filter(element => element.id !== '2') }), /missing node 2/);
  assert.throws(() => osmGeometry({ elements: [] }), /No roads/);
  assert.throws(() => osmGeometry({ elements: [...elements, elements[0]] }), /Duplicate/);
});
test('antimeridian geometry uses a short connected segment', () => {
  const geometry = osmGeometry({ elements: [ { type: 'node', id: '1', lon: 179.9, lat: 1 }, { type: 'node', id: '2', lon: -179.9, lat: 1.1 }, { type: 'way', id: '3', nodes: ['1', '2'] } ] });
  assert.ok(Math.abs(geometry.positions[2] - geometry.positions[0]) < 30_000);
});
