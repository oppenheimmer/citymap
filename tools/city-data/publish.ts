import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assert, manifestKey } from '../../src/lib/data/city-cache.ts';
import { IMMUTABLE_CACHE, POINTER_CACHE, sha256, stableJson } from './build.ts';
import { validateDataset } from './files.ts';
import { R2, r2Config } from '../../server/r2.ts';
import type { R2Response } from '../../server/r2.ts';
import type { CityManifest } from '../../src/lib/data/city-types.ts';

export interface PublisherClient { request(method: 'GET' | 'HEAD' | 'PUT', key: string, body?: Buffer, headers?: Record<string, string>): Promise<R2Response> }
interface ObjectToPublish { key: string; body: Buffer; headers: Record<string, string>; immutable: boolean }
async function local(root: string, key: string): Promise<Buffer> {
  const base = await realpath(root), file = await realpath(path.join(base, key));
  assert(file.startsWith(base + path.sep), 'Dataset path escapes output root');
  return readFile(file);
}

async function immutable(client: PublisherClient, object: ObjectToPublish) {
  const put = await client.request('PUT', object.key, object.body, { ...object.headers, 'If-None-Match': '*', 'x-amz-meta-sha256': sha256(object.body) });
  assert([200, 201, 409, 412].includes(put.status), `R2 immutable upload failed (${put.status})`);
  const read = await client.request('GET', object.key);
  assert(read.status === 200 && sha256(read.body) === sha256(object.body), `Immutable read-back mismatch: ${object.key}`);
  for (const [name, value] of Object.entries(object.headers)) assert(read.headers.get(name) === value, `R2 object header mismatch: ${name}`);
}
async function pointer(client: PublisherClient, object: ObjectToPublish) {
  const previous = await client.request('GET', object.key);
  assert(previous.status === 200 || previous.status === 404, `R2 pointer read failed (${previous.status})`);
  const etag = previous.headers.get('ETag');
  assert(previous.status !== 200 || etag, 'R2 pointer is missing an ETag');
  const put = await client.request('PUT', object.key, object.body, { ...object.headers, ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) });
  assert([200, 201].includes(put.status), `Pointer changed concurrently or upload failed (${put.status})`);
  const read = await client.request('GET', object.key);
  assert(read.status === 200 && sha256(read.body) === sha256(object.body), 'Pointer read-back mismatch');
}

export async function preparePublication(root: string, key: string): Promise<{ manifest: CityManifest; objects: ObjectToPublish[] }> {
  const { manifest } = await validateDataset(root, key);
  const objects: ObjectToPublish[] = [];
  for (const descriptor of manifest.chunks) {
    const body = await local(root, descriptor.key);
    assert(sha256(body) === descriptor.stored_sha256, 'Stored chunk changed after validation');
    objects.push({ key: descriptor.key, body, immutable: true, headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', 'Cache-Control': IMMUTABLE_CACHE } });
  }
  const body = await local(root, key);
  objects.push({ key, body, immutable: true, headers: { 'Content-Type': 'application/json', 'Cache-Control': IMMUTABLE_CACHE } });
  const latest = Buffer.from(stableJson({ pointer_version: 1, city_key: manifest.city_key, dataset_revision: manifest.dataset_revision, manifest: key, manifest_sha256: sha256(body) }) + '\n');
  objects.push({ key: `v2/cities/${manifest.city_key}/latest.json`, body: latest, immutable: false, headers: { 'Content-Type': 'application/json', 'Cache-Control': POINTER_CACHE } });
  return { manifest, objects };
}

export async function publishCity(root: string, key: string, client: PublisherClient): Promise<CityManifest> {
  const publication = await preparePublication(root, key);
  assert(publication.manifest.source.kind === 'osm-extract', 'Synthetic fixtures cannot be published as public cities');
  for (const object of publication.objects) await (object.immutable ? immutable(client, object) : pointer(client, object));
  return publication.manifest;
}

export function catalogObjects(manifests: CityManifest[]): ObjectToPublish[] {
  assert(manifests.length > 0 && new Set(manifests.map(manifest => manifest.city_key)).size === manifests.length, 'Catalog needs unique cities');
  const cities = manifests.map(m => ({ city_key: m.city_key, name: m.name, country: m.country, osm_type: m.boundary.osm_type, osm_id: m.boundary.osm_id, area_ids: m.area_ids, bounds: m.bounds, boundary_policy: m.boundary.policy, coverage: 'full', source_date: m.source.snapshot_at, manifest: manifestKey(m.city_key, m.dataset_revision), latest: `v2/cities/${m.city_key}/latest.json` })).sort((a, b) => a.city_key < b.city_key ? -1 : a.city_key > b.city_key ? 1 : 0);
  const revision = sha256(stableJson(cities));
  const objects: ObjectToPublish[] = [], countries = [];
  for (const country of [...new Set(cities.map(city => city.country))].sort()) {
    const entries = cities.filter(city => city.country === country);
    const body = Buffer.from(stableJson({ index_version: 1, catalog_revision: revision, country, cities: entries }) + '\n');
    const key = `v2/catalogs/${revision}/${country}.json`;
    objects.push({ key, body, immutable: true, headers: { 'Content-Type': 'application/json', 'Cache-Control': IMMUTABLE_CACHE } });
    countries.push({ country, key, city_count: entries.length, sha256: sha256(body) });
  }
  objects.push({ key: 'v2/catalog.json', body: Buffer.from(stableJson({ index_version: 1, catalog_revision: revision, city_count: cities.length, countries }) + '\n'), immutable: false, headers: { 'Content-Type': 'application/json', 'Cache-Control': POINTER_CACHE } });
  return objects;
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: '.city-data' }, manifest: { type: 'string', multiple: true }, execute: { type: 'boolean' }, catalog: { type: 'boolean' } } });
  assert(values.manifest?.length, 'Supply one or more --manifest object keys');
  const publications = [];
  for (const key of values.manifest) publications.push(await preparePublication(values.root, key));
  const objects = publications.flatMap(publication => publication.objects);
  if (values.catalog) objects.push(...catalogObjects(publications.map(publication => publication.manifest)));
  console.log(JSON.stringify({ mode: values.execute ? 'publish' : 'dry-run', objects: objects.map(object => ({ key: object.key, bytes: object.body.byteLength, sha256: sha256(object.body), headers: object.headers, immutable: object.immutable })) }, null, 2));
  if (!values.execute) return;
  assert(publications.every(publication => publication.manifest.source.kind === 'osm-extract'), 'Synthetic fixtures cannot be published as public cities');
  const config = r2Config(process.env, process.env.R2_DATA_BUCKET || '');
  assert(config, 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_DATA_BUCKET in the publisher environment');
  const client = new R2(config);
  for (const publication of publications) await publishCity(values.root, manifestKey(publication.manifest.city_key, publication.manifest.dataset_revision), client);
  if (values.catalog) for (const object of catalogObjects(publications.map(publication => publication.manifest))) await (object.immutable ? immutable(client, object) : pointer(client, object));
  console.log('Publication and read-back verification complete.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Publication failed'); process.exitCode = 1; });
