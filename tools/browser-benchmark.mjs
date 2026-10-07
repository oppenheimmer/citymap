import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpus } from 'node:os';
const { values } = parseArgs({ options: { baseline: { type: 'string' }, output: { type: 'string', default: 'docs/benchmarks/20261007-browser.json' }, runs: { type: 'string', default: '3' } } });
if (!values.baseline) throw new Error('Supply --baseline <built Vue artifact from 10584c3>. See docs/benchmarks/README.md.');
const runs = Number(values.runs); if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Runs must be 1–10.');
const baseline = await realpath(values.baseline), modern = await realpath('dist');
const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); const old = url.pathname.startsWith('/baseline/');
    const base = old ? baseline : modern, suffix = decodeURIComponent(url.pathname.slice(old ? 10 : 1));
    const file = await realpath(path.join(base, suffix || 'index.html'));
    if (!file.startsWith(base + path.sep)) throw new Error('Unsafe path');
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--use-gl=angle', `--use-angle=${process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl'}`, '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'] });
const measurements = [];
try {
  for (const size of ['small', 'medium', 'large']) {
    const fixture = await readFile(`public/fixtures/${size}.json`, 'utf8');
    const source = JSON.parse(fixture), segments = source.elements.filter(e => e.type === 'way').reduce((n, e) => n + e.nodes.length - 1, 0);
    for (let iteration = 0; iteration < runs; iteration++) for (const app of iteration % 2 ? ['svelte', 'vue'] : ['vue', 'svelte']) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 });
      const page = await context.newPage(); const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable'); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.addInitScript(() => {
        window.benchmark = { longTasks: [], draws: 0 };
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.benchmark.longTasks.push({ start: performance.timeOrigin + e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
        const draw = WebGLRenderingContext.prototype.drawArrays;
        WebGLRenderingContext.prototype.drawArrays = function(...args) { if (args[0] === this.LINES && args[2] > 0) { window.benchmark.firstDraw ||= performance.timeOrigin + performance.now(); window.benchmark.draws++; } return draw.apply(this, args); };
      });
      let deliveredAt;
      await page.route('**/api/search?**', route => route.fulfill({ json: [] }));
      await page.route('**/data/**', route => route.fulfill({ status: 404 }));
      await page.route(/https:\/\/.*(overpass|interpreter).*/, async route => { deliveredAt = Date.now(); await route.fulfill({ contentType: 'application/json', body: fixture }); });
      const start = Date.now();
      await page.goto(`${origin}/${app === 'vue' ? 'baseline/' : ''}?q=Benchmark&areaId=3600000001&cache=0&auto=1`);
      if (app === 'svelte') await page.getByRole('button', { name: 'Load roads', exact: true }).click();
      await page.waitForFunction(() => window.benchmark.firstDraw, undefined, { timeout: 120000 });
      if (app === 'svelte') await page.getByText('Benchmark ready.', { exact: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => ({ ...window.benchmark, source: performance.getEntriesByType('resource').map(e => ({ name: e.name, decodedBytes: e.decodedBodySize })) }));
      await cdp.send('HeapProfiler.collectGarbage'); const heap = await cdp.send('Runtime.getHeapUsage');
      const stats = { app, size, iteration, fixtureSha256: createHash('sha256').update(fixture).digest('hex'), fixtureBytes: Buffer.byteLength(fixture), segments, firstDrawAfterMockDeliveryMs: result.firstDraw - deliveredAt, navigationToFirstDrawMs: result.firstDraw - start, longTasks: result.longTasks.filter(task => task.start >= deliveredAt), mainHeapAfterGCBytes: heap.usedSize, mainBackingStorageAfterGCBytes: heap.backingStorageSize, javascript: result.source.filter(e => /\.js(?:$|\?)/.test(e.name)) };
      measurements.push(stats); console.log(`${app}/${size}/${iteration + 1}: draw ${stats.firstDrawAfterMockDeliveryMs.toFixed(1)} ms; main heap ${(heap.usedSize / 1048576).toFixed(1)} MiB`);
      await context.close();
    }
  }
  const initialGzip = {};
  for (const [app, base] of [['vue', baseline], ['svelte', modern]]) {
    const html = await readFile(path.join(base, 'index.html'), 'utf8'); const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    const js = await readFile(path.join(base, src.replace(/^\//, ''))); initialGzip[app] = gzipSync(js).byteLength;
  }
  const report = { measuredAt: new Date().toISOString(), browser: browser.version(), node: process.version, platform: process.platform, cpu: cpus()[0].model, viewport: [1000,750], dpr: 1, cpuThrottle: 4, graphics: process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl', baseline: '10584c3', runs, initialGzip, limits: ['Synthetic fixtures and mocked Overpass; timings include browser route delivery and processing, not real provider latency.', 'First draw is the JavaScript drawArrays submission, not measured GPU completion.', 'Heap is main-thread retained memory after GC; worker/peak/native GPU memory is excluded.', 'The baseline canvas occupies the viewport while Svelte reserves its panel; source geometry/segments are identical.', 'CPU throttling and software graphics results do not establish native GPU or mobile-device performance.'], measurements };
  await mkdir(path.dirname(values.output), { recursive: true }); await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
