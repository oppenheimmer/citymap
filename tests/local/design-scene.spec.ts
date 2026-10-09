import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, sample, live, detail, label, slider, share, status, cacheKeys, stats, control } from '../support/local.ts';

test('presets, all colors/opacity and label settings are reflected in DOM and a complete share link', async ({ page }) => {
  await page.goto('/'); await sample(page);
  for (const [name, roads, background] of [['Night', '#e1e7d9', '#152737'], ['Moss', '#356047', '#edf1e7'], ['Plum', '#e4d8c7', '#302a3b'], ['Paper', '#1a1a1a', '#f7f2e8']]) {
    await page.getByRole('button', { name, exact: true }).click(); await expect(page.getByLabel('Road color')).toHaveValue(roads); await expect(page.getByLabel('Background color')).toHaveValue(background);
  }
  await page.getByLabel('Road color').fill('#123456'); await page.getByLabel('Background color').fill('#abcdef'); await page.getByLabel('Label color').fill('#234567'); await page.getByLabel('Label text').fill('東京 & <Map>');
  await slider(page, 'Road opacity', 0.25); await slider(page, 'Background opacity', 0.5); await slider(page, 'Label opacity', 0.35); await slider(page, 'Label size', 48);
  await expect(label(page)).toHaveCSS('font-size', '48px'); await expect(label(page)).toHaveCSS('opacity', '0.35');
  const link = await share(page); expect(link.searchParams.get('roads')).toBe('123456'); expect(link.searchParams.get('background')).toBe('abcdef'); expect(link.searchParams.get('roadOpacity')).toBe('0.25');
  await page.goto(link.href); await expect(status(page)).toContainText('ready'); await expect(label(page)).toHaveText('東京 & <Map>'); await expect(label(page)).toHaveCSS('font-size', '48px'); await expect(page.getByLabel('Background opacity')).toHaveValue('0.5');
});

test('label pointer dragging, fine/coarse arrows and edge clamps affect normalized position', async ({ page }) => {
  await page.goto('/'); await sample(page);
  const box = (await label(page).boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(570, 400, { steps: 6 }); await page.mouse.up();
  const dragged = await share(page); expect(Number(dragged.searchParams.get('labelX'))).toBeLessThan(0.75);
  await label(page).focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); const moved = await share(page);
  expect(Number(moved.searchParams.get('labelX'))).toBeCloseTo(Number(dragged.searchParams.get('labelX')) + 0.01, 4);
  expect(Number(moved.searchParams.get('labelY'))).toBeCloseTo(Number(dragged.searchParams.get('labelY')) + 0.05, 4);
  await label(page).focus(); for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+ArrowLeft'); expect(Number((await share(page)).searchParams.get('labelX'))).toBe(0.05);
});

const view = async (page: Page) => (await share(page)).searchParams.get('view')!.split(',').map(Number);
test('zoom, pan, fit and resize keep view links finite and restore the view', async ({ page }) => {
  await page.goto('/'); await sample(page); const initial = await view(page);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect.poll(async () => (await view(page))[2]).toBeLessThan(initial[2]); const zoomed = await view(page);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(async () => (await view(page))[2]).toBeCloseTo(initial[2], 1);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const map = (await page.locator('canvas').boundingBox())!; await page.mouse.move(map.x + map.width / 2, 250); await page.mouse.down(); await page.mouse.move(map.x + map.width / 2 + 60, 290, { steps: 8 }); await page.mouse.up();
  expect((await view(page)).join(',')).not.toBe(zoomed.join(','));
  await page.getByRole('button', { name: 'Fit map', exact: true }).click(); expect((await view(page))[2]).toBeCloseTo(initial[2], 1);
  await page.setViewportSize({ width: 1200, height: 800 }); await expect(page.locator('canvas')).toHaveJSProperty('width', 880);
  const link = await share(page), expected = link.searchParams.get('view')!.split(',').map(Number);
  expect(expected.every(Number.isFinite)).toBe(true); await page.goto(link.href); await expect(status(page)).toContainText('ready');
  const restored = await view(page);
  restored.forEach((value, index) => expect(value).toBeCloseTo(expected[index], index < 2 ? 5 : 1));
});

test('a shared view reopens the same place after the road data extent changes', async ({ page, request }) => {
  await page.goto('/'); await live(page, 'Moving extent');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const link = await share(page), expected = link.searchParams.get('view')!.split(',').map(Number);
  // Live OSM edits can extend a city's road extent, which moves the projection origin.
  const roads = JSON.parse(await readFile(new URL('../../public/fixtures/small.json', import.meta.url), 'utf8'));
  roads.elements.push({ type: 'node', id: '900001', lon: -122.405, lat: 37.775 }, { type: 'node', id: '900002', lon: -122.398, lat: 37.781 }, { type: 'way', id: '900003', nodes: ['900001', '900002'], tags: { highway: 'primary' } });
  await control(request, { roads: { body: roads } }); await detail(page, 'Data and source'); await page.getByRole('button', { name: 'Clear city cache' }).click();
  await page.goto(link.href); await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect(status(page)).toContainText('ready');
  expect((await stats(request)).roads).toHaveLength(2);
  const restored = await view(page);
  restored.forEach((value, index) => expect(value).toBeCloseTo(expected[index], index < 2 ? 5 : 1));
});

