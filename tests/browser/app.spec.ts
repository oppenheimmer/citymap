import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { buildDataset, stableJson, sha256 } from '../../tools/city-data/build.ts';
import { syntheticCity } from '../../tools/city-data/fixtures.ts';
import { manifestKey } from '../../src/lib/data/city-cache.ts';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => { await page.route('**/data/**', route => route.fulfill({ status: 404 })); });

async function sample(page: Page, size = 'Small') {
  await page.getByText('Try a sample map', { exact: true }).click();
  await page.getByRole('button', { name: `${size} sample`, exact: true }).click();
  await expect(page.locator('aside [role=status]')).toContainText('ready');
}

test('render, pan/zoom, colors, Unicode labels and PNG/SVG downloads', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await sample(page);
  await page.getByLabel('Label text', { exact: true }).fill('東京 & <City>');
  await page.getByLabel('Label color', { exact: true }).fill('#235e42');
  await page.getByLabel('Zoom in', { exact: true }).click();
  const map = page.locator('canvas');
  const box = (await map.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 35, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Fit map' }).click();
  const label = page.getByRole('button', { name: 'Move map label with arrow keys or drag' });
  await label.focus(); await page.keyboard.press('ArrowLeft');
  await expect(label).toHaveText('東京 & <City>');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SVG' }).click();
  const svg = await readFile((await (await svgDownload).path())!, 'utf8');
  expect(svg).toContain('東京 &amp; &lt;City&gt;'); expect(svg).toContain('OpenStreetMap contributors'); expect(svg).toContain('<path');
  expect(svg).not.toMatch(/undefined|NaN|Infinity/);
  expect((svg.match(/M[-0-9.]+,/g) || []).length).toBe(512);
  expect(await page.evaluate(source => new DOMParser().parseFromString(source, 'image/svg+xml').querySelector('parsererror')?.textContent, svg)).toBeUndefined();
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  const png = await readFile((await (await pngDownload).path())!);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(Math.round(box.width)); expect(png.readUInt32BE(20)).toBe(Math.round(box.height));
  const pixels = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const sample = ctx.getImageData(Math.floor(canvas.width * 0.3), Math.floor(canvas.height * 0.3), Math.floor(canvas.width * 0.4), Math.floor(canvas.height * 0.4)).data;
    let roads = 0; for (let i = 0; i < sample.length; i += 4) if (sample[i] < 100 && sample[i + 1] < 100 && sample[i + 2] < 100 && sample[i + 3] > 0) roads++;
    return { roads, cornerAlpha: ctx.getImageData(8, 8, 1, 1).data[3] };
  }, [...png]);
  expect(pixels.roads).toBeGreaterThan(500); expect(pixels.cornerAlpha).toBe(255);
  await page.getByLabel('Transparent background', { exact: true }).check();
  const transparentDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PNG' }).click();
  const transparent = await readFile((await (await transparentDownload).path())!);
  expect(await page.evaluate(async bytes => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close(); return ctx.getImageData(8, 8, 1, 1).data[3]; }, [...transparent])).toBe(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(errors).toEqual([]);
});

test('live search, Overpass loading, share restoration and local cache', async ({ page }) => {
  const fixture = await readFile(new URL('../../public/fixtures/small.json', import.meta.url), 'utf8');
  let roadRequests = 0;
  await page.route('**/api/search?**', route => route.fulfill({ json: [{ osm_type: 'relation', osm_id: 123, display_name: 'Test City, Japan', type: 'city', boundingbox: ['35', '35.1', '139', '139.1'] }] }));
  await page.route('https://overpass-api.de/api/interpreter', route => { roadRequests++; return route.fulfill({ contentType: 'application/json', body: fixture }); });
  await page.goto('/');
  await page.getByLabel('Find a city').fill('Test City');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Test City, Japan/ }).click();
  await expect(page.locator('aside [role=status]')).toContainText('ready');
  await page.getByLabel('Label text').fill('Shared city');
  await page.getByRole('button', { name: 'Save design', exact: true }).click();
  await page.getByRole('button', { name: 'Copy share link', exact: true }).click();
  const url = await page.getByLabel('Share link').inputValue();
  await expect.poll(() => page.evaluate(async () => new Promise<number>(resolve => { const req = indexedDB.open('citymap-geometry', 1); req.onsuccess = () => { const count = req.result.transaction('cities').objectStore('cities').count(); count.onsuccess = () => { resolve(count.result); req.result.close(); }; }; }))).toBe(1);
  await page.goto(url);
  await expect(page.locator('aside [role=status]')).toContainText('ready');
  await expect(page.getByLabel('Label text')).toHaveValue('Shared city');
  expect(roadRequests).toBe(1);
  await page.getByText('Data and source', { exact: true }).click();
  await expect(page.locator('aside')).toContainText('Local cache');
});

