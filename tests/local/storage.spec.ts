import { test, expect, sample, live, stats, status, cacheKeys, detail } from '../support/local.ts';

test('registered cell saves drain after closing a session and preserve geometry subviews', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/lib/live/cell-cache.ts', { CellCache } = await import(path);
    const callbacks: IdleRequestCallback[] = [];
    window.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
    const cache = new CellCache(), origin = [139, 35], meta = { fetchedAt: Date.now() };
    const positions = new Float32Array([99, 99, 1, 2, 3, 4, 88, 88]).subarray(2, 6);
    const pending = cache.defer('durable', origin, [positions], meta);
    cache.close();
    const later = await cache.put('after-close', origin, [positions], meta);
    callbacks.forEach(callback => callback({ didTimeout: false, timeRemaining: () => 50 }));
    const saved = await pending;
    const reader = new CellCache(), hit = await reader.get('durable', origin);
    reader.close();
    return { saved, later, positions: hit && [...hit.positions] };
  });
  expect(result).toEqual({ saved: true, later: false, positions: [1, 2, 3, 4] });
});

test('cell freshness misses retain bounded older data and reject invalid or expired records', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/lib/live/cell-cache.ts', { CellCache, CELL_CACHE } = await import(path);
    const now = Date.now(), cache = new CellCache(() => now), origin = [139, 35], positions = new Float32Array([1, 2, 3, 4]);
    const oldAt = now - CELL_CACHE.ttlMs - 1000;
    await cache.put('older', origin, [positions], { fetchedAt: oldAt });
    const fresh = await cache.get('older', origin), fallback = await cache.get('older', origin, true);
    // A later write must not evict older geometry merely because it is not fresh.
    await cache.put('newer', origin, [positions], { fetchedAt: now });
    const retained = await cache.get('older', origin, true);
    await cache.put('expired', origin, [positions], { fetchedAt: now - CELL_CACHE.fallbackAgeMs - 1 });
    await cache.put('future', origin, [positions], { fetchedAt: now + 120_000 });
    const expired = await cache.get('expired', origin, true), future = await cache.get('future', origin, true);
    const freshHit = await cache.get('newer', origin);
    cache.close();
    return { fresh: !!fresh, fallback: fallback && { stale: fallback.stale, fetchedAt: fallback.fetchedAt === oldAt, positions: [...fallback.positions] }, retained: !!retained, expired: !!expired, future: !!future, freshStale: freshHit?.stale };
  });
  expect(result).toEqual({ fresh: false, fallback: { stale: true, fetchedAt: true, positions: [1, 2, 3, 4] }, retained: true, expired: false, future: false, freshStale: false });
});

for (const mode of ['city', 'cells']) test(`clearing ${mode} cache cancels deferred saves, and later loads can cache again`, async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, 'heldSaves', { value: callbacks });
    window.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
  });
  await page.goto(mode === 'city' ? '/' : '/?liveMode=viewport');
  if (mode === 'city') await sample(page); else await live(page, 'Deferred cache');
  const pending = () => page.evaluate(() => (window as unknown as { heldSaves: IdleRequestCallback[] }).heldSaves.length);
  const release = () => page.evaluate(() => {
    const callbacks = (window as unknown as { heldSaves: IdleRequestCallback[] }).heldSaves.splice(0);
    callbacks.forEach(callback => callback({ didTimeout: false, timeRemaining: () => 50 }));
  });
  const keys = mode === 'city' ? () => cacheKeys(page) : () => page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('citymap-cells', 1);
    open.onsuccess = () => {
      const db = open.result, query = db.transaction('cells').objectStore('cells').getAllKeys();
      query.onsuccess = () => { db.close(); resolve(query.result.map(String)); };
      query.onerror = () => { db.close(); reject(query.error); };
    };
    open.onerror = () => reject(open.error);
  }));
  await expect.poll(pending).toBeGreaterThan(0);
  await detail(page, 'Data and source'); await page.getByRole('button', { name: 'Clear city cache' }).click();
  await expect(status(page)).toContainText('Saved city geometry cleared');
  await release(); expect(await keys()).toEqual([]);
  await page.getByRole('button', { name: 'Refresh city data' }).click();
  await expect(status(page)).toContainText('ready'); await expect.poll(pending).toBeGreaterThan(0);
  await release(); await expect.poll(async () => (await keys()).length).toBeGreaterThan(0);
});

test('storage denial and malformed saved JSON do not prevent online rendering', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('citymap:designs:v1', '{'); Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Denied', 'SecurityError'); } }); });
  await page.goto('/'); await sample(page); await expect(page.getByRole('button', { name: 'Save design', exact: true })).toBeEnabled();
});

test('quota errors report save failure while rendering and sharing remain available', async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.goto('/'); await sample(page); await page.getByRole('button', { name: 'Save design', exact: true }).click(); await expect(status(page)).toContainText('Local storage is unavailable');
  await page.getByRole('button', { name: 'Copy share link', exact: true }).click(); await expect(page.getByLabel('Share link')).toHaveValue(/sample=small/);
});

