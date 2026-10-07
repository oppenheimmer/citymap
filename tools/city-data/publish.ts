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
interface PointerState { etag?: string; response: R2Response }
async function readPointer(client: PublisherClient, key: string): Promise<PointerState> {
  const response = await client.request('GET', key);
  assert(response.status === 200 || response.status === 404, `R2 pointer read failed (${response.status})`);
  const etag = response.headers.get('ETag') || undefined;
  assert(response.status !== 200 || etag, 'R2 pointer is missing an ETag');
  return { response, etag };
}
async function pointer(client: PublisherClient, object: ObjectToPublish, previous: PointerState) {
  const put = await client.request('PUT', object.key, object.body, { ...object.headers, ...(previous.etag ? { 'If-Match': previous.etag } : { 'If-None-Match': '*' }) });
  assert([200, 201].includes(put.status), `Pointer changed concurrently or upload failed (${put.status})`);
  const read = await client.request('GET', object.key);
  assert(read.status === 200 && sha256(read.body) === sha256(object.body), 'Pointer read-back mismatch');
  for (const [name, value] of Object.entries(object.headers)) assert(read.headers.get(name) === value, `R2 pointer header mismatch: ${name}`);
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
  assert(stableJson(JSON.parse(body.toString('utf8'))) === stableJson(manifest), 'Manifest changed after validation');
  objects.push({ key, body, immutable: true, headers: { 'Content-Type': 'application/json', 'Cache-Control': IMMUTABLE_CACHE } });
  const latest = Buffer.from(stableJson({ pointer_version: 1, city_key: manifest.city_key, dataset_revision: manifest.dataset_revision, manifest: key, manifest_sha256: sha256(body) }) + '\n');
  objects.push({ key: `v2/cities/${manifest.city_key}/latest.json`, body: latest, immutable: false, headers: { 'Content-Type': 'application/json', 'Cache-Control': POINTER_CACHE } });
  return { manifest, objects };
}

async function publishPrepared(publication: Awaited<ReturnType<typeof preparePublication>>, client: PublisherClient) {
  assert(publication.manifest.source.kind === 'osm-extract', 'Synthetic fixtures cannot be published as public cities');
  const latest = publication.objects.at(-1)!;
  // Capture concurrency state before uploading, so a competing revision wins safely.
  const previous = await readPointer(client, latest.key);
  for (const object of publication.objects.slice(0, -1)) await immutable(client, object);
  await pointer(client, latest, previous);
}
export async function publishCity(root: string, key: string, client: PublisherClient): Promise<CityManifest> {
  const publication = await preparePublication(root, key);
  await publishPrepared(publication, client);
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

async function catalogState(client: PublisherClient, manifests: CityManifest[]): Promise<PointerState> {
  const previous = await readPointer(client, 'v2/catalog.json');
  if (previous.response.status === 404) return previous;
  const root = JSON.parse(previous.response.body.toString('utf8'));
  assert(root.index_version === 1 && /^[a-f0-9]{64}$/.test(root.catalog_revision) && Array.isArray(root.countries) && root.countries.length <= 1000, 'Invalid existing catalog');
  const covered = new Set<string>(), countries = new Set<string>();
  for (const descriptor of root.countries) {
    assert(/^[A-Z]{2}$/.test(descriptor.country) && !countries.has(descriptor.country) && descriptor.key === `v2/catalogs/${root.catalog_revision}/${descriptor.country}.json` && /^[a-f0-9]{64}$/.test(descriptor.sha256), 'Invalid catalog country reference');
    countries.add(descriptor.country);
    const response = await client.request('GET', descriptor.key);
    assert(response.status === 200 && sha256(response.body) === descriptor.sha256, 'Existing country index checksum mismatch');
    const index = JSON.parse(response.body.toString('utf8'));
    assert(index.index_version === 1 && index.catalog_revision === root.catalog_revision && index.country === descriptor.country && Array.isArray(index.cities) && index.cities.length === descriptor.city_count, 'Invalid existing country index');
    for (const city of index.cities) {
      assert(typeof city.city_key === 'string' && /^osm-(node|way|relation)-[1-9][0-9]*$/.test(city.city_key) && city.country === descriptor.country && !covered.has(city.city_key), 'Invalid existing catalog city');
      covered.add(city.city_key);
    }
  }
  assert(root.city_count === covered.size, 'Existing catalog totals mismatch');
  const supplied = new Set(manifests.map(manifest => manifest.city_key));
  assert([...covered].every(key => supplied.has(key)), 'Catalog replacement would remove cities. Supply the complete catalog set.');
  return previous;
}

export async function publishDatasets(root: string, keys: string[], client: PublisherClient, withCatalog = false): Promise<void> {
  const publications = [];
  for (const key of keys) publications.push(await preparePublication(root, key));
  const manifests = publications.map(publication => publication.manifest);
  assert(manifests.length && new Set(manifests.map(manifest => manifest.city_key)).size === manifests.length, 'Supply one revision per city');
  assert(manifests.every(manifest => manifest.source.kind === 'osm-extract'), 'Synthetic fixtures cannot be published as public cities');
  const catalog = withCatalog ? catalogObjects(manifests) : [];
  // Validate coverage before any writes and retain this ETag until the final catalog CAS.
  const previous = withCatalog ? await catalogState(client, manifests) : undefined;
  for (const publication of publications) await publishPrepared(publication, client);
  if (previous) {
    for (const object of catalog.slice(0, -1)) await immutable(client, object);
    await pointer(client, catalog.at(-1)!, previous);
  }
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
  await publishDatasets(values.root, values.manifest, client, values.catalog);
  console.log('Publication and read-back verification complete.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'Publication failed'); process.exitCode = 1; });