test('saved designs restore settings after reload, can be deleted, and recent cities reopen', async ({ page }) => {
  await page.goto('/'); await sample(page); await page.getByLabel('Label text').fill('Saved 東京'); await page.getByRole('button', { name: 'Night', exact: true }).click(); await page.getByRole('button', { name: 'Save design', exact: true }).click();
  await page.goto('/'); await detail(page, 'Saved designs'); await page.getByRole('button', { name: 'Saved 東京', exact: true }).click(); await expect(status(page)).toContainText('ready'); await expect(page.getByLabel('Road color')).toHaveValue('#e1e7d9');
  await page.getByRole('button', { name: 'Delete design Saved 東京' }).click(); await expect(page.getByText('Saved designs', { exact: true })).toHaveCount(0);
  await detail(page, 'Recent cities'); await page.getByRole('button', { name: 'Small synthetic grid', exact: true }).click(); await expect(status(page)).toContainText('ready');
});

test('local cache avoids roads, refresh bypasses it and clearing preserves designs', async ({ page, request }) => {
  await page.goto('/'); await live(page, 'Cache lifecycle'); await expect.poll(() => cacheKeys(page)).toEqual(['osm-relation-101']);
  await page.getByRole('button', { name: 'Save design', exact: true }).click(); const link = await share(page); await page.goto(link.href); await expect(status(page)).toContainText('ready'); expect((await stats(request)).roads).toHaveLength(1);
  await detail(page, 'Data and source'); await expect(page.locator('aside')).toContainText('Local cache'); await page.getByRole('button', { name: 'Refresh city data' }).click(); await expect(status(page)).toContainText('ready'); expect((await stats(request)).roads).toHaveLength(2);
  await page.getByRole('button', { name: 'Clear city cache' }).click(); await expect.poll(() => cacheKeys(page)).toEqual([]); expect(await page.evaluate(() => JSON.parse(localStorage.getItem('citymap:designs:v1')!).length)).toBe(1);
  await page.getByLabel('Use cached city data').uncheck(); const uncached = await share(page); await page.goto(uncached.href); await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect(status(page)).toContainText('ready'); expect((await stats(request)).roads).toHaveLength(3);
});

test('context loss gives a retryable error and repeated switches release workers and scenes', async ({ page }) => {
  await page.addInitScript(() => {
    const create = HTMLCanvasElement.prototype.getContext, NativeWorker = window.Worker;
    Object.defineProperty(window, 'localContexts', { value: [] }); Object.defineProperty(window, 'localWorkers', { value: new Set<Worker>() });
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: Parameters<typeof create>) { const context = create.apply(this, args); if (args[0] === 'webgl' && context) { const contexts = (window as unknown as { localContexts: unknown[] }).localContexts; if (!contexts.includes(context)) contexts.push(context); } return context; } as typeof create;
    window.Worker = class extends NativeWorker { constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as unknown as { localWorkers: Set<Worker> }).localWorkers.add(this); } override terminate() { (window as unknown as { localWorkers: Set<Worker> }).localWorkers.delete(this); super.terminate(); } };
  });
  await page.goto('/'); await sample(page);
  await page.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).getContext('webgl')!.getExtension('WEBGL_lose_context')!.loseContext()); await expect(page.getByRole('alert')).toContainText('context lost');
  await page.getByRole('button', { name: 'Retry map' }).click(); await expect(status(page)).toContainText('ready');
  for (let i = 0; i < 5; i++) { await page.getByRole('button', { name: 'Small sample', exact: true }).click(); await expect(status(page)).toContainText('ready'); }
  await expect.poll(() => page.evaluate(() => (window as unknown as { localWorkers: Set<Worker> }).localWorkers.size)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { localContexts: WebGLRenderingContext[] }).localContexts.filter(ctx => !ctx.isContextLost()).length)).toBe(1);
});

test('worker creation denial surface errors instead of blank maps', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { value: class { constructor() { throw new DOMException('Local worker denied', 'SecurityError'); } } }); });
  await page.goto('/'); await detail(page, 'Try a sample map'); await page.getByRole('button', { name: 'Small sample', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Local worker denied'); await expect(page.locator('canvas')).toHaveCount(0);
});

test('unavailable WebGL reports an actionable error and disables exporting', async ({ page }) => {
  await page.addInitScript(() => {
    const create = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, ...args: Parameters<typeof create>) {
      return args[0].includes('webgl') ? null : create.apply(this, args);
    } as typeof create;
  });
  await page.goto('/'); await detail(page, 'Try a sample map');
  await page.getByRole('button', { name: 'Small sample', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('WebGL unavailable');
  await expect(page.getByRole('button', { name: 'Retry map' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  await expect(page.locator('canvas')).toHaveCount(0);
});

test.describe('mobile accessibility', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: process.env.PLAYWRIGHT_BROWSER !== 'firefox', deviceScaleFactor: 2 });
  test('dialog focus/Escape, native browser shortcuts and narrow layout work', async ({ page }) => {
    await page.goto('/'); await sample(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('canvas')).toHaveJSProperty('width', 780); await page.getByRole('button', { name: 'Export', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.querySelector('dialog')!.contains(document.activeElement))).toBe(true); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
    const browserZoomAllowed = await page.locator('canvas').evaluate(canvas => { const event = new WheelEvent('wheel', { ctrlKey: true, bubbles: true, cancelable: true }); canvas.dispatchEvent(event); return !event.defaultPrevented; }); expect(browserZoomAllowed).toBe(true);
    expect(await page.locator('canvas').evaluate(canvas => {
      const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true });
      canvas.dispatchEvent(event); return !event.defaultPrevented;
    })).toBe(true);
    await expect(page.getByRole('link', { name: '© OpenStreetMap contributors', exact: true }).first()).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  });
});
