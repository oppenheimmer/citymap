import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpus } from 'node:os';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: '.benchmarks/browser.json' },
  runs: { type: 'string', default: '3' }, sizes: { type: 'string', default: 'small' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('benchmark:browser [--runs 1..10] [--sizes small,medium,large] [--output .benchmarks/browser.json]\nUses the current dist build and an already installed Chromium; never downloads browsers.');
  process.exit(0);
}
const runs = Number(values.runs), sizes = values.sizes.split(',');
if (!Number.isInteger(runs) || runs < 1 || runs > 10 || !sizes.length || new Set(sizes).size !== sizes.length || sizes.some(size => !['small', 'medium', 'large'].includes(size))) throw new Error('Use 1–10 runs and unique small/medium/large sizes.');
const root = await realpath('dist');
const fixtures = await Promise.all(sizes.map(async size => ({ size, text: await readFile(`public/fixtures/${size}.json`, 'utf8') })));
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const entry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
if (!entry) throw new Error('Build the app before benchmarking.');
const initialGzipBytes = gzipSync(await readFile(path.join(root, entry.replace(/^\//, '')))).byteLength;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = await realpath(path.join(root, decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html'));
    if (!file.startsWith(root + path.sep)) throw new Error('Unsafe path');
    res.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--use-gl=angle', `--use-angle=${process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl'}`, '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'] });
  const measurements = [];
  for (const { size, text } of fixtures) {
    const segments = JSON.parse(text).elements.filter(e => e.type === 'way').reduce((n, e) => n + e.nodes.length - 1, 0);
    for (let iteration = 0; iteration < runs; iteration++) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.addInitScript(() => {
          window.benchmark = { longTasks: [] };
          new PerformanceObserver(list => { for (const task of list.getEntries()) window.benchmark.longTasks.push({ start: performance.timeOrigin + task.startTime, duration: task.duration }); }).observe({ type: 'longtask', buffered: true });
          const draw = WebGLRenderingContext.prototype.drawArrays;
          WebGLRenderingContext.prototype.drawArrays = function(...args) { if (args[0] === this.LINES && args[2] > 0) window.benchmark.firstDraw ||= performance.timeOrigin + performance.now(); return draw.apply(this, args); };
        });
        let deliveredAt;
        await page.route('**/api/search?**', route => route.fulfill({ json: [] }));
        await page.route('**/data/**', route => route.fulfill({ status: 404 }));
        await page.route(/https:\/\/.*(overpass|interpreter).*/, async route => { deliveredAt = Date.now(); await route.fulfill({ contentType: 'application/json', body: text }); });
        await page.goto(`${origin}/?q=Benchmark&areaId=3600000001&cache=0&auto=1`);
        await page.getByRole('button', { name: 'Load roads', exact: true }).click();
        await page.waitForFunction(() => window.benchmark.firstDraw, undefined, { timeout: 120000 });
        await page.getByText('Benchmark ready.', { exact: true }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await page.evaluate(() => window.benchmark);
        if (!deliveredAt) throw new Error('The mocked road request was not observed.');
        await cdp.send('HeapProfiler.collectGarbage'); const heap = await cdp.send('Runtime.getHeapUsage');
        measurements.push({ size, iteration, segments, fixtureSha256: createHash('sha256').update(text).digest('hex'), fixtureBytes: Buffer.byteLength(text), firstDrawAfterMockDeliveryMs: result.firstDraw - deliveredAt, longTasks: result.longTasks.filter(task => task.start >= deliveredAt), mainHeapAfterGCBytes: heap.usedSize, mainBackingStorageAfterGCBytes: heap.backingStorageSize });
        console.log(`${size}/${iteration + 1}: draw ${(result.firstDraw - deliveredAt).toFixed(1)} ms`);
      } finally { await context.close(); }
    }
  }
  const report = { measuredAt: new Date().toISOString(), browser: browser.version(), node: process.version, platform: process.platform, cpu: cpus()[0].model, viewport: [1000, 750], dpr: 1, cpuThrottle: 4, graphics: process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl', runs, initialGzipBytes, limits: ['Synthetic fixtures and mocked delivery; excludes real provider latency.', 'First draw measures JavaScript submission, not GPU completion.', 'Main-thread memory after GC excludes peak, worker and GPU memory.', 'Software graphics and CDP CPU throttling do not establish physical-device performance.'], measurements };
  await mkdir(path.dirname(values.output), { recursive: true }); await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
} finally { await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
