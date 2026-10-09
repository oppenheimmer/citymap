import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAngle, graticule, gridDrawing, gridStep } from '../src/lib/graticule.ts';
import { projector } from '../src/lib/geometry.ts';
import { viewFromCamera } from '../src/lib/view.ts';

test('grid intervals give at least three lines in whole degrees, minutes or seconds', () => {
  assert.equal(gridStep(4 * 3600), 3600); assert.equal(gridStep(0.04 * 3600), 30); assert.equal(gridStep(20 * 60), 300); assert.equal(gridStep(2), 1);
});

test('coordinates format to the interval precision with hemispheres', () => {
  assert.equal(formatAngle(7 * 3600 + 25 * 60 + 30, 30, 'lon'), '7°25′30″E');
  assert.equal(formatAngle(-(43 * 3600 + 5 * 60), 60, 'lat'), '43°05′S');
  assert.equal(formatAngle(2 * 3600, 3600, 'lat'), '2°N'); assert.equal(formatAngle(0, 3600, 'lon'), '0°');
  assert.equal(formatAngle(181 * 3600, 3600, 'lon'), '179°W');
});

test('meridians and parallels land where the projector draws those coordinates', () => {
  const projection = projector([7.40, 43.72, 7.44, 43.76]);
  const camera = projection.bounds, width = 1200, height = 900;
  const aspect = width / height, w = Math.max(camera.right - camera.left, (camera.top - camera.bottom) * aspect);
  const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2;
  const frame = { left: cx - w / 2, right: cx + w / 2, bottom: cy - w / aspect / 2, top: cy + w / aspect / 2 };
  const centre = viewFromCamera(frame, projection.origin);
  const { meridians, parallels } = graticule(frame, centre, width, height);
  assert.ok(meridians.length >= 3 && parallels.length >= 3);
  // Each axis picks its own interval: whole minutes across, 30 seconds up this frame.
  assert.deepEqual(meridians.map(line => line.label), ['7°23′E', '7°24′E', '7°25′E', '7°26′E', '7°27′E']);
  assert.ok(parallels.every(line => /^43°4\d′[03]0″N$/.test(line.label)));
  // 7°25′E projected through the map's own projector lands on its meridian.
  const [x] = projection.project(7 + 25 / 60, 43.74), meridian = meridians.find(line => line.label === '7°25′E')!;
  assert.ok(Math.abs((x - frame.left) / w * width - meridian.at) < 1e-6);
  const [, y] = projection.project(7.42, 43 + 44 / 60), parallel = parallels.find(line => line.label === '43°44′00″N')!;
  assert.ok(Math.abs((frame.top - y) / (w / aspect) * height - parallel.at) < 1e-6);
});

test('ticks draw teeth on all four borders; lines carry the chosen opacity', () => {
  const projection = projector([7.40, 43.72, 7.44, 43.76]), camera = projection.bounds;
  const centre = viewFromCamera(camera, projection.origin), width = 1000, height = Math.round(1000 * (camera.top - camera.bottom) / (camera.right - camera.left));
  assert.equal(gridDrawing(camera, centre, width, height, 1, { mode: 'none', opacity: 0.3 }, 3), undefined);
  const ticks = gridDrawing(camera, centre, width, height, 1, { mode: 'ticks', opacity: 0.3 }, 3)!;
  assert.equal(ticks.lines.length, 0); assert.ok(ticks.teeth.length >= 12 && ticks.teeth.length % 2 === 0);
  assert.ok(ticks.teeth.some(t => t.y1 === 3) && ticks.teeth.some(t => t.y1 === height - 3) && ticks.teeth.some(t => t.x1 === 3) && ticks.teeth.some(t => t.x1 === width - 3));
  const lines = gridDrawing(camera, centre, width, height, 1, { mode: 'lines', opacity: 0.3 }, 3)!;
  assert.equal(lines.teeth.length, 0); assert.equal(lines.lineOpacity, 0.3); assert.ok(lines.lines.length >= 6);
  assert.ok(lines.texts.length >= 4 && lines.texts.every(text => text.x >= 3 && text.x + text.text.length * lines.font * 0.6 <= width));
});
