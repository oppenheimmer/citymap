import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAngle, graticule, gridDrawing, gridStep } from '../src/lib/graticule.ts';
import { projector } from '../src/lib/geometry.ts';
import { fitCamera, viewFromCamera } from '../src/lib/view.ts';

// Values are hundredths of an arc-minute.
const angle = (degrees: number, minutes = 0) => Math.round((degrees * 60 + minutes) * 100);

test('grid intervals use whole degrees, whole minutes, then decimal minutes', () => {
  assert.equal(gridStep(4 * 6000), 6000); assert.equal(gridStep(20 * 100), 500); assert.equal(gridStep(2.4 * 100), 50); assert.equal(gridStep(2), 1);
});

test('labels stop at minutes, using decimal minutes rather than seconds', () => {
  assert.equal(formatAngle(angle(7, 25.5), 50, 'lon'), '7°25.5′E');
  assert.equal(formatAngle(angle(7, 25.25), 5, 'lon'), '7°25.25′E');
  assert.equal(formatAngle(-angle(43, 5), 100, 'lat'), '43°05′S');
  assert.equal(formatAngle(angle(43, 5.5), 50, 'lat'), '43°05.5′N');
  assert.equal(formatAngle(angle(2), 6000, 'lat'), '2°N'); assert.equal(formatAngle(0, 6000, 'lon'), '0°');
  assert.equal(formatAngle(angle(181), 6000, 'lon'), '179°W');
});

function monaco(width: number, height: number) {
  const projection = projector([7.40, 43.72, 7.44, 43.76]);
  const camera = fitCamera(projection.bounds, width / height);
  return { projection, camera, centre: viewFromCamera(camera, projection.origin) };
}
// Pixel position of a scene point in an export frame turned clockwise by `rotation` degrees.
function pixel(camera: ReturnType<typeof monaco>['camera'], width: number, height: number, rotation: number, [x, y]: [number, number]) {
  const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2, unit = width / (camera.right - camera.left);
  const r = rotation * Math.PI / 180, dx = x - cx, dy = y - cy;
  return [width / 2 + (dx * Math.cos(r) + dy * Math.sin(r)) * unit, height / 2 - (-dx * Math.sin(r) + dy * Math.cos(r)) * unit];
}

for (const rotation of [0, 90, 30]) test(`meridians and parallels pass through the coordinates they label at ${rotation}°`, () => {
  const { projection, camera, centre } = monaco(1200, 900);
  const lines = graticule(camera, centre, 1200, 900, rotation);
  assert.ok(lines.filter(line => line.axis === 'lon').length >= 3 && lines.filter(line => line.axis === 'lat').length >= 3);
  assert.ok(lines.every(line => !line.label.includes('″')));
  // Parse a label back to degrees, then project a point on that line through the map.
  const value = (label: string) => { const [, d, m] = label.match(/^(\d+)°(?:([\d.]+)′)?[NSEW]$/)!; return Number(d) + Number(m || 0) / 60; };
  const meridian = lines.find(line => line.axis === 'lon')!, parallel = lines.find(line => line.axis === 'lat')!;
  for (const [line, point] of [[meridian, projection.project(value(meridian.label), 43.735)], [parallel, projection.project(7.415, value(parallel.label))]] as const) {
    const [px, py] = pixel(camera, 1200, 900, rotation, point);
    // Collinear with the line through `point` along `direction`.
    assert.ok(Math.abs((px - line.point[0]) * line.direction[1] - (py - line.point[1]) * line.direction[0]) < 1e-6);
  }
  if (rotation === 90) { assert.deepEqual(meridian.direction.map(v => Math.round(v) + 0), [1, 0]); assert.deepEqual(parallel.direction.map(v => Math.round(v) + 0), [0, 1]); }
});

