import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assert, object, osmId, validateMetadata } from '../../src/lib/data/city-cache.ts';
import type { CityMetadata } from '../../src/lib/data/city-types.ts';
import { roadTags, stableJson } from './build.ts';
import { boundaryGeometry, coordinate, touchesBoundary } from './boundary.ts';

export interface ExtractionCity { metadata: CityMetadata; geometry: unknown }
export interface ExtractedCity { city_key: string; input: string; ways: number; nodes: number; segments: number }
const MAX_LINE_BYTES = 1024 * 1024;

export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function* sourceRecords(mode: 'header' | 'elements' | 'boundary', file: string, python: string, args: string[] = [], signal?: AbortSignal): AsyncGenerator<unknown> {
  const child = spawn(python, ['-u', fileURLToPath(new URL('./osm-source.py', import.meta.url)), mode, file, ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-4096); });
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`OSM source reader failed (${code}): ${diagnostics.trim()}`)));
  });
  void completed.catch(() => {});
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let remaining = '';
  try {
    for await (const bytes of child.stdout) {
      remaining += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = remaining.indexOf('\n')) >= 0) {
        const line = remaining.slice(0, end); remaining = remaining.slice(end + 1);
        assert(Buffer.byteLength(line) <= MAX_LINE_BYTES, 'OSM primitive exceeds the record limit');
        if (line) yield JSON.parse(line);
      }
      assert(Buffer.byteLength(remaining) <= MAX_LINE_BYTES, 'OSM primitive exceeds the record limit');
    }
    remaining += decoder.decode();
    if (remaining.trim()) yield JSON.parse(remaining);
    await completed;
  } finally { if (child.exitCode === null) child.kill(); }
}

async function sourceValue(mode: 'header' | 'boundary', file: string, python: string, args: string[] = []): Promise<Record<string, unknown>> {
  const values = [];
  for await (const value of sourceRecords(mode, file, python, args)) values.push(value);
  assert(values.length === 1, 'Source reader must return exactly one record');
  return object(values[0], 'source record');
}

