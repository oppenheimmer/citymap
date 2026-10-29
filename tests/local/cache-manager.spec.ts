import { test, expect, cacheKeys } from '../support/local.ts';
import type { Page } from '@playwright/test';

async function seed(page: Page) {
  await page.evaluate(async () => {
    const cityPath = '/src/lib/city-storage.ts', cellPath = '/src/lib/live/cell-cache.ts';
    const city = await import(cityPath), { CellCache } = await import(cellPath);
    const geometry = { buffers: [new Float32Array([0, 0, 1, 1])], segmentCount: 1, bounds: { left: -1, bottom: -1, right: 2, top: 2 }, origin: [139.7, 35.6], ranks: [0], coverage: 'all', source: { kind: 'fixture', complete: true, downloadedAt: '2026-10-29T00:00:00Z' } };
    await city.putCity('osm-relation-1', geometry, undefined, 'First city');
    await city.putCity('osm-relation-2', geometry, undefined, 'Second city');
    const cells = new CellCache();
    await cells.put('1|1|https://roads.test?secret=hidden|0:11/1818/806', geometry.origin, geometry.buffers, { fetchedAt: Date.now(), label: 'First city' });
    await cells.put('1|1|https://roads.test|1:13/7273/3227', geometry.origin, geometry.buffers, { fetchedAt: Date.now(), label: 'Second city' });
    cells.close();
    localStorage.setItem('citymap:designs:v1', JSON.stringify([{ id: 'keep', name: 'My design', boundary: { key: 'osm-relation-1' }, design: { label: { text: 'Keep me' } } }]));
    localStorage.setItem('citymap-overpass-v1:https://roads.test', JSON.stringify({ until: 9999999999999, reason: 'rate_limited', failures: 3 }));
  });
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Manage cached maps' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cached maps', exact: true });
  await expect(dialog.getByRole('button', { name: 'Clear all local maps', exact: true })).toBeEnabled();
  return dialog;
}

test('cache manager opens before selecting a map and restores keyboard focus', async ({ page }) => {
  await page.goto('/'); const dialog = await open(page);
  await expect(dialog).toContainText('0 city datasets · 0 road fragments');
  await expect(dialog).toContainText('R2 management is not configured');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage cached maps' })).toBeFocused();
});

test('lists city and fragment metadata, filters, and deletes only the selected local record', async ({ page }) => {
  await page.goto('/'); await seed(page); const dialog = await open(page);
  const list = dialog.getByRole('list', { name: 'Local cached maps' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list).toContainText('Major roads · 11/1818/806');
  await expect(list).not.toContainText('hidden');
  await dialog.getByLabel('Filter cached maps').fill('First city');
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await list.getByRole('listitem').filter({ hasText: 'Road fragment' }).getByRole('button', { name: /^Remove local/ }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(dialog).toContainText('2 city datasets · 1 road fragments');
  await list.getByRole('button', { name: /^Remove local/ }).click();
  await expect(dialog).toContainText('No matching cached maps');
  expect(await cacheKeys(page)).toEqual(['osm-relation-2']);
});

test('one-button local clearing preserves saved designs and provider rate limits', async ({ page }) => {
  await page.goto('/'); await seed(page); const dialog = await open(page);
  const before = await page.evaluate(() => ({ designs: localStorage.getItem('citymap:designs:v1'), pacing: localStorage.getItem('citymap-overpass-v1:https://roads.test') }));
  await dialog.getByRole('button', { name: 'Clear all local maps', exact: true }).click();
  await expect(dialog).toContainText('Road fragments cleared. Designs are preserved.');
  await expect(dialog).toContainText('0 city datasets · 0 road fragments');
  expect(await cacheKeys(page)).toEqual([]);
  expect(await page.evaluate(() => ({ designs: localStorage.getItem('citymap:designs:v1'), pacing: localStorage.getItem('citymap-overpass-v1:https://roads.test') }))).toEqual(before);
});

test('clearing in another tab prevents old city/cell saves and stops the old cell session caching new responses', async ({ page, context }) => {
  await page.goto('/'); await seed(page);
  const writer = await context.newPage(); await writer.goto('/');
  await writer.evaluate(async () => {
    const cityPath = '/src/lib/city-storage.ts', cellPath = '/src/lib/live/cell-cache.ts';
    const city = await import(cityPath), cells = await import(cellPath);
    const geometry = await city.getCity('osm-relation-1'), epoch = city.cityCacheEpoch();
    const cache = new cells.CellCache(); let idle: IdleRequestCallback;
    window.requestIdleCallback = callback => { idle = callback; return 1; };
    const pending = cache.defer('pending-cell', geometry.origin, geometry.buffers, { fetchedAt: Date.now() });
    Object.assign(window, { finishOldSaves: async () => {
      idle({ didTimeout: false, timeRemaining: () => 50 });
      return { city: await city.putCity('old-city', geometry, epoch), cell: await pending, laterResponse: await cache.put('later-cell', geometry.origin, geometry.buffers, { fetchedAt: Date.now() }) };
    } });
  });
  const dialog = await open(page); await dialog.getByRole('button', { name: 'Clear all local maps', exact: true }).click();
  await expect(dialog).toContainText('Road fragments cleared. Designs are preserved.');
  const result = await writer.evaluate(() => (window as unknown as { finishOldSaves: () => Promise<unknown> }).finishOldSaves());
  expect(result).toEqual({ city: false, cell: false, laterResponse: false });
  expect(await cacheKeys(page)).toEqual([]);
});

test('partial local storage failure is reported instead of claiming everything cleared', async ({ page }) => {
  await page.addInitScript(() => { const open = IDBFactory.prototype.open; IDBFactory.prototype.open = function(name, version) { if (name === 'citymap-cells') throw new DOMException('Denied', 'SecurityError'); return open.call(this, name, version); }; });
  await page.goto('/'); const dialog = await open(page);
  await expect(dialog).toContainText('One local cache is unavailable');
  await dialog.getByRole('button', { name: 'Clear all local maps', exact: true }).click();
  await expect(dialog).toContainText('One cache is unavailable; retry to finish');
  await expect(dialog).not.toContainText('Road fragments cleared.');
});

test('the durable generation marker blocks an old save even when localStorage is denied', async ({ page, context }) => {
  await page.goto('/'); await seed(page);
  const writer = await context.newPage(); await writer.goto('/');
  await writer.evaluate(async () => {
    const cityPath = '/src/lib/city-storage.ts'; const city = await import(cityPath);
    const geometry = await city.getCity('osm-relation-1'), epoch = city.cityCacheEpoch();
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); }, configurable: true });
    Object.assign(window, { oldSave: () => city.putCity('old-city', geometry, epoch) });
  });
  const dialog = await open(page); await dialog.getByRole('button', { name: 'Clear all local maps', exact: true }).click();
  await expect(dialog).toContainText('Road fragments cleared.');
  expect(await writer.evaluate(() => (window as unknown as { oldSave: () => Promise<boolean> }).oldSave())).toBe(false);
  expect(await cacheKeys(page)).toEqual([]);
});

