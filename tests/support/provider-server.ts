import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { providerProxy } from './provider-proxy.ts';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildDataset } from '../../tools/city-data/build.ts';
import { parseCellQuery, syntheticCell } from './live-roads.ts';
// `trickle` streams a Content-Length body in four parts, this many milliseconds apart.
// `dense`: live cell queries wider than this many degrees of longitude time out, as dense areas can.
// `match`: the scenario applies only to road queries containing this text; others succeed.
// `blocked`: refuse without CORS headers, so browsers see a network failure, as with a blocked connection.
// `slotWait`: the Overpass-style status page (/status) says a slot frees in this many seconds; otherwise slots are free.
interface Scenario { status?: number; body?: unknown; delay?: number; hold?: boolean; trickle?: number; failures?: number; retryAfter?: string; dense?: number; match?: string; blocked?: boolean; slotWait?: number }
interface SearchCall { query: string; userAgent?: string; format: string | null; limit: string | null }
let scenarios: { search: Scenario; roads: Scenario } = { search: {}, roads: {} };
const realCity = buildDataset(JSON.parse(gunzipSync(await readFile(new URL('../fixtures/real-city/monaco.json.gz', import.meta.url))).toString('utf8')), 2048);
const dataObjects = new Map(realCity.objects.map(object => [object.key, object]));
let corruptData = false;
// Dataset pointer failure: an HTTP status, or a 404 without CORS headers (a browser network error).
let pointerFailure: number | 'cors' | undefined;
let searches: SearchCall[] = [], roads: string[] = [], aborted = 0, blocked: string[] = [], datasets: string[] = [], statusChecks = 0;
const proxy = providerProxy(['http://127.0.0.1:8082', 'http://127.0.0.1:8091'], target => blocked.push(target));
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:8082');
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    let input = ''; for await (const bytes of req) { input += bytes; if (input.length > 2 * 1024 * 1024) throw new Error('Control input too large'); }
    if (url.pathname === '/health') { res.end('{}'); return; }
    if (url.pathname === '/__reset') { scenarios = { search: {}, roads: {} }; searches = []; roads = []; datasets = []; aborted = 0; blocked = []; statusChecks = 0; corruptData = false; pointerFailure = undefined; res.end('{}'); return; }
    if (url.pathname === '/__control' && req.method === 'POST') { const next = JSON.parse(input); scenarios = { ...scenarios, ...next }; if (typeof next.corruptData === 'boolean') corruptData = next.corruptData; if ('pointerFailure' in next) pointerFailure = next.pointerFailure ?? undefined; res.end('{}'); return; }
    if (url.pathname === '/__stats') { res.end(JSON.stringify({ searches, roads, aborted, blocked, datasets, statusChecks })); return; }
    if (url.pathname === '/status') {
      statusChecks++; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const wait = scenarios.roads.slotWait;
      res.end(`Connected as: 2130706433\nCurrent time: ${new Date().toISOString()}\nRate limit: 2\n${wait ? `Slot available after: ${new Date(Date.now() + wait * 1000).toISOString()}, in ${wait} seconds.\n` : '2 slots available now.\n'}Currently running queries (pid, space limit, time limit, start time):\n`);
      return;
    }
    if (url.pathname.startsWith('/data/')) {
      const key = url.pathname.slice('/data/'.length); datasets.push(key);
      if (pointerFailure && key.endsWith('/latest.json')) {
        if (pointerFailure === 'cors') res.removeHeader('Access-Control-Allow-Origin');
        res.statusCode = pointerFailure === 'cors' ? 404 : pointerFailure; res.end('{}'); return;
      }
      const object = dataObjects.get(key);
      if (!object) { res.statusCode = 404; res.end('{}'); return; }
      let bytes = object.bytes;
      if (corruptData && key.endsWith('.pbf')) { const changed = gunzipSync(bytes); changed[changed.length - 1] ^= 1; bytes = gzipSync(changed); }
      for (const [name,value] of Object.entries(object.headers)) res.setHeader(name,value);
      res.setHeader('Content-Length',bytes.byteLength); res.end(bytes); return;
    }
    const kind = url.pathname === '/search' ? 'search' : url.pathname === '/roads' ? 'roads' : undefined;
    if (!kind) { res.statusCode = 404; res.end('{}'); return; }
    if (kind === 'search') searches.push({ query: url.searchParams.get('q') || '', userAgent: req.headers['user-agent'], format: url.searchParams.get('format'), limit: url.searchParams.get('limit') });
    const query = kind === 'roads' ? new URLSearchParams(input).get('data') || '' : '';
    if (kind === 'roads') roads.push(query);
    // Live viewport cells get synthetic roads for their own box; other road queries the small grid.
    const cell = parseCellQuery(query);
    const applies = !scenarios[kind].match || query.includes(scenarios[kind].match!);
    const scenario = applies ? { ...scenarios[kind] } : {};
    if (applies && scenarios[kind].failures) scenarios[kind].failures = scenarios[kind].failures! - 1;
    if (scenario.delay || scenario.hold) {
      const finished = await new Promise<boolean>(resolve => {
        const timer = scenario.hold ? undefined : setTimeout(() => resolve(true), scenario.delay);
        res.once('close', () => { if (timer) clearTimeout(timer); if (!res.writableEnded) aborted++; resolve(false); });
      });
      if (!finished) return;
    }
    if (scenario.blocked) { res.removeHeader('Access-Control-Allow-Origin'); res.statusCode = 403; res.end('{}'); return; }
    res.statusCode = scenario.failures ? scenario.status || 503 : scenario.status && scenario.failures === undefined ? scenario.status : 200;
    if (scenario.retryAfter) res.setHeader('Retry-After', scenario.retryAfter);
    const normal = kind === 'search' ? [{ osm_type: 'relation', osm_id: '101', display_name: `${url.searchParams.get('q')}, Japan`, type: 'city', boundingbox: ['35', '35.1', '139', '139.1'] }] : cell ? syntheticCell(cell) : JSON.parse(await readFile(new URL('../../public/fixtures/small.json', import.meta.url), 'utf8'));
    if (kind === 'roads' && !cell) normal.osm3s = { timestamp_osm_base: '2026-10-07T00:00:00.000Z' };
    const dense = cell && scenario.dense && cell.box[3] - cell.box[1] > scenario.dense ? { remark: 'runtime error: Query timed out in "query" at line 1 after 30 seconds.' } : undefined;
    const text = typeof scenario.body === 'string' ? scenario.body : JSON.stringify(scenario.body ?? dense ?? normal);
    if (scenario.trickle) {
      const bytes = Buffer.from(text), size = Math.ceil(bytes.length / 4);
      res.setHeader('Content-Length', bytes.length);
      for (let part = 0; part < 4 && !res.destroyed; part++) { res.write(bytes.subarray(part * size, (part + 1) * size)); await new Promise(resolve => setTimeout(resolve, scenario.trickle)); }
      res.end(); return;
    }
    res.end(text);
  } catch { if (!res.destroyed) { res.statusCode = 500; res.end('{"error":"local fixture provider failed"}'); } }
});
server.listen(8091, '127.0.0.1', () => console.log('Local fixture provider: http://127.0.0.1:8091'));
proxy.listen(8092, '127.0.0.1', () => console.log('Local fixture proxy: http://127.0.0.1:8092'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close(() => process.exit(0)); });
