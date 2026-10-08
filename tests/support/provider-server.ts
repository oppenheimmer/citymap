import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
interface Scenario { status?: number; body?: unknown; delay?: number; failures?: number; retryAfter?: string }
interface SearchCall { query: string; userAgent?: string; format: string | null; limit: string | null }
let scenarios: { search: Scenario; roads: Scenario } = { search: {}, roads: {} };
let searches: SearchCall[] = [], roads: string[] = [], aborted = 0;
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:8082');
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    let input = ''; for await (const bytes of req) { input += bytes; if (input.length > 2 * 1024 * 1024) throw new Error('Control input too large'); }
    if (url.pathname === '/health') { res.end('{}'); return; }
    if (url.pathname === '/__reset') { scenarios = { search: {}, roads: {} }; searches = []; roads = []; aborted = 0; res.end('{}'); return; }
    if (url.pathname === '/__control' && req.method === 'POST') { scenarios = { ...scenarios, ...JSON.parse(input) }; res.end('{}'); return; }
    if (url.pathname === '/__stats') { res.end(JSON.stringify({ searches, roads, aborted })); return; }
    const kind = url.pathname === '/search' ? 'search' : url.pathname === '/roads' ? 'roads' : undefined;
    if (!kind) { res.statusCode = 404; res.end('{}'); return; }
    if (kind === 'search') searches.push({ query: url.searchParams.get('q') || '', userAgent: req.headers['user-agent'], format: url.searchParams.get('format'), limit: url.searchParams.get('limit') });
    else roads.push(new URLSearchParams(input).get('data') || '');
    const scenario = { ...scenarios[kind] };
    if (scenarios[kind].failures) scenarios[kind].failures = scenarios[kind].failures! - 1;
    if (scenario.delay) {
      const finished = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(true), scenario.delay);
        res.once('close', () => { clearTimeout(timer); if (!res.writableEnded) aborted++; resolve(false); });
      });
      if (!finished) return;
    }
    res.statusCode = scenario.failures ? scenario.status || 503 : scenario.status && scenario.failures === undefined ? scenario.status : 200;
    if (scenario.retryAfter) res.setHeader('Retry-After', scenario.retryAfter);
    const normal = kind === 'search' ? [{ osm_type: 'relation', osm_id: '101', display_name: `${url.searchParams.get('q')}, Japan`, type: 'city', boundingbox: ['35', '35.1', '139', '139.1'] }] : JSON.parse(await readFile(new URL('../../public/fixtures/small.json', import.meta.url), 'utf8'));
    if (kind === 'roads') normal.osm3s = { timestamp_osm_base: '2026-10-07T00:00:00.000Z' };
    res.end(typeof scenario.body === 'string' ? scenario.body : JSON.stringify(scenario.body ?? normal));
  } catch { if (!res.destroyed) { res.statusCode = 500; res.end('{"error":"local fixture provider failed"}'); } }
});
server.listen(8091, '127.0.0.1', () => console.log('Local fixture provider: http://127.0.0.1:8091'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
