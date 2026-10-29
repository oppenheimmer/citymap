import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDataset } from '../tools/city-data/build.ts';
import { syntheticCity } from '../tools/city-data/fixtures.ts';
import { writeStaticBundle } from '../tools/city-data/files.ts';
import { decodeChunk } from '../src/lib/data/city-cache.ts';

test('static bundles retain prior revisions and publish decoded, verifiable chunks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-bundle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = syntheticCity(), first = buildDataset(input, 1000);
  await writeStaticBundle(root, first);
  const original = await readFile(path.join(root, first.manifest.chunks[0].key));
  assert.equal(decodeChunk(original).dataset_revision, first.manifest.dataset_revision);
  const second = buildDataset(syntheticCity(65), 1000);
  assert.notEqual(second.manifest.dataset_revision, first.manifest.dataset_revision);
  await writeStaticBundle(root, second); await writeStaticBundle(root, second);
  assert.deepEqual(await readFile(path.join(root, first.manifest.chunks[0].key)), original);
  const pointer = JSON.parse(await readFile(path.join(root, `v2/cities/${second.manifest.city_key}/latest.json`), 'utf8'));
  assert.equal(pointer.dataset_revision, second.manifest.dataset_revision);
});

test('changed immutable bundle bytes are rejected without overwriting a pinned revision', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-bundle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = buildDataset(syntheticCity(), 1000); await writeStaticBundle(root, dataset);
  const manifest = dataset.objects.find(object => object.key.endsWith('/manifest.json'))!;
  const original = await readFile(path.join(root, manifest.key));
  const changed = { ...dataset, objects: dataset.objects.map(object => object === manifest ? { ...object, bytes: Buffer.from('{}') } : object) };
  await assert.rejects(() => writeStaticBundle(root, changed), /immutable bundled object/);
  assert.deepEqual(await readFile(path.join(root, manifest.key)), original);
});

test('static bundle output rejects object keys outside the target directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'citymap-bundle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = buildDataset(syntheticCity(), 1000);
  await assert.rejects(() => writeStaticBundle(root, { ...dataset, objects: [{ ...dataset.objects[0], key: '../escape' }] }), /Unsafe object key/);
});