test('corrupt geometry is ignored and downloaded again rather than rendering stale data', async ({ page, request }) => {
  await page.goto('/'); await live(page, 'Corrupt local cache'); await expect.poll(() => cacheKeys(page)).toEqual(['osm-relation-101']);
  await page.evaluate(() => new Promise<void>((resolve, reject) => { const open = indexedDB.open('citymap-geometry', 1); open.onsuccess = () => { const db = open.result, tx = db.transaction('cities', 'readwrite'); tx.objectStore('cities').put({ format: 99, geometry: {} }, 'osm-relation-101'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }));
  await page.goto('/?q=Corrupt+local+cache&areaId=3600000101&osm_type=relation&osm_id=101'); await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect(status(page)).toContainText('ready'); expect((await stats(request)).roads).toHaveLength(2);
});

test('IndexedDB preserves geometry subviews and enforces complete/per-city size limits', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/city-storage.ts', storage = await import(modulePath);
    const backing = new Float32Array([99, 99, 0, 0, 1, 1, 88, 88]), positions = backing.subarray(2, 6);
    const geometry = { buffers: [positions], segmentCount: 1, bounds: { left: -1, bottom: -1, right: 2, top: 2 }, origin: [139.7, 35.6], ranks: [0], coverage: 'all', source: { kind: 'fixture', complete: true, downloadedAt: '2026-10-07T00:00:00.000Z' } };
    const stored = await storage.putCity('subview', geometry), restored = await storage.getCity('subview');
    const incomplete = await storage.putCity('incomplete', { ...geometry, source: { ...geometry.source, complete: false } });
    const oversized = await storage.putCity('oversized', { ...geometry, buffers: [new Float32Array(32 * 1024 * 1024 / 4 + 4)] });
    return { stored, points: restored && [...restored.buffers[0]], incomplete, oversized };
  });
  expect(result).toEqual({ stored: true, points: [0, 0, 1, 1], incomplete: false, oversized: false });
});

test('missing bounds, invalid origin/rank and invalid R2 identity in a format-valid local record are rejected', async ({ page }) => {
  await page.goto('/');
  const accepted = await page.evaluate(async () => {
    const modulePath='/src/lib/city-storage.ts',storage=await import(modulePath);
    const geometry={buffers:[new Float32Array([0,0,1,1]).buffer],segmentCount:1,bounds:{left:-1,right:1,bottom:-1,top:1},origin:[139.7,35.6],ranks:[0],coverage:'all',source:{kind:'fixture',complete:true,downloadedAt:''}};
    await new Promise<void>((resolve,reject) => { const open=indexedDB.open('citymap-geometry',1); open.onupgradeneeded=()=>{open.result.createObjectStore('cities');open.result.createObjectStore('metadata',{keyPath:'key'});};open.onsuccess=()=>{const db=open.result,tx=db.transaction('cities','readwrite'),store=tx.objectStore('cities');store.put({format:3,geometry:{...geometry,bounds:{}}},'missing');store.put({format:3,geometry:{...geometry,source:{...geometry.source,kind:'r2',revision:'bad'}}},'identity');store.put({format:3,geometry:{...geometry,origin:[200,0]}},'origin');store.put({format:3,geometry:{...geometry,ranks:[5]}},'rank');store.put({format:3,geometry},'valid');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);}; });
    return [!!await storage.getCity('missing'),!!await storage.getCity('identity'),!!await storage.getCity('origin'),!!await storage.getCity('rank'),!!await storage.getCity('valid')];
  });
  expect(accepted).toEqual([false,false,false,false,true]);
});

test('LRU eviction removes the oldest geometry and lightweight histories stay bounded', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/lib/city-storage.ts', storage = await import(path);
    const geometry = { buffers: [new Float32Array([0, 0, 1, 1])], segmentCount: 1, bounds: { left: -1, bottom: -1, right: 2, top: 2 }, origin: [139.7, 35.6], ranks: [0], coverage: 'all', source: { kind: 'fixture', complete: true, downloadedAt: '' } };
    await storage.putCity('oldest', geometry); await storage.putCity('newer', geometry);
    // Saturate size metadata to exercise real eviction without allocating 128 MiB.
    await new Promise<void>((resolve, reject) => { const open = indexedDB.open('citymap-geometry', 1); open.onsuccess = () => { const db = open.result, tx = db.transaction('metadata', 'readwrite'); tx.objectStore('metadata').put({ key: 'oldest', bytes: 64 * 1024 * 1024, lastUsed: 1 }); tx.objectStore('metadata').put({ key: 'newer', bytes: 64 * 1024 * 1024, lastUsed: 2 }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
    await storage.putCity('latest', geometry);
    const domainPath = '/src/lib/domain.ts', { DEFAULT_DESIGN } = await import(domainPath);
    for (let i = 0; i < 25; i++) storage.saveDesign({ key: `city-${i}`, name: `City ${i}`, kind: 'test' }, DEFAULT_DESIGN);
    return { oldest: !!await storage.getCity('oldest'), newer: !!await storage.getCity('newer'), latest: !!await storage.getCity('latest'), designs: storage.designs().length };
  });
  expect(result).toEqual({ oldest: false, newer: true, latest: true, designs: 20 });
});
