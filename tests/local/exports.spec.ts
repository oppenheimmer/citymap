import { readFile } from 'node:fs/promises';
import { test, expect, sample, slider, label } from '../support/local.ts';
import type { Page } from '@playwright/test';
async function download(page: Page, format: 'PNG' | 'SVG') { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: `Download ${format}`, exact: true }).click(); const file = await pending; return { bytes: await readFile((await file.path())!), filename: file.suggestedFilename() }; }

test('PNG and SVG preserve dimensions, visible roads, Unicode, palette, transparency and attribution', async ({ page }, testInfo) => {
  await page.goto('/'); await sample(page); await page.getByLabel('Label text').fill('東京 & <City>: map'); await page.getByLabel('Road color').fill('#125634'); await slider(page, 'Road opacity', 0.5);
  await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByLabel('Width in pixels').fill('800'); await page.getByLabel('Height in pixels').fill('600');
  const svg = await download(page, 'SVG'); expect(svg.filename).not.toContain(':');
  const xml = svg.bytes.toString('utf8'); expect(xml).toContain('東京 &amp; &lt;City&gt;: map'); expect(xml).toContain('stroke="#125634"'); expect(xml).toContain('stroke-opacity="0.5"'); expect(xml).toContain('OpenStreetMap contributors'); expect((xml.match(/M[-0-9.]+,/g) || []).length).toBe(512);
  const parsed = await page.evaluate(source => { const doc = new DOMParser().parseFromString(source, 'image/svg+xml'); return { width: doc.documentElement.getAttribute('width'), height: doc.documentElement.getAttribute('height'), invalid: !!doc.querySelector('parsererror') }; }, xml); expect(parsed).toEqual({ width: '800', height: '600', invalid: false });
  const png = await download(page, 'PNG'); expect([...png.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect(png.bytes.readUInt32BE(16)).toBe(800); expect(png.bytes.readUInt32BE(20)).toBe(600);
  await testInfo.attach('map.png', { body: png.bytes, contentType: 'image/png' });
  await testInfo.attach('map.svg', { body: svg.bytes, contentType: 'image/svg+xml' });
  const pixels = async (bytes: Buffer) => page.evaluate(async data => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' })); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close(); const sample = ctx.getImageData(250, 200, 300, 200).data; let roads = 0; for (let i = 0; i < sample.length; i += 4) if (sample[i + 1] < 200 && sample[i] < 200 && sample[i + 3] > 0) roads++; return { roads, corner: ctx.getImageData(8, 8, 1, 1).data[3], border: [...ctx.getImageData(1, 1, 1, 1).data] }; }, [...bytes]);
  expect((await pixels(png.bytes)).roads).toBeGreaterThan(500); expect((await pixels(png.bytes)).corner).toBe(255);
  // A 3 px border in the road colour at full opacity frames every export.
  expect((await pixels(png.bytes)).border).toEqual([0x12, 0x56, 0x34, 255]); expect(xml).toContain('stroke="#125634" stroke-width="3"/>');
  await page.getByLabel('Transparent background', { exact: true }).check(); expect((await pixels((await download(page, 'PNG')).bytes)).corner).toBe(0); expect((await download(page, 'SVG')).bytes.toString()).not.toContain('<rect width="100%"');
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(label(page)).toHaveText('東京 & <City>: map');
});

for (const [width, height] of [['0', '600'], ['800', 'NaN'], ['8193', '600'], ['4097', '4096'], ['800.5', '600']]) test(`export rejects invalid ${width}×${height} and accepts corrected dimensions`, async ({ page }) => {
  await page.goto('/'); await sample(page); await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByLabel('Width in pixels').fill(width); await page.getByLabel('Height in pixels').fill(height === 'NaN' ? '' : height);
  await page.getByRole('button', { name: 'Download SVG', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Export dimensions');
  await page.getByLabel('Width in pixels').fill('512'); await page.getByLabel('Height in pixels').fill('512'); expect((await download(page, 'SVG')).bytes.toString()).toContain('width="512"');
});

test('export cancellation terminates background work and permits another export', async ({ page }) => {
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage, terminate = Worker.prototype.terminate;
    const probe = { held: false, terminated: 0 };
    Object.defineProperty(window, 'exportProbe', { value: probe });
    Worker.prototype.postMessage = function(this: Worker, ...args: Parameters<typeof send>) {
      if ((args[0] as { type?: string })?.type === 'finish' && !probe.held) { probe.held = true; return; }
      send.apply(this, args);
    } as typeof send;
    Worker.prototype.terminate = function(this: Worker) { probe.terminated++; terminate.call(this); };
  });
  await page.goto('/'); await sample(page); await page.getByRole('button', { name: 'Export', exact: true }).click(); const files: string[] = []; page.on('download', file => files.push(file.suggestedFilename()));
  const probe = () => page.evaluate(() => (window as unknown as { exportProbe: { held: boolean; terminated: number } }).exportProbe);
  const before = (await probe()).terminated;
  await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
  await expect.poll(async () => (await probe()).held).toBe(true);
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(async () => (await probe()).terminated).toBe(before + 1);
  await page.getByRole('button', { name: 'Export', exact: true }).click(); expect((await download(page, 'SVG')).bytes.toString()).toContain('<svg'); expect(files).toHaveLength(1);
});

test('PNG encoding failure reports an error without downloading an empty file', async ({ page }) => {
  await page.addInitScript(() => { HTMLCanvasElement.prototype.toBlob = callback => callback(null); });
  const files: string[] = []; page.on('download', file => files.push(file.suggestedFilename()));
  await page.goto('/'); await sample(page); await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('PNG export failed');
  expect(files).toEqual([]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
});

test('PNG canvas failure and font loading failure are visible without losing the map', async ({ page }) => {
  await page.addInitScript(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: Parameters<typeof get>) { return args[0] === '2d' ? null : get.apply(this, args); } as typeof get; });
  await page.goto('/'); await sample(page); await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByRole('button', { name: 'Download PNG', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Canvas export');
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.locator('canvas')).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document.fonts, 'ready', { get() { return Promise.reject(new Error('Test fonts unavailable')); } }); });
  await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByRole('button', { name: 'Download SVG', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Test fonts unavailable');
});
