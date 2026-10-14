import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roadRank } from '../src/lib/domain.ts';
import { CellFailure, cellQuery, classifyRemark, fetchCell, isPublicOverpass, rankFilter, retryAfter, sanitizeRemark } from '../src/lib/live/overpass.ts';
import { tileBBox } from '../src/lib/live/grid.ts';

const HIGHWAYS = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'pedestrian', 'road', 'busway',
  'service', 'footway', 'path', 'steps', 'cycleway', 'track', 'bridleway', 'corridor', 'platform', 'construction', 'proposed', 'primary_linked', 'residential_link', 'xmotorway', 'Residential', ''];
/** Evaluates one Overpass tag filter as a predicate on a highway value. */
function matches(filter: string, value: string): boolean {
  return [...filter.matchAll(/\["highway"(?:(!?~)"([^"]+)")?\]/g)].every(([, operator, pattern]) => !operator || new RegExp(pattern).test(value) === (operator === '~'));
}

test('each rank query selects exactly the highway classes roadRank assigns to it', () => {
  for (const value of HIGHWAYS) {
    const selected = ([0, 1, 2] as const).filter(rank => matches(rankFilter(rank), value));
    assert.deepEqual(selected, [roadRank(value)], `${value} is selected by exactly its rank`);
  }
  assert.match(rankFilter(2), /^\["highway"\]\["highway"!~/);
});

test('cell queries are bounded bbox queries with outward-rounded edges and inline geometry', () => {
  const tile = { z: 13, x: 6049, y: 3600 }, [s, w, n, e] = tileBBox(tile);
  const query = cellQuery(tile, 1);
  assert.match(query, /^\[out:json\]\[timeout:30\]\[maxsize:67108864\];way\["highway"~"\^\(unclassified\|residential/);
  assert.match(query, /out geom qt;$/);
  assert.doesNotMatch(query, /area|\[timeout:120\]/);
  const box = query.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);out/)!.slice(1).map(Number);
  assert.ok(box[0] <= s && box[1] <= w && box[2] >= n && box[3] >= e);
  assert.ok(box[0] > s - 1e-7 && box[3] < e + 1e-7);
  for (const value of box) assert.ok(String(value).split('.')[1]?.length <= 7);
  // Columns end at the antimeridian, so edge cells stay within valid longitudes.
  const edge = cellQuery({ z: 13, x: 8191, y: 4500 }, 0).match(/\(([-\d.,]+)\);/)![1].split(',').map(Number);
  assert.equal(edge[3], 180); assert.ok(edge[1] < edge[3]);
});

const query = 'q';
function run(response: Response | (() => Promise<Response>), options: { maxBytes?: number; deadline?: number; signal?: AbortSignal } = {}) {
  return fetchCell({ url: 'http://localhost/roads', query, signal: options.signal || new AbortController().signal, maxBytes: options.maxBytes ?? 1024, deadline: options.deadline ?? 1000, idle: 1000, fetch: async (_url, init) => {
    assert.equal(init?.method, 'POST'); assert.equal(new URLSearchParams(String(init?.body)).get('data'), query);
    return typeof response === 'function' ? response() : response;
  } });
}
const failure = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof CellFailure); return error; } assert.fail('Expected a cell failure'); };

test('successful cells return parsed JSON and the received byte count', async () => {
  const body = JSON.stringify({ elements: [], osm3s: { timestamp_osm_base: '2026-10-01T00:00:00Z' } });
  assert.deepEqual(await run(new Response(body)), { data: JSON.parse(body), bytes: body.length });
});

test('provider failures are typed, including runtime errors inside HTTP 200 bodies', async () => {
  const timeout = await failure(run(new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 31 seconds.\u0000<script>' }))));
  assert.equal(timeout.code, 'timeout_or_resource_limit'); assert.ok(!timeout.remark!.includes(String.fromCharCode(0)));
  assert.equal((await failure(run(new Response(JSON.stringify({ remark: 'runtime error: Query run out of memory using about 2048 MB of RAM.' }))))).code, 'timeout_or_resource_limit');
  assert.equal((await failure(run(new Response(JSON.stringify({ remark: 'runtime error: something else' }))))).code, 'provider_unavailable');
  const limited = await failure(run(new Response('busy', { status: 429, headers: { 'Retry-After': '30' } })));
  assert.deepEqual([limited.code, limited.status, limited.retryAfter], ['rate_limited', 429, 30_000]);
  for (const [status, code] of [[400, 'invalid_request'], [404, 'invalid_request'], [503, 'provider_unavailable'], [504, 'provider_unavailable']] as const) assert.equal((await failure(run(new Response('', { status })))).code, code);
  assert.equal((await failure(run(new Response('{')))).code, 'decode_failure');
  assert.equal((await failure(run(new Response('7')))).code, 'decode_failure');
  // A refused, blocked or CORS-withheld connection is unreachable, not merely busy.
  assert.equal((await failure(run(async () => { throw new TypeError('Failed to fetch'); }))).code, 'unreachable');
});

test('oversized cells fail without reading the whole body', async () => {
  let cancelled = false;
  const stream = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(600)); }, cancel() { cancelled = true; } });
  assert.equal((await failure(run(new Response(stream(), { headers: { 'Content-Length': '5000' } })))).code, 'response_too_large');
  assert.equal(cancelled, true); cancelled = false;
  assert.equal((await failure(run(new Response(stream())))).code, 'response_too_large');
  assert.equal(cancelled, true);
});

test('cancellation and the response deadline are distinguished', async () => {
  const controller = new AbortController();
  const held = (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
  const fetching = fetchCell({ url: 'http://localhost/roads', query, signal: controller.signal, maxBytes: 10, deadline: 5000, idle: 1000, fetch: async (_url, init) => held(init?.signal) });
  controller.abort();
  assert.equal((await failure(fetching)).code, 'cancelled');
  const late = fetchCell({ url: 'http://localhost/roads', query, signal: new AbortController().signal, maxBytes: 10, deadline: 5, idle: 1000, fetch: async (_url, init) => held(init?.signal) });
  const timedOut = await failure(late);
  assert.equal(timedOut.code, 'provider_unavailable'); assert.match(timedOut.message, /in time/);
});

test('remarks are classified, sanitized and Retry-After accepts seconds or dates', () => {
  assert.equal(classifyRemark('runtime error: Query timed out'), 'timeout_or_resource_limit');
  assert.equal(classifyRemark('runtime error: open64: 2 No such file or directory'), 'provider_unavailable');
  assert.equal(sanitizeRemark(`a\nb\u0007${'x'.repeat(500)}`).length, 240);
  assert.equal(sanitizeRemark('a\n\tb'), 'a b');
  assert.equal(retryAfter('12'), 12_000); assert.equal(retryAfter(null), undefined); assert.equal(retryAfter('soon'), undefined);
  assert.equal(retryAfter(new Date(Date.parse('2026-10-01T00:00:30Z')).toUTCString(), Date.parse('2026-10-01T00:00:00Z')), 30_000);
  assert.equal(retryAfter('-5'), 0);
});

test('shared public Overpass instances are recognised so they get one request at a time', () => {
  for (const url of ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) assert.equal(isPublicOverpass(url), true, url);
  for (const url of ['https://overpass.example.com/api/interpreter', 'http://127.0.0.1:8091/roads', 'https://notoverpass-api.de/api', 'not a url']) assert.equal(isPublicOverpass(url), false, url);
});
