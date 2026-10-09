import { test, expect, sample, live, stats, status, cacheKeys } from '../support/local.ts';

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
