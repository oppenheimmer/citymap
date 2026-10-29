import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryBounds, visibilityFrame, withinFrame } from '../src/lib/visibility.ts';
import { frameCorners } from '../src/lib/view.ts';
import { intersects } from '../src/lib/live/grid.ts';

test('collection bounds read only their typed-array view and keep horizontal/vertical roads', () => {
  const buffer = new Float32Array([999, 999, -5, 2, 10, 2, -999, -999]);
  const bounds = geometryBounds(buffer.subarray(2, 6));
  assert.deepEqual(bounds, { left: -5, right: 10, bottom: 2, top: 2 });
  assert.ok(withinFrame(bounds, visibilityFrame({ left: -1, right: 1, bottom: 1, top: 3 }, 0)));
  assert.ok(withinFrame({ left: 0, right: 0, bottom: -4, top: 4 }, visibilityFrame({ left: -1, right: 1, bottom: -1, top: 1 }, 90)));
});

test('rotated collection culling agrees with independent polygon intersection across camera angles', () => {
  const camera = { left: -8.2, right: 8.2, bottom: -3.7, top: 3.7 };
  for (const rotation of [-180, -135, -91, -45, -1, 0, 23, 45, 89, 90, 135, 180]) {
    const frame = visibilityFrame(camera, rotation), corners = frameCorners(camera, rotation);
    for (let x = -15; x <= 15; x++) for (let y = -15; y <= 15; y++) {
      const box = { left: x + 0.1, right: x + 0.9, bottom: y + 0.2, top: y + 0.8 };
      const visible = withinFrame(box, frame), intersectsFrame = intersects(corners, box);
      if (intersectsFrame) assert.ok(visible, `${rotation}° at ${x},${y}: a visible road was culled`);
      else if (visible) assert.ok(intersects(frameCorners(camera, rotation, 1 + 1e-9), box), 'Only touching edges may be kept conservatively');
    }
  }
});

test('stroke padding keeps roads just outside the frame visible, including at rotation', () => {
  const camera = { left: -5, right: 5, bottom: -3, top: 3 };
  const edge = { left: 5.1, right: 5.1, bottom: -2, top: 2 };
  assert.equal(withinFrame(edge, visibilityFrame(camera, 0)), false);
  assert.equal(withinFrame(edge, visibilityFrame(camera, 0, 0.2)), true);
  const corner = { left: 3.55, right: 3.65, bottom: 3.55, top: 3.65 };
  assert.equal(withinFrame(corner, visibilityFrame(camera, 45)), false);
  assert.equal(withinFrame(corner, visibilityFrame(camera, 45, 0.2)), true);
});
