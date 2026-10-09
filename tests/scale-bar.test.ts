import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metresPerSceneUnit, niceDivisions, scaleBar, SCALE_BAR } from '../src/lib/scale-bar.ts';
// About 0.6 em per character, so half a label is 0.3 em per character.
const halfWidth = (text: string) => text.length * SCALE_BAR.font * 0.3;

test('scale divisions use the longest whole-number 1/2/5 steps, two to five of them', () => {
  assert.deepEqual(niceDivisions(3.7), { step: 1, count: 3 });
  assert.deepEqual(niceDivisions(9.9), { step: 2, count: 4 });
  assert.deepEqual(niceDivisions(370), { step: 100, count: 3 });
  assert.deepEqual(niceDivisions(2.2), { step: 1, count: 2 });
  // Fewer than two whole units: the caller switches to a smaller unit.
  for (const value of [1.4, 0.9, 0, NaN]) assert.equal(niceDivisions(value), undefined);
});

test('scene units follow Mercator ground scale by latitude', () => {
  assert.ok(Math.abs(metresPerSceneUnit(0) - 1) < 1e-3);
  assert.ok(Math.abs(metresPerSceneUnit(60) - 0.5) < 1e-3);
});

test('the railway scale puts kilometre teeth above and mile teeth below at whole numbers only', () => {
  const bar = scaleBar(25)!; // 140 px is 3.5 km and about 2.17 mi
  const labels = bar.texts.map(text => text.text);
  assert.deepEqual(labels.filter((_, i) => bar.texts[i].y < 19), ['0', '1', '2', '3 km']);
  assert.deepEqual(labels.filter((_, i) => bar.texts[i].y > 19), ['0', '1', '2 mi']);
  assert.equal(bar.summary, '3 km and 2 mi');
  const rail = bar.lines[0];
  assert.ok(rail.x2 - rail.x1 <= SCALE_BAR.maxLength && bar.width === rail.x2 - rail.x1 + 2 * rail.x1);
  // Labels centred on the end teeth fit inside the mark.
  assert.ok(bar.texts.every(text => text.x - halfWidth(text.text) >= 0 && text.x + halfWidth(text.text) <= bar.width));
  assert.ok(bar.lines.slice(1).every(line => line.x1 >= rail.x1 - 1e-9 && line.x1 <= rail.x2 + 1e-9 && (line.y2 < line.y1 || line.y2 > line.y1)));
  // One tooth per labelled whole number; no half-unit teeth.
  assert.equal(bar.lines.length - 1, bar.texts.length);
  assert.ok(bar.texts.every(text => /^\d+( [a-z]+)?$/.test(text.text)));
});

test('short distances switch to whole metres and feet', () => {
  const bar = scaleBar(2.5)!; // 140 px is 350 m and about 1,148 ft
  assert.equal(bar.summary, '300 m and 1000 ft');
  assert.deepEqual(bar.texts.map(text => text.text), ['0', '100', '200', '300 m', '0', '500', '1000 ft']);
  assert.equal(scaleBar(10)!.summary, '1000 m and 4000 ft'); // 1.4 km and 4,593 ft: fewer than two whole km or miles
  const wide = scaleBar(10)!; assert.ok(wide.texts.every(text => text.x + halfWidth(text.text) <= wide.width));
  // 140 px is about 2,700 ft: 500 ft steps (26 px) would crowd their labels, so 1000 ft steps.
  assert.deepEqual(scaleBar(5.88)!.texts.filter(text => text.y > 19).map(text => text.text), ['0', '1000', '2000 ft']);
  // When no two-step feet scale is readable within 140 px (about 990 ft), one step is used.
  assert.deepEqual(scaleBar(2.16)!.texts.filter(text => text.y > 19).map(text => text.text), ['0', '500 ft']);
  for (const metres of [0.2, 0.7, 1.3, 2.16, 2.5, 5.88, 10, 25, 80, 300, 2000]) {
    assert.ok(scaleBar(metres), `no scale bar at ${metres} m/px`);
    const bar = scaleBar(metres)!;
    for (const side of [bar.texts.filter(text => text.y < 19), bar.texts.filter(text => text.y > 19)]) for (let i = 1; i < side.length; i++) assert.ok(side[i].x - side[i - 1].x >= halfWidth(side[i].text) + halfWidth(side[i - 1].text), `${metres} m/px: ${side[i - 1].text} and ${side[i].text} overlap`);
  }
  assert.equal(scaleBar(0), undefined); assert.equal(scaleBar(Infinity), undefined);
});

test('marks stay inside the map, and the scale bar defaults to just below the north arrow', async () => {
  const { markCentre, northCentre, scaleBarCentre, MARK_GAP } = await import('../src/lib/marks.ts');
  const { NORTH_ARROW } = await import('../src/lib/north-arrow.ts');
  const { DEFAULT_DESIGN } = await import('../src/lib/domain.ts');
  const map = { width: 400, height: 300 }, bar = { width: 172, height: 38 };
  assert.deepEqual(markCentre({ x: 1, y: 0 }, bar, map), { x: 400 - 86, y: 19 });
  assert.deepEqual(markCentre({ x: 0.5, y: 0.5 }, { width: 500, height: 10 }, map), { x: 200, y: 150 });
  const north = northCentre(DEFAULT_DESIGN, map), below = scaleBarCentre(DEFAULT_DESIGN, bar, map);
  assert.equal(below.y, north.y + NORTH_ARROW.height / 2 + MARK_GAP + bar.height / 2);
  assert.ok(below.x + bar.width / 2 <= map.width);
  // Exports scale CSS geometry; a moved scale bar keeps its own position.
  assert.equal(scaleBarCentre(DEFAULT_DESIGN, bar, { width: 800, height: 600 }, 2).y, northCentre(DEFAULT_DESIGN, { width: 800, height: 600 }, 2).y + (NORTH_ARROW.height / 2 + MARK_GAP + bar.height / 2) * 2);
  assert.deepEqual(scaleBarCentre({ ...DEFAULT_DESIGN, scaleBarAt: { x: 0.5, y: 0.5 } }, bar, map), { x: 200, y: 150 });
});