test('authenticated R2 listing supports city deletion and clears local plus R2 maps with one action', async ({ page }) => {
  const secret = 'browser-only-test-key', requests: { body?: { scope: string; city?: string }; authorization?: string }[] = [];
  let keys = ['v2/cities/osm-relation-1/rev/chunk.gz', 'v2/cities/osm-relation-2/latest.json'];
  await page.route('**/api/cache*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.searchParams.has('status')) { await route.fulfill({ json: { configured: true } }); return; }
    const authorization = req.headers().authorization;
    const body = req.method() === 'POST' ? req.postDataJSON() : undefined;
    requests.push({ authorization, body });
    if (authorization !== `Bearer ${secret}`) { await route.fulfill({ status: 401, json: { error: 'Administrator key required.' } }); return; }
    if (body) keys = body.scope === 'all' ? [] : keys.filter(key => !key.startsWith(`v2/cities/${body.city}/`));
    await route.fulfill({ json: body ? { remaining: false, deleted: 1 } : { objects: keys.map(key => ({ key, bytes: 100, modified: '2026-10-29T00:00:00Z' })) } });
  });
  await page.goto('/'); await seed(page); const dialog = await open(page);
  await dialog.getByLabel('Administrator key').fill('wrong'); await dialog.getByRole('button', { name: 'Connect to R2' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Administrator key required.');
  await dialog.getByLabel('Administrator key').fill(secret); await dialog.getByRole('button', { name: 'Connect to R2' }).click();
  await expect(dialog.getByRole('list', { name: 'R2 cached cities' }).getByRole('listitem')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Remove R2 osm-relation-1', exact: true }).click();
  await expect(dialog).toContainText('City removed from R2. Local copies are unchanged.');
  expect(await cacheKeys(page)).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Clear local and R2 maps', exact: true }).click();
  await expect(dialog).toContainText('Local and R2 map caches cleared.'); expect(keys).toEqual([]); expect(await cacheKeys(page)).toEqual([]);
  expect(requests.some(req => req.body?.scope === 'city' && req.body.city === 'osm-relation-1')).toBe(true);
  expect(requests.some(req => req.body?.scope === 'all')).toBe(true);
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); expect(persisted).not.toContain(secret);
  await dialog.getByRole('button', { name: 'Close cached maps' }).click(); await open(page); await expect(dialog.getByLabel('Administrator key')).toHaveValue('');
});

test('combined clearing reports cloud failure and lets the administrator retry', async ({ page }) => {
  let failed = true, posts = 0;
  await page.route('**/api/cache*', async route => {
    if (new URL(route.request().url()).searchParams.has('status')) { await route.fulfill({ json: { configured: true } }); return; }
    if (route.request().method() === 'POST') { posts++; if (failed) { await route.fulfill({ status: 502, json: { error: 'Some R2 files remain. Retry to finish.' } }); return; } }
    await route.fulfill({ json: { objects: [], remaining: false } });
  });
  await page.goto('/'); await seed(page); const dialog = await open(page);
  await dialog.getByLabel('Administrator key').fill('test-key'); await dialog.getByRole('button', { name: 'Connect to R2' }).click();
  await dialog.getByRole('button', { name: 'Clear local and R2 maps', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Some R2 files remain');
  await expect(dialog).toContainText('Road fragments cleared. Designs are preserved.'); expect(await cacheKeys(page)).toEqual([]);
  failed = false; await dialog.getByRole('button', { name: 'Clear local and R2 maps', exact: true }).click();
  await expect(dialog).toContainText('Local and R2 map caches cleared.'); expect(posts).toBe(2);
});

test('cache manager remains readable and usable on a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 }); await page.goto('/'); await seed(page); const dialog = await open(page);
  const box = await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Clear all local maps', exact: true }).click(); await expect(dialog).toContainText('Road fragments cleared.');
});
