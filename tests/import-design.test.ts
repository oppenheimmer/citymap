import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDesign, MAX_DESIGN_FILE_BYTES } from '../src/lib/import-design.ts';
import { designFile } from '../src/lib/design-file.ts';
import { DEFAULT_DESIGN } from '../src/lib/domain.ts';

const record = { id: 'local', name: 'Saved 東京', savedAt: '2026-10-29T00:00:00.000Z', boundary: { key: 'osm-relation-9007199254740993', name: '東京', kind: 'city', osmType: 'relation' as const, osmId: '9007199254740993', areaId: '9007202854740993', revision: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) }, design: { ...DEFAULT_DESIGN, label: { ...DEFAULT_DESIGN.label, text: '東京 <Map> & roads', bold: true }, view: { lon: 139, lat: 35, width: 1200, height: 900 } } };
const file = () => JSON.parse(designFile(record, 'https://old.example', '/old-app'));
const read = (value: unknown, fixtures = false) => importDesign(JSON.stringify(value), 'https://new.example', '/maps', fixtures);

test('exported settings import Unicode, marks, view and pinned identity without navigating the supplied link', () => {
  const value = file(); value.link = 'https://unrelated.example/never-open-this';
  const result = read(value);
  assert.equal(result.name, record.name); assert.deepEqual(result.design, record.design);
  assert.equal(result.boundary.osmId, record.boundary.osmId); assert.equal(result.boundary.revision, record.boundary.revision);
});

test('older version-one settings restore defaults for optional marks and typefaces', () => {
  const value = file();
  for (const key of ['font', 'detail', 'north', 'northAt', 'scaleBar', 'rotation']) delete value.design[key];
  const result = read(value);
  for (const key of ['font', 'detail', 'north', 'northAt', 'scaleBar', 'rotation'] as const) assert.deepEqual(result.design[key], DEFAULT_DESIGN[key]);
});

test('malformed, wrong-version, oversized and non-object files are rejected', () => {
  assert.throws(() => importDesign('{', 'https://app.example', '/'), /JSON/);
  for (const value of [null, [], { ...file(), version: 2 }, { ...file(), format: 'other' }]) assert.throws(() => read(value));
  assert.throws(() => importDesign(' '.repeat(MAX_DESIGN_FILE_BYTES + 1), 'https://app.example', '/'), /64 KB/);
  assert.throws(() => importDesign('界'.repeat(MAX_DESIGN_FILE_BYTES / 2), 'https://app.example', '/'), /64 KB/);
});

test('invalid identities, bounds and dataset references cannot start a misleading restore', () => {
  for (const patch of [{ name: '' }, { osmId: 'invalid' }, { osmType: 'other' }, { osmType: undefined }, { bbox: [91, 10, 92, 11] }, { revision: 'bad' }, { manifestSha256: undefined }, { areaId: '0' }]) {
    const value = file(); Object.assign(value.boundary, patch); assert.throws(() => read(value));
  }
  const missing = file(); missing.boundary = { name: 'Missing', kind: 'city' }; assert.throws(() => read(missing));
});

test('invalid style and geographic values are rejected rather than silently replaced', () => {
  for (const patch of [{ roadColor: 'url(invalid)' }, { roadOpacity: 2 }, { north: 'yes' }, { font: 'unknown' }, { detail: 'unknown' }, { rotation: 181 }, { northAt: { x: -1, y: 0 } }, { view: { lon: 200, lat: 35, width: 100, height: 100 } }]) {
    const value = file(); Object.assign(value.design, patch); assert.throws(() => read(value));
  }
  for (const patch of [{ text: 'x'.repeat(257) }, { opacity: -1 }, { color: 'invalid' }, { size: 0 }, { x: 2 }, { bold: 'yes' }]) {
    const value = file(); Object.assign(value.design.label, patch); assert.throws(() => read(value));
  }
});

test('synthetic settings are accepted only by explicit test builds', () => {
  const value = file(); value.boundary = { name: 'Small sample', fixture: 'small' };
  assert.throws(() => read(value), /Test maps/);
  assert.equal(read(value, true).boundary.fixture, 'small');
});
