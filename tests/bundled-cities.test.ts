import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { decodeChunk, manifestKey, validateManifest } from '../src/lib/data/city-cache.ts';
import { BUNDLED_CITIES } from '../src/lib/bundled-cities.ts';

const root = new URL('../public/data/', import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('the shipped data directory holds exactly the bundled cities', async () => {
  assert.deepEqual((await readdir(new URL('v2/cities/', root))).sort(), [...BUNDLED_CITIES].sort());
});

for (const key of BUNDLED_CITIES) test(`bundled ${key} is a complete, verifiable real-city dataset`, async () => {
  const pointer = JSON.parse(await readFile(new URL(`v2/cities/${key}/latest.json`, root), 'utf8'));
  assert.equal(pointer.pointer_version, 1); assert.equal(pointer.city_key, key);
  assert.equal(pointer.manifest, manifestKey(key, pointer.dataset_revision));
  const manifestBytes = await readFile(new URL(pointer.manifest, root));
  assert.equal(sha256(manifestBytes), pointer.manifest_sha256);
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(manifest);
  assert.equal(manifest.source.kind, 'osm-extract');
  let segments = 0;
  for (const descriptor of manifest.chunks) {
    // Chunks ship decoded, as a browser receives a gzip-encoded R2 object.
    const decoded = await readFile(new URL(descriptor.key, root));
    assert.equal(decoded.byteLength, descriptor.decoded_bytes); assert.equal(sha256(decoded), descriptor.decoded_sha256);
    const chunk = decodeChunk(decoded);
    assert.equal(chunk.dataset_revision, manifest.dataset_revision); assert.equal(chunk.chunk_index, descriptor.index);
    segments += descriptor.segment_count;
  }
  assert.equal(segments, manifest.segment_count);
});
