import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { assert, decodeChunk, geometryStats, manifestKey, roadPoints, validateManifest } from '../../src/lib/data/city-cache.ts';
import type { CityManifest, CityRoadChunk, PointE7, RoadPolyline } from '../../src/lib/data/city-types.ts';
import { sha256, stableJson } from './build.ts';
import type { BuiltDataset } from './build.ts';

function localPath(root: string, key: string) {
  assert(!path.isAbsolute(key) && !key.includes('\\') && key.split('/').every(part => part !== '..' && part !== '.' && part !== ''), 'Unsafe object key');
  return path.join(root, key);
}

async function readObject(root: string, key: string): Promise<Buffer> {
  const base = await realpath(root);
  const file = await realpath(localPath(base, key));
  assert(file.startsWith(base + path.sep), 'Object path escapes data root');
  return readFile(file);
}

export async function writeDataset(root: string, dataset: BuiltDataset) {
  validateManifest(dataset.manifest);
  // All immutable objects precede latest.json. No network or bucket operations occur here.
  for (const object of dataset.objects) {
    const file = localPath(root, object.key);
    await mkdir(path.dirname(file), { recursive: true });
    if (object.immutable) {
      try {
        await writeFile(file, object.bytes, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assert(sha256(await readObject(root, object.key)) === sha256(object.bytes), `Refusing to overwrite immutable object ${object.key}`);
      }
    } else {
      await validateDataset(root, manifestKey(dataset.manifest.city_key, dataset.manifest.dataset_revision));
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, object.bytes, { flag: 'wx' });
      await rename(temp, file);
    }
  }
  const plan = {
    plan_version: 1,
    city_key: dataset.manifest.city_key,
    dataset_revision: dataset.manifest.dataset_revision,
    source_kind: dataset.manifest.source.kind,
    // Array order is the required remote publication order; apply headers, don't blindly sync.
    objects: dataset.objects.map(object => ({
      key: object.key, local_path: object.key, bytes: object.bytes.byteLength,
      stored_sha256: sha256(object.bytes), immutable: object.immutable, headers: object.headers,
    })),
  };
  const planKey = manifestKey(dataset.manifest.city_key, dataset.manifest.dataset_revision).replace('manifest.json', 'upload-plan.local.json');
  await writeFile(localPath(root, planKey), stableJson(plan) + '\n');
  return planKey;
}

export async function validateDataset(root: string, manifestObjectKey: string): Promise<{ manifest: CityManifest; chunks: CityRoadChunk[] }> {
  const value: unknown = JSON.parse((await readObject(root, manifestObjectKey)).toString('utf8'));
  validateManifest(value);
  const manifest = value;
  assert(manifestObjectKey === manifestKey(manifest.city_key, manifest.dataset_revision), 'Manifest path does not match city/revision');
  const chunks: CityRoadChunk[] = [];
  const fragments = new Map<string, Map<number, RoadPolyline>>();
  for (const descriptor of manifest.chunks) {
    const wire = await readObject(root, descriptor.key);
    assert(wire.byteLength === descriptor.wire_bytes && sha256(wire) === descriptor.stored_sha256, 'Stored chunk size/checksum mismatch');
    // Prevent corrupt gzip streams from inflating beyond the manifest's validated limit.
    const decoded = gunzipSync(wire, { maxOutputLength: descriptor.decoded_bytes });
    assert(decoded.byteLength === descriptor.decoded_bytes && sha256(decoded) === descriptor.decoded_sha256, 'Decoded chunk size/checksum mismatch');
    const chunk = decodeChunk(decoded);
    assert(chunk.city_key === manifest.city_key && chunk.dataset_revision === manifest.dataset_revision && chunk.chunk_index === descriptor.index && chunk.chunk_count === manifest.chunks.length && chunk.detail_level === 0, 'Chunk identity/detail does not match manifest');
    const stats = geometryStats(chunk.roads);
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) {
      assert(stableJson(stats[key]) === stableJson(descriptor[key]), `Chunk ${key} does not match manifest`);
    }
    for (const road of chunk.roads) {
      const parts = fragments.get(road.osm_way_id) ?? new Map<number, RoadPolyline>();
      assert(!parts.has(road.fragment_index), 'Duplicate fragment across chunks');
      parts.set(road.fragment_index, road);
      fragments.set(road.osm_way_id, parts);
    }
    chunks.push(chunk);
  }
  for (const parts of fragments.values()) {
    let endpoint: PointE7 | undefined;
    const first = parts.get(0);
    assert(first, 'Way is missing its first fragment');
    for (let index = 0; index < parts.size; index++) {
      const road = parts.get(index);
      assert(road, 'Way fragment indices are not contiguous');
      assert(road.highway === first.highway && road.bridge === first.bridge && road.tunnel === first.tunnel && road.layer === first.layer, 'Way tags differ between fragments');
      const points = roadPoints(road);
      assert(!endpoint || endpoint[0] === points[0][0] && endpoint[1] === points[0][1], 'Way fragment endpoints are disconnected');
      endpoint = points.at(-1);
    }
  }
  const stats = geometryStats(chunks.flatMap(chunk => chunk.roads));
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) {
    assert(stableJson(stats[key]) === stableJson(manifest[key]), `Dataset ${key} does not match manifest`);
  }
  return { manifest, chunks };
}
