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
  for (const [id, text] of [['road-opacity', '25%'], ['background-opacity', '50%'], ['label-opacity', '35%'], ['size', '48 px']]) await expect(page.locator(`output[for="${id}"]`)).toHaveText(text);
  await expect(page.getByLabel('Road opacity', { exact: true })).toHaveAttribute('aria-valuetext', '25%');
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

test('live loads download only the road detail shown and fetch more only when needed', async ({ page, request }) => {
  await page.goto('/'); await live(page, 'Detail city');
  const roads = async () => (await stats(request)).roads;
  expect(await roads()).toHaveLength(1); expect((await roads())[0]).toContain('highway"~'); expect((await roads())[0]).not.toContain('footway');
  await page.getByLabel('Roads shown').selectOption('all');
  await expect.poll(async () => (await roads()).length).toBe(2); await expect(status(page)).toContainText('ready');
  expect((await roads())[1]).toContain('way["highway"](area');
  await page.getByLabel('Roads shown').selectOption('streets'); await page.getByLabel('Roads shown').selectOption('major');
  await expect(status(page)).toContainText('ready'); expect(await roads()).toHaveLength(2);
  expect((await share(page)).searchParams.get('detail')).toBe('major');
});

test('the north arrow shows by default, appears in PNG and SVG exports and can be turned off', async ({ page }) => {
  await page.goto('/'); await sample(page);
  const arrow = page.getByRole('button', { name: /^North arrow/ }); await expect(arrow).toBeVisible();
  const exported = async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByLabel('Width in pixels').fill('800'); await page.getByLabel('Height in pixels').fill('600');
    const files: Buffer[] = [];
    for (const format of ['SVG', 'PNG']) { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: `Download ${format}`, exact: true }).click(); files.push(await readFile((await (await pending).path())!)); }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    // Count dark pixels in the top-right corner, where the arrow sits clear of the roads.
    const dark = await page.evaluate(async data => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' })); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); const pixels = ctx.getImageData(680, 6, 114, 114).data; let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) count++; return count; }, [...files[1]]);
    return { svg: files[0].toString('utf8'), dark };
  };
  const shown = await exported(); expect(shown.svg).toContain('>N</text>'); expect(shown.dark).toBeGreaterThan(50);
  await page.getByLabel('Show north arrow').uncheck(); await expect(arrow).toHaveCount(0);
  expect((await share(page)).searchParams.get('north')).toBe('0');
  const hidden = await exported(); expect(hidden.svg).not.toContain('>N</text>'); expect(hidden.dark).toBe(0);
});