test('north-up ticks: teeth on every border, labels at the tooth tips, perpendicular to them', () => {
  const width = 1000, height = 800, { camera, centre } = monaco(width, height);
  assert.equal(gridDrawing(camera, centre, width, height, 1, { mode: 'none', opacity: 0.3 }, 3), undefined);
  const ticks = gridDrawing(camera, centre, width, height, 1, { mode: 'ticks', opacity: 0.3 }, 3)!;
  assert.equal(ticks.lines.length, 0);
  for (const edge of [(t: { y1: number }) => t.y1 === 3, (t: { x1: number }) => t.x1 === 3, (t: { y1: number }) => t.y1 === height - 3, (t: { x1: number }) => t.x1 === width - 3]) assert.ok(ticks.teeth.some(t => edge(t as never)));
  const top = ticks.texts.filter(text => text.angle === 0), left = ticks.texts.filter(text => text.angle === -90);
  assert.ok(top.length >= 2 && left.length >= 2 && top.length + left.length === ticks.texts.length);
  // Tip of an 8 px tooth from the 3 px border, then a 3 px gap and half the 10 px text.
  assert.ok(top.every(text => Math.abs(text.y - (3 + 8 + 3 + 5)) < 1e-9) && left.every(text => Math.abs(text.x - (3 + 8 + 3 + 5)) < 1e-9));
});

test('rotated ticks keep labels perpendicular to their teeth and upright', () => {
  const width = 1000, height = 800, { camera, centre } = monaco(width, height);
  const drawing = gridDrawing(camera, centre, width, height, 1, { mode: 'ticks', opacity: 0.3 }, 3, 30)!;
  assert.ok(drawing.texts.length >= 3);
  for (const text of drawing.texts) {
    assert.ok(text.angle > -90 - 1e-9 && text.angle <= 90 + 1e-9);
    // The tooth whose line the label sits on, beyond its tip.
    const tooth = drawing.teeth.find(t => { const d = [t.x2 - t.x1, t.y2 - t.y1], len = Math.hypot(d[0], d[1]), along = ((text.x - t.x2) * d[0] + (text.y - t.y2) * d[1]) / len; return along >= 3 + 5 - 1e-6 && Math.abs((text.x - t.x2) * d[1] - (text.y - t.y2) * d[0]) / len < 1e-6; })!;
    assert.ok(tooth, `no tooth for ${text.text}`);
    const d = [tooth.x2 - tooth.x1, tooth.y2 - tooth.y1], r = text.angle * Math.PI / 180;
    assert.ok(Math.abs(Math.cos(r) * d[0] + Math.sin(r) * d[1]) < 1e-6);
  }
});

test('grid lines carry the chosen opacity and start past their labels', () => {
  const width = 1000, height = 800, { camera, centre } = monaco(width, height);
  const lines = gridDrawing(camera, centre, width, height, 1, { mode: 'lines', opacity: 0.3 }, 3)!;
  assert.equal(lines.teeth.length, 0); assert.equal(lines.lineOpacity, 0.3); assert.ok(lines.lines.length >= 6);
  const vertical = lines.lines.filter(line => Math.abs(line.x1 - line.x2) < 1e-9);
  assert.ok(vertical.some(line => Math.abs(line.y1 - (3 + 2 * 3 + 10)) < 1e-9));
});

// A tooth's family from its direction: meridians are mostly vertical below a 45° turn.
const family = (tooth: { x1: number; y1: number; x2: number; y2: number }, rotation: number) => {
  const r = rotation * Math.PI / 180, d = [tooth.x2 - tooth.x1, tooth.y2 - tooth.y1], len = Math.hypot(d[0], d[1]);
  return Math.abs((d[0] * Math.sin(r) - d[1] * Math.cos(r)) / len) > 0.999 ? 'lon' : 'lat';
};
for (const rotation of [0, 30, 45, 60, 90, 120, 150, 180]) test(`at ${rotation}° each edge pair carries only longitudes or only latitudes`, () => {
  const width = 1000, height = 800, { camera, centre } = monaco(width, height);
  const upright = Math.abs(Math.cos(rotation * Math.PI / 180)) >= Math.abs(Math.sin(rotation * Math.PI / 180)) - 1e-9;
  // Longitudes along the width (top/bottom) while meridians are closer to vertical.
  const expected = { lon: upright ? 'horizontal' : 'vertical', lat: upright ? 'vertical' : 'horizontal' };
  const side = (x: number, y: number) => Math.abs(y - 3) < 1e-6 || Math.abs(y - (height - 3)) < 1e-6 ? 'horizontal' : Math.abs(x - 3) < 1e-6 || Math.abs(x - (width - 3)) < 1e-6 ? 'vertical' : 'inside';
  const ticks = gridDrawing(camera, centre, width, height, 1, { mode: 'ticks', opacity: 0.3 }, 3, rotation)!;
  assert.ok(ticks.teeth.length >= 4);
  for (const tooth of ticks.teeth) assert.equal(side(tooth.x1, tooth.y1), expected[family(tooth, rotation)]);
  for (const text of ticks.texts) {
    const lon = /[EW]$/.test(text.text) || /^0°$/.test(text.text);
    const tooth = ticks.teeth.find(t => { const d = [t.x2 - t.x1, t.y2 - t.y1], len = Math.hypot(d[0], d[1]); return Math.abs((text.x - t.x2) * d[1] - (text.y - t.y2) * d[0]) / len < 1e-6 && ((text.x - t.x2) * d[0] + (text.y - t.y2) * d[1]) > 0; })!;
    assert.equal(side(tooth.x1, tooth.y1), expected[lon ? 'lon' : 'lat'], `${text.text} at ${rotation}°`);
  }
});