/** Disk-backed regional indexing retains complete touching ways and streams per-city JSON. */
export async function extractCities(output: string, cities: ExtractionCity[], elements: AsyncIterable<unknown>, signal?: AbortSignal): Promise<ExtractedCity[]> {
  assert(cities.length > 0 && cities.length <= 16, 'Extract 1..16 cities per bounded batch');
  const keys = new Set<string>();
  const selected = cities.map(city => {
    validateMetadata(city.metadata);
    assert(!keys.has(city.metadata.city_key), 'Duplicate city in extraction batch'); keys.add(city.metadata.city_key);
    return { ...city, geometry: boundaryGeometry(city.geometry), ways: 0, segments: 0 };
  });
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(path.join(output, '.extract-'));
  const db = new DatabaseSync(path.join(temporary, 'nodes.sqlite'));
  db.exec(`PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
    CREATE TABLE nodes (id TEXT PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL) WITHOUT ROWID;
    CREATE TABLE seen_ways (id TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE selected_nodes (city TEXT, id TEXT, PRIMARY KEY(city,id)) WITHOUT ROWID;
    CREATE TABLE selected_ways (city TEXT, id TEXT, value TEXT, PRIMARY KEY(city,id)) WITHOUT ROWID;`);
  const addNode = db.prepare('INSERT INTO nodes VALUES (?,?,?)');
  const getNode = db.prepare('SELECT lon,lat FROM nodes WHERE id=?');
  const seenWay = db.prepare('INSERT INTO seen_ways VALUES (?)');
  const addWay = db.prepare('INSERT INTO selected_ways VALUES (?,?,?)');
  const addRef = db.prepare('INSERT OR IGNORE INTO selected_nodes VALUES (?,?)');
  let seenWays = false, transactionBytes = 0;
  const reports: ExtractedCity[] = [];
  try {
    db.exec('BEGIN');
    for await (const value of elements) {
      signal?.throwIfAborted();
      const e = object(value, 'OSM primitive'); osmId(e.id, 'source ID');
      if (e.type === 'node') {
        assert(!seenWays, 'Source must be ordered with nodes before ways');
        coordinate(e.lon, e.lat);
        addNode.run(e.id, e.lon as number, e.lat as number);
      } else if (e.type === 'way') {
        seenWays = true; seenWay.run(e.id);
        const tags = object(e.tags, 'road tags');
        assert(typeof tags.highway === 'string' && tags.highway.trim(), 'Source way must have a highway tag');
        roadTags(tags,e.id);
        assert(Array.isArray(e.nodes) && e.nodes.length >= 2 && e.nodes.length <= 10_000, 'Invalid or oversized road references');
        const points = e.nodes.map(id => {
          osmId(id, 'source node reference');
          const node = getNode.get(id); assert(node, `Road ${e.id} references missing node ${id}`);
          return coordinate(node.lon, node.lat);
        });
        for (const city of selected) {
          if (!touchesBoundary(points, city.geometry)) continue;
          city.ways++; city.segments += points.length - 1;
          assert(city.segments <= 8_000_000, `${city.metadata.city_key} exceeds the application geometry limit`);
          addWay.run(city.metadata.city_key, e.id, stableJson(e));
          for (const id of e.nodes) addRef.run(city.metadata.city_key, id as string);
        }
      } else throw new Error('Source reader must supply only nodes and highway ways');
      transactionBytes += Buffer.byteLength(JSON.stringify(e));
      if (transactionBytes >= 8 * 1024 * 1024) { db.exec('COMMIT; BEGIN'); transactionBytes = 0; }
    }
    db.exec('COMMIT');
    assert(selected.every(city => city.ways > 0), 'A declared city contains no touching roads');
    for (const city of selected) {
      signal?.throwIfAborted();
      const key = city.metadata.city_key;
      const tempFile = path.join(temporary, `${key}.json`);
      const file = await open(tempFile, 'wx');
      let nodes = 0, first = true;
      try {
        await file.writeFile(`{"metadata":${stableJson(city.metadata)},"elements":[`);
        const write = async (value: string) => { await file.writeFile(`${first ? '' : ','}\n${value}`); first = false; };
        const query = db.prepare('SELECT n.id,n.lon,n.lat FROM selected_nodes s JOIN nodes n ON n.id=s.id WHERE s.city=? ORDER BY length(n.id),n.id');
        for (const row of query.iterate(key)) {
          signal?.throwIfAborted(); nodes++;
          await write(stableJson({ type: 'node', id: row.id, lon: row.lon, lat: row.lat }));
        }
        for (const row of db.prepare('SELECT value FROM selected_ways WHERE city=? ORDER BY length(id),id').iterate(key)) {
          signal?.throwIfAborted(); await write(row.value as string);
        }
        await file.writeFile('\n]}\n'); await file.sync();
      } finally { await file.close(); }
      reports.push({ city_key: key, input: `${key}.json`, ways: city.ways, nodes, segments: city.segments });
    }
    // Validate every city before replacing any output; failed extraction leaves old inputs intact.
    for (const report of reports) await rename(path.join(temporary, report.input), path.join(output, report.input));
    return reports;
  } finally { db.close(); await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, config: { type: 'string' }, output: { type: 'string', default: '.city-data/inputs' },
    python: { type: 'string', default: 'python3' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log('data:extract --input region.osm.pbf --config cities.json [--output .city-data/inputs] [--python python3]\nReads local files only. Install the optional tools/city-data/requirements.txt in an isolated Python environment.'); return; }
  assert(values.input && values.config, '--input and --config are required');
  const configFile = path.resolve(values.config), config = object(JSON.parse(await readFile(configFile, 'utf8')), 'extraction config');
  const source = object(config.source, 'source');
  assert(await fileHash(values.input) === source.sha256, 'Regional source SHA-256 mismatch');
  const header = await sourceValue('header', values.input, values.python);
  assert(header.history === false && typeof header.snapshot_at === 'string' && header.snapshot_at.length > 0, 'A timestamped current OSM snapshot is required');
  assert(new Date(header.snapshot_at).toISOString() === source.snapshot_at, 'Regional source snapshot timestamp mismatch');
  assert(Array.isArray(config.cities) && config.cities.length > 0 && config.cities.length <= 16, 'Config requires 1..16 declared cities');
  const cities: ExtractionCity[] = [];
  for (const entry of config.cities) {
    const city = object(entry, 'city config');
    validateMetadata({ ...city.metadata as object, source });
    const metadata = { ...city.metadata as CityMetadata, source } as CityMetadata;
    assert(metadata.source.kind === 'osm-extract', 'Regional extraction requires a real OSM source');
    assert(typeof city.boundary_file === 'string', 'boundary_file is required');
    const boundaryFile = path.resolve(path.dirname(configFile), city.boundary_file);
    assert((await stat(boundaryFile)).size <= 16 * 1024 * 1024, 'Boundary file exceeds 16 MiB');
    assert(await fileHash(boundaryFile) === metadata.boundary.sha256, 'Boundary SHA-256 mismatch');
    const feature = boundaryFile.endsWith('.geojson') ? object(JSON.parse(await readFile(boundaryFile, 'utf8')), 'boundary feature') :
      await sourceValue('boundary', boundaryFile, values.python, ['--type', metadata.boundary.osm_type, '--id', metadata.boundary.osm_id]);
    const properties = object(feature.properties, 'boundary identity');
    assert(feature.type === 'Feature' && properties.osm_type === metadata.boundary.osm_type && properties.osm_id === metadata.boundary.osm_id && properties.version === metadata.boundary.version, 'Boundary identity/version mismatch');
    cities.push({ metadata, geometry: feature.geometry });
  }
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Extraction cancelled'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const reports = await extractCities(path.resolve(values.output), cities, sourceRecords('elements', values.input, values.python, [], abort.signal), abort.signal);
    console.log(JSON.stringify({ source: config.source, decoder: header.decoder, selection: 'complete-ways-touching-e7-polygon', cities: reports }, null, 2));
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