test('the north arrow and scale bar move by drag and arrow keys, and links restore their positions', async ({ page }) => {
  await page.goto('/'); await sample(page);
  const compass = page.getByRole('button', { name: /^North arrow/ }), bar = page.getByRole('button', { name: /^Scale bar/ });
  const centre = async (element: typeof compass) => { const b = (await element.boundingBox())!, m = (await page.locator('.map').boundingBox())!; return [(b.x + b.width / 2 - m.x) / m.width, (b.y + b.height / 2 - m.y) / m.height]; };
  const map = (await page.locator('.map').boundingBox())!, box = (await compass.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(map.x + map.width * 0.3, map.y + map.height * 0.4, { steps: 6 }); await page.mouse.up();
  let link = await share(page);
  expect(Number(link.searchParams.get('northX'))).toBeCloseTo(0.3, 2); expect(Number(link.searchParams.get('northY'))).toBeCloseTo(0.4, 2);
  // Until it is moved, the scale bar follows just below the north arrow.
  const [compassX, compassY] = await centre(compass), [barX, barY] = await centre(bar);
  expect(barX).toBeCloseTo(compassX, 2); expect(barY).toBeGreaterThan(compassY); expect(link.searchParams.has('scaleX')).toBe(false);
  await compass.focus(); await page.keyboard.press('ArrowLeft');
  const [followX, followY] = await centre(bar); expect(followX).toBeCloseTo(barX - 0.01, 2); expect(followY).toBeCloseTo(barY, 2);
  await bar.focus(); await page.keyboard.press('Shift+ArrowUp');
  link = await share(page);
  expect(Number(link.searchParams.get('northX'))).toBeCloseTo(0.29, 2);
  expect(Number(link.searchParams.get('scaleX'))).toBeCloseTo(followX, 2); expect(Number(link.searchParams.get('scaleY'))).toBeCloseTo(followY - 0.05, 2);
  await page.goto(link.href); await expect(status(page)).toContainText('ready');
  const [x, y] = await centre(compass); expect(x).toBeCloseTo(0.29, 2); expect(y).toBeCloseTo(0.4, 2);
  expect((await centre(bar))[1]).toBeCloseTo(followY - 0.05, 2);
});

test('the railway scale bar shows kilometre and mile teeth, follows zoom, exports and can be hidden', async ({ page }) => {
  await page.goto('/'); await sample(page);
  const bar = page.getByRole('button', { name: /^Scale bar/ }), name = async () => (await bar.getAttribute('aria-label'))!;
  const before = await name(); expect(before).toMatch(/^Scale bar, \d+ (km|m) and \d+ (mi|ft) at the map centre/);
  await expect(bar.locator('text').last()).toHaveText(/^\d+ (mi|ft)$/);
  // Teeth mark whole numbers only.
  for (const text of await bar.locator('text').allTextContents()) expect(text).toMatch(/^\d+( (km|m|mi|ft))?$/);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(name).not.toBe(before);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
  const xml = (await readFile((await (await pending).path())!)).toString('utf8');
  expect(xml).toMatch(/ (km|m)<\/text>/); expect(xml).toMatch(/ (mi|ft)<\/text>/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Show scale bar').uncheck(); await expect(bar).toHaveCount(0);
  expect((await share(page)).searchParams.get('scaleBar')).toBe('0');
});

test('the options sidebar collapses to a hamburger button and the map takes the full width', async ({ page }) => {
  await page.goto('/'); await sample(page);
  const canvas = page.locator('canvas'), before = (await canvas.boundingBox())!.width;
  await page.getByRole('button', { name: 'Hide options', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Map settings' })).toBeHidden();
  const show = page.getByRole('button', { name: 'Show options', exact: true });
  await expect(show).toBeFocused(); await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(before + 300);
  await expect(page.getByRole('button', { name: /^Scale bar/ })).toBeVisible();
  await show.click(); await expect(page.getByLabel('Find a city')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide options', exact: true })).toBeFocused();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeCloseTo(before, 0);
});

test('map rotation turns the map and compass, keeps the view, survives links and exports, and resets for a new city', async ({ page }) => {
  await page.goto('/'); await sample(page);
  const view = async () => (await share(page)).searchParams.get('view')!.split(',').map(Number);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const before = await view();
  await slider(page, 'Map rotation', 45);
  await expect(page.locator('output[for="rotation"]')).toHaveText('45°');
  // rotate(45deg) is the matrix cos 45°, sin 45°, −sin 45°, cos 45°.
  await expect(page.getByRole('button', { name: /^North arrow/ }).locator('svg')).toHaveCSS('transform', /^matrix\(0\.707\d*, 0\.707\d*, -0\.707\d*, 0\.707\d*, 0, 0\)$/);
  // Turning the map keeps its centre and zoom.
  const turned = await view();
  expect(turned[0]).toBeCloseTo(before[0], 5); expect(turned[1]).toBeCloseTo(before[1], 5); expect(turned[2]).toBeCloseTo(before[2], 0);
  const map = (await page.locator('canvas').boundingBox())!; await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2); await page.mouse.down(); await page.mouse.move(map.x + map.width / 2 + 40, map.y + map.height / 2 + 20, { steps: 5 }); await page.mouse.up();
  const link = await share(page), expected = link.searchParams.get('view')!.split(',').map(Number);
  expect(link.searchParams.get('rotation')).toBe('45');
  await page.goto(link.href); await expect(status(page)).toContainText('ready');
  await expect(page.getByLabel('Map rotation')).toHaveValue('45');
  (await view()).forEach((value, index) => expect(value).toBeCloseTo(expected[index], index < 2 ? 5 : 0));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
  expect((await readFile((await (await pending).path())!)).toString('utf8')).toMatch(/scale\([\d.]+\) rotate\(45 /);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await sample(page); await expect(page.getByLabel('Map rotation')).toHaveValue('0');
});

test('saved designs restore settings after reload and can be deleted; no recent-city list is shown', async ({ page }) => {
  await page.goto('/'); await sample(page); await page.getByLabel('Label text').fill('Saved 東京'); await page.getByRole('button', { name: 'Night', exact: true }).click(); await page.getByRole('button', { name: 'Save design', exact: true }).click();
  await page.goto('/'); await detail(page, 'Saved designs'); await page.getByRole('button', { name: 'Saved 東京', exact: true }).click(); await expect(status(page)).toContainText('ready'); await expect(page.getByLabel('Road color')).toHaveValue('#e1e7d9');
  await page.getByRole('button', { name: 'Delete design Saved 東京' }).click(); await expect(page.getByText('Saved designs', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Recent cities')).toHaveCount(0);
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
    // Attribution stays in the settings and exports, not on the map itself.
    await expect(page.getByRole('link', { name: '© OpenStreetMap contributors, ODbL', exact: true })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    await expect(page.locator('.map a')).toHaveCount(0);
  });
});
