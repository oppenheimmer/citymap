import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { designs, removeDesign, renameDesign, saveDesign, updateDesign } from '../src/lib/city-storage.ts';
import { DEFAULT_DESIGN } from '../src/lib/domain.ts';

function storage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>(); let denied = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (denied) throw new Error('Denied'); entries.set(key, value); } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  return { entries, deny: () => { denied = true; } };
}
const boundary = { key: 'osm-relation-1', name: 'City', kind: 'city', osmType: 'relation' as const, osmId: '1', areaId: '3600000001' };

test('renaming changes only the saved name and preserves identity, design and save date', t => {
  storage(t); assert.equal(saveDesign(boundary, DEFAULT_DESIGN), true);
  const before = designs()[0];
  assert.equal(renameDesign(before.id, '  東京 poster  '), true);
  assert.deepEqual(designs(), [{ ...before, name: '東京 poster' }]);
});

test('updating a saved map preserves its custom name and identity without making a duplicate', t => {
  const s = storage(t); saveDesign(boundary, DEFAULT_DESIGN);
  const before = { ...designs()[0], name: 'Custom name', savedAt: '2000-01-01T00:00:00.000Z' };
  s.entries.set('citymap:designs:v1', JSON.stringify([before]));
  const design = { ...DEFAULT_DESIGN, roadColor: '#123456', label: { ...DEFAULT_DESIGN.label, text: 'New label' } };
  assert.equal(updateDesign(before.id, boundary, design), true);
  const after = designs(); assert.equal(after.length, 1); assert.equal(after[0].id, before.id); assert.equal(after[0].name, 'Custom name');
  assert.deepEqual(after[0].design, design); assert.notEqual(after[0].savedAt, before.savedAt);
});

test('invalid names and missing saved IDs leave storage unchanged', t => {
  const s = storage(t); saveDesign(boundary, DEFAULT_DESIGN);
  const before = [...s.entries];
  for (const name of ['', ' ', 'x'.repeat(257)]) assert.equal(renameDesign(designs()[0].id, name), false);
  assert.equal(renameDesign('missing', 'Name'), false); assert.equal(updateDesign('missing', boundary, DEFAULT_DESIGN), false);
  assert.deepEqual([...s.entries], before);
});

test('storage denial reports failure without discarding saved designs', t => {
  const s = storage(t); saveDesign(boundary, DEFAULT_DESIGN); const before = designs(); s.deny();
  assert.equal(renameDesign(before[0].id, 'Name'), false);
  assert.equal(updateDesign(before[0].id, boundary, DEFAULT_DESIGN), false);
  assert.equal(removeDesign(before[0].id), false); assert.deepEqual(designs(), before);
});
