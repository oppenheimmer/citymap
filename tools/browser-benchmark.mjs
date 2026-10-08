import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpus } from 'node:os';
import { memoryTracker } from './browser-memory.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: '.benchmarks/browser.json' },
  runs: { type: 'string', default: '3' }, sizes: { type: 'string', default: 'small' }, help: { type: 'boolean' },
  switches: { type: 'string', default: '0' },
  profile: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('benchmark:browser [--runs 1..10] [--sizes small,medium,large] [--switches 0..20] [--profile] [--output .benchmarks/browser.json]\nUses the current dist build and an already installed Chromium; never downloads browsers.');
  process.exit(0);
}
const runs = Number(values.runs), sizes = values.sizes.split(','), switches=Number(values.switches);
if (!Number.isInteger(switches)||switches<0||switches>20) throw new Error('Use 0–20 cleanup switches.');
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
let browser, browserServer;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browserServer = await chromium.launchServer({ channel: 'chromium', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--use-gl=angle', `--use-angle=${process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl'}`, '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'] });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const measurements = [];
  for (const { size, text } of fixtures) {
    const segments = JSON.parse(text).elements.filter(e => e.type === 'way').reduce((n, e) => n + e.nodes.length - 1, 0);
    for (let iteration = 0; iteration < runs; iteration++) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 });
      const memory = await memoryTracker(browser, browserServer.process().pid);
      let memoryResult;
      try {
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.addInitScript(() => {
          window.benchmark = { longTasks: [], uploads: [], glCalls: [], contextCreationMs: [], heartbeatDelays: [], inputEvents: [], workers: 0, contexts: 0 };
          const bench = window.benchmark;
          const WorkerClass = window.Worker;
          window.Worker = class extends WorkerClass {
            constructor(...args) { super(...args); bench.workers++; this.addEventListener('message', event => { if (event.data.type === 'done') bench.preparation = event.data.preparation; }); }
            terminate() { bench.workers--; super.terminate(); }
          };
          const context = HTMLCanvasElement.prototype.getContext;
          const seen = new WeakSet();
          HTMLCanvasElement.prototype.getContext = function(...args) {
            const start = performance.now(), result = context.apply(this, args);
            if (args[0] === 'webgl' && result && !seen.has(result)) { seen.add(result); bench.contextCreationMs.push(performance.now()-start); bench.contexts++; this.addEventListener('webglcontextlost',()=>bench.contexts--,{once:true}); }
            return result;
          };
          const upload = WebGLRenderingContext.prototype.bufferData;
          WebGLRenderingContext.prototype.bufferData = function(...args) { const start=performance.now();const result=upload.apply(this,args);bench.uploads.push({bytes:args[1]?.byteLength || 0,durationMs:performance.now()-start});return result; };
          for (const method of ['compileShader','linkProgram','getShaderParameter','getProgramParameter','drawArrays']) {
            const original=WebGLRenderingContext.prototype[method];
            WebGLRenderingContext.prototype[method]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{bench.glCalls.push({method,start:performance.timeOrigin+start,durationMs:performance.now()-start});}};
          }
          let previous=performance.now();setInterval(()=>{const now=performance.now();bench.heartbeatDelays.push({at:performance.timeOrigin+now,delayMs:Math.max(0,now-previous-8)});previous=now;},8);
          document.addEventListener('input',event=>{if(event.isTrusted&&event.target.id==='label'){const sample={eventStartAt:performance.timeOrigin+event.timeStamp,eventAt:performance.timeOrigin+performance.now(),activeWorkers:bench.workers};bench.inputEvents.push(sample);requestAnimationFrame(()=>{sample.paintAt=performance.timeOrigin+performance.now();});}},true);
          document.addEventListener('click',event=>{if(event.isTrusted&&event.target.closest('button')?.textContent==='Cancel load'){const sample={eventStartAt:performance.timeOrigin+event.timeStamp,activeWorkers:bench.workers};bench.cancellation=sample;requestAnimationFrame(()=>{sample.paintAt=performance.timeOrigin+performance.now();sample.feedback=document.querySelector('[role="status"]')?.textContent;});}},true);
          new PerformanceObserver(list => { for (const task of list.getEntries()) window.benchmark.longTasks.push({ start: performance.timeOrigin + task.startTime, duration: task.duration }); }).observe({ type: 'longtask', buffered: true });
          const draw = WebGLRenderingContext.prototype.drawArrays;
          WebGLRenderingContext.prototype.drawArrays = function(...args) { if (args[0] === this.LINES && args[2] > 0) window.benchmark.firstDraw ||= performance.timeOrigin + performance.now(); return draw.apply(this, args); };
        });
        let deliveredAt;
        await page.route('**/api/search?**', route => route.fulfill({ json: [] }));
        await page.route('**/data/**', route => route.fulfill({ status: 404 }));
        await page.route(/https:\/\/.*(overpass|interpreter).*/, async route => { deliveredAt = Date.now(); await route.fulfill({ contentType: 'application/json', body: text }); });
        await page.goto(`${origin}/?q=Benchmark&areaId=3600000001&cache=0&auto=1`);
        if (values.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval',{interval:1000}); await cdp.send('Profiler.start'); }
        await page.getByRole('button', { name: 'Load roads', exact: true }).click();
        await page.locator('#label').focus();
        const inputSubmittedAt=Date.now();
        await cdp.send('Input.insertText',{text:' input probe'});
        await page.waitForFunction(()=>window.benchmark.inputEvents.some(event=>event.paintAt));
        await page.waitForFunction(() => window.benchmark.firstDraw, undefined, { timeout: 120000 });
        await page.getByText('Benchmark ready.', { exact: true }).waitFor();
        const completeAt = Date.now();
        let cpuProfile;
        if (values.profile) {
          const {profile}=await cdp.send('Profiler.stop'),selfTimes=new Map();
          for (let index=0;index<profile.samples.length;index++) { const id=profile.samples[index];selfTimes.set(id,(selfTimes.get(id)||0)+profile.timeDeltas[index]/1000); }
          cpuProfile=profile.nodes.map(node=>({...node.callFrame,selfMs:selfTimes.get(node.id)||0})).sort((a,b)=>b.selfMs-a.selfMs).slice(0,20);
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const result = await page.evaluate(() => window.benchmark);
        if (!deliveredAt) throw new Error('The mocked road request was not observed.');
        await cdp.send('HeapProfiler.collectGarbage'); const heap = await cdp.send('Runtime.getHeapUsage');
        memoryResult = await memory.finish();
        const cleanup=[];
        if (switches) {
          await page.getByText('Try a sample map',{exact:true}).click();
          for (let index=0;index<switches;index++) {
            await page.getByRole('button',{name:'Small sample',exact:true}).click();
            await page.getByText('Small synthetic grid ready.',{exact:true}).waitFor();
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            const listeners={};
            for (const expression of ['window','document']) {
              const {result:object}=await cdp.send('Runtime.evaluate',{expression,objectGroup:'cleanup'});
              const result=await cdp.send('DOMDebugger.getEventListeners',{objectId:object.objectId});
              listeners[expression]=result.listeners.reduce((types,listener)=>{types[listener.type]=(types[listener.type]||0)+1;return types;},{});
            }
            await cdp.send('Runtime.releaseObjectGroup',{objectGroup:'cleanup'});
            await page.evaluate(()=>{const b=window.benchmark;b.longTasks=[];b.uploads=[];b.glCalls=[];b.heartbeatDelays=[];b.contextCreationMs=[];b.inputEvents=[];performance.clearResourceTimings();});
            await cdp.send('HeapProfiler.collectGarbage');
            const usage=await cdp.send('Runtime.getHeapUsage'),resources=await page.evaluate(()=>({workers:window.benchmark.workers,contexts:window.benchmark.contexts}));
            cleanup.push({index,...usage,...resources,listeners});
          }
        }
        if (!await page.getByRole('button',{name:'Large sample',exact:true}).isVisible()) await page.getByText('Try a sample map',{exact:true}).click();
        await page.getByRole('button',{name:'Large sample',exact:true}).click();
        await page.waitForFunction(()=>window.benchmark.workers>0);
        await page.getByRole('button',{name:'Cancel load',exact:true}).click();
        await page.waitForFunction(()=>window.benchmark.cancellation?.paintAt);
        const cancellation=await page.evaluate(()=>window.benchmark.cancellation);
        if (!cancellation.feedback?.includes('cancelled')) throw new Error('Cancellation feedback was not painted.');
        measurements.push({ size, iteration, segments, fixtureSha256: createHash('sha256').update(text).digest('hex'), fixtureBytes: Buffer.byteLength(text), firstDrawAfterMockDeliveryMs: result.firstDraw - deliveredAt, completeAfterMockDeliveryMs: completeAt-deliveredAt, preparation:result.preparation, contextCreationMs:result.contextCreationMs, uploads:result.uploads, glCalls:result.glCalls, cpuProfile, trustedInput:result.inputEvents.map(event=>({...event,submitToPaintMs:event.paintAt-inputSubmittedAt,rendererEventToPaintMs:event.paintAt-event.eventStartAt})), cancellation:{...cancellation,rendererEventToPaintMs:cancellation.paintAt-cancellation.eventStartAt}, heartbeatMaxDelayMs:Math.max(0,...result.heartbeatDelays.filter(sample=>sample.at>=deliveredAt&&sample.at<=completeAt).map(sample=>sample.delayMs)), liveWorkers:result.workers, liveContexts:result.contexts, cleanup, memory:memoryResult, longTasks: result.longTasks.filter(task => task.start >= deliveredAt), mainHeapAfterGCBytes: heap.usedSize, mainBackingStorageAfterGCBytes: heap.backingStorageSize });
        console.log(`${size}/${iteration + 1}: draw ${(result.firstDraw - deliveredAt).toFixed(1)} ms`);
      } finally { if (!memoryResult) await memory.finish(); await context.close(); }
    }
  }
  const report = { measuredAt: new Date().toISOString(), browser: browser.version(), node: process.version, platform: process.platform, cpu: cpus()[0].model, viewport: [1000, 750], dpr: 1, cpuThrottle: 4, cpuProfiling:values.profile, graphics: process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl', runs, initialGzipBytes, limits: ['Synthetic fixtures and mocked delivery; excludes real provider latency.', 'First draw measures JavaScript submission, not GPU completion; complete waits for the ready status.', 'Worker peaks are sampled through CDP; brief allocations can be missed. Process VmHWM includes native/runtime memory; GPU process RSS is not VRAM.', 'Heartbeat delay measures main-thread timer scheduling, not physical input latency. Initialization is included.', 'Phase download times include response/body waits; parallel sums overlap, and hashing/transport overhead is outside CPU phase totals.', 'Software graphics and main-thread CDP CPU throttling do not establish physical-device or equally throttled-worker performance.'], measurements };
  await mkdir(path.dirname(values.output), { recursive: true }); await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
} finally { await browser?.close(); await browserServer?.close(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