test('marks move inward clear of grid teeth and labels, and the following scale bar moves with the arrow', async () => {
  const { placeMarks, northCentre, scaleBarCentre } = await import('../src/lib/marks.ts');
  const { avoidGrid } = await import('../src/lib/graticule.ts');
  const { DEFAULT_DESIGN } = await import('../src/lib/domain.ts');
  // A box overlapping a top-edge label moves down; one overlapping a right-edge tooth moves left.
  assert.deepEqual(avoidGrid([10, 0, 50, 20], [{ box: [0, 0, 100, 15], edge: 0 }], 4), [0, 19]);
  assert.deepEqual(avoidGrid([80, 40, 120, 60], [{ box: [110, 45, 120, 50], edge: 3 }], 4), [-14, 0]);
  assert.deepEqual(avoidGrid([10, 40, 50, 60], [{ box: [0, 0, 100, 15], edge: 0 }], 4), [0, 0]);
  const width = 1000, height = 800, map = { width, height }, { camera, centre } = monaco(width, height), bar = { width: 150, height: 38 };
  const grid = gridDrawing(camera, centre, width, height, 1, { mode: 'ticks', opacity: 0.3 }, 3, 45)!;
  const box = (c: { x: number; y: number }, w: number, h: number) => [c.x - w / 2, c.y - h / 2, c.x + w / 2, c.y + h / 2];
  const clear = (b: number[]) => grid.keepouts.every(({ box: o }) => !(b[0] < o[2] + 4 && o[0] - 4 < b[2] && b[1] < o[3] + 4 && o[1] - 4 < b[3]));
  // The compass dropped on a right-edge label moves left, together with the bar below it.
  const right = grid.keepouts.find(k => k.edge === 3)!, bottom = grid.keepouts.find(k => k.edge === 2)!;
  const design = { ...DEFAULT_DESIGN, northAt: { x: 1, y: (right.box[1] + right.box[3]) / 2 / height } };
  const before = northCentre(design, map, 1), barBefore = scaleBarCentre(design, bar, map, 1);
  assert.ok(!clear(box(before, 106, 106)));
  const placed = placeMarks(design, map, 1, bar, grid.keepouts, 4);
  assert.ok(clear(box(placed.north, 106, 106)) && placed.north.x < before.x && placed.north.y <= before.y);
  assert.deepEqual([placed.scaleBar!.x - placed.north.x, placed.scaleBar!.y - placed.north.y], [barBefore.x - before.x, barBefore.y - before.y]);
  // A scale bar placed on its own over a bottom-edge label moves up, clear of it.
  const own = { ...design, scaleBarAt: { x: (bottom.box[0] + bottom.box[2]) / 2 / width, y: 1 } };
  const barAt = scaleBarCentre(own, bar, map, 1), moved = placeMarks(own, map, 1, bar, grid.keepouts, 4).scaleBar!;
  assert.ok(!clear(box(barAt, 150, 38)) && clear(box(moved, 150, 38)) && moved.y < barAt.y && moved.x === barAt.x);
  // Without a grid nothing moves.
  assert.deepEqual(placeMarks(design, map, 1, bar).north, before);
});