test('cancellation rejects stale work and repeated switching releases resources', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    const contexts: WebGLRenderingContext[] = [];
    Object.defineProperty(window, 'testContexts', { value: contexts });
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      const context = original.apply(this, args);
      if (args[0] === 'webgl' && context && !contexts.includes(context as WebGLRenderingContext)) contexts.push(context as WebGLRenderingContext);
      return context;
    } as typeof original;
  });
  await page.route('**/fixtures/large.json', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue().catch(() => {}); });
  await page.goto('/');
  await page.getByText('Try a sample map', { exact: true }).click();
  await page.getByRole('button', { name: 'Large sample', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel load' }).click();
  await expect(page.locator('aside [role=status]')).toContainText('cancelled');
  for (let i = 0; i < 8; i++) {
    await page.getByRole('button', { name: 'Small sample', exact: true }).click();
    await expect(page.locator('aside [role=status]')).toContainText('ready');
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { testContexts: WebGLRenderingContext[] }).testContexts.filter(context => !context.isContextLost()).length)).toBe(1);
});

test('no WebGL reports a usable error', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: Parameters<typeof original>) { return args[0].includes('webgl') ? null : original.apply(this, args); } as typeof original;
  });
  await page.goto('/');
  await page.getByText('Try a sample map', { exact: true }).click();
  await page.getByRole('button', { name: 'Small sample', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('WebGL unavailable');
});


function cachedDataset() {
  const input = syntheticCity(4);
  // Deterministic test metadata only; no real-city extraction claim or publication.
  input.metadata.source.kind = 'osm-extract';
  return buildDataset(input, 12);
}
async function routeCache(page: Page, broken?: 'hash' | 'missing-chunk') {
  const dataset = cachedDataset();
  const key = manifestKey(dataset.manifest.city_key, dataset.manifest.dataset_revision);
  const manifest = Buffer.from(stableJson(dataset.manifest) + '\n');
  await page.route('**/data/**', route => {
    const object = new URL(route.request().url()).pathname.slice('/data/'.length);
    if (object.endsWith('/latest.json')) return route.fulfill({ json: { pointer_version: 1, city_key: dataset.manifest.city_key, dataset_revision: dataset.manifest.dataset_revision, manifest: key, manifest_sha256: sha256(manifest) } });
    if (object === key) return route.fulfill({ body: manifest, contentType: 'application/json' });
    const stored = dataset.objects.find(item => item.key === object);
    if (!stored || broken === 'missing-chunk' && object === dataset.manifest.chunks.at(-1)!.key) return route.fulfill({ status: 404 });
    const decoded = gunzipSync(stored.bytes);
    if (broken === 'hash') decoded[0] ^= 1;
    return route.fulfill({ body: decoded, contentType: 'application/x-protobuf' });
  });
  return dataset;
}

test('R2 chunks load completely and share links pin the validated revision', async ({ page }) => {
  const dataset = await routeCache(page);
  await page.goto('/?osm_type=relation&osm_id=1&q=Cached+City&auto=1');
  await expect(page.locator('aside [role=status]')).toContainText('ready');
  await page.getByText('Data and source', { exact: true }).click();
  await expect(page.locator('aside')).toContainText('R2 cache');
  await page.getByRole('button', { name: 'Copy share link', exact: true }).click();
  const link = new URL(await page.getByLabel('Share link').inputValue());
  expect(link.searchParams.get('revision')).toBe(dataset.manifest.dataset_revision);
  expect(link.searchParams.get('manifestHash')).toMatch(/^[a-f0-9]{64}$/);
  await page.getByText('Load timings', { exact: true }).click();
  await expect(page.locator('aside')).toContainText(`${dataset.manifest.segment_count} segments`);
});

for (const failure of ['hash', 'missing-chunk'] as const) test(`R2 ${failure} fails without mixing cached and live roads`, async ({ page }) => {
  await routeCache(page, failure);
  let live = 0;
  await page.route('https://overpass-api.de/api/interpreter', route => { live++; return route.abort(); });
  await page.goto('/?osm_type=relation&osm_id=1&q=Broken+Cache&auto=1');
  await expect(page.getByRole('alert')).toContainText(failure === 'hash' ? 'checksum' : '404');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  expect(live).toBe(0);
  await expect(page.locator('canvas')).toHaveCount(0);
});


test.describe('touch layout and unavailable local storage', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: process.env.PLAYWRIGHT_BROWSER !== 'firefox' });
  test('sample rendering and customization survive storage denial on a narrow screen', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Denied', 'SecurityError'); } });
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } });
    });
    await page.goto('/'); await sample(page);
    await page.getByLabel('Label text', { exact: true }).fill('Mobile city');
    await expect(page.getByRole('button', { name: 'Move map label with arrow keys or drag' })).toHaveText('Mobile city');
    await page.getByRole('button', { name: 'Save design', exact: true }).click();
    await expect(page.locator('aside [role=status]')).toContainText('Local storage is unavailable');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('canvas')).toBeVisible();
  });
});

test('the bundled city loads from data shipped in the production build, without the road service', async ({ page }) => {
  await page.unroute('**/data/**');
  let live = 0; await page.route('https://overpass-api.de/api/interpreter', route => { live++; return route.abort(); });
  await page.goto('/?q=Monaco&osm_type=relation&osm_id=1124039&auto=1');
  await expect(page.locator('aside [role=status]')).toContainText('Monaco ready', { timeout: 15_000 });
  expect(live).toBe(0);
});
