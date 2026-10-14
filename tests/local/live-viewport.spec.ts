import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, status, search, sample, detail, share, stats, control } from '../support/local.ts';
import { cellName, parseCellQueries } from '../support/live-roads.ts';
import type { CellQuery } from '../support/live-roads.ts';

// Viewport tests opt in per page; the default suite keeps whole-area live loading covered.
const LIVE = 'liveMode=viewport';
const cellQueries = async (request: APIRequestContext) => (await stats(request)).roads.filter(query => query.includes('out geom'));
/** Requests combine several cells; these are every requested cell, in order. */
const requestedCells = async (request: APIRequestContext) => (await cellQueries(request)).flatMap(parseCellQueries);
const span = ({ box: [, west, , east] }: CellQuery) => east - west;
async function choose(page: Page, name: string, query = '') {
  await page.goto(`/?${LIVE}${query}`);
  await search(page, name);
  await page.getByRole('button', { name: `${name}, Japan city · relation`, exact: true }).click();
}
async function liveCity(page: Page, name = 'Live city', query = '') {
  await choose(page, name, query);
  await expect(status(page)).toContainText(`${name}, Japan ready`);
}
async function drag(page: Page, dx: number, dy = 0) {
  const map = (await page.locator('canvas').boundingBox())!, x = map.x + map.width / 2, y = map.y + map.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx * map.width, y + dy * map.height, { steps: 8 });
  // Holding still lets the renderer's tracked velocity decay, so release adds no kinetic glide.
  await page.evaluate(() => new Promise<void>(resolve => { let frames = 12; const next = () => --frames ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next); }));
  await page.mouse.up();
}
// Proving that nothing more is requested needs a bounded wait beyond the 250 ms view debounce.
const settle = (page: Page) => page.waitForTimeout(1200);
/** "Ready" covers the visible view; this also waits for the padding around it to finish loading. */
async function idle(request: APIRequestContext) {
  let last = -1;
  await expect.poll(async () => { const count = (await cellQueries(request)).length, same = count === last; last = count; return same; }, { intervals: [700], timeout: 15_000 }).toBe(true);
}
/**
 * Downloads an SVG at the export dialog's default size, which has the map's own shape;
 * `message` is what the dialog then says.
 */
async function svg(page: Page, message = 'SVG exported.') {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const width = Number(await page.getByLabel('Width in pixels').inputValue()), height = Number(await page.getByLabel('Height in pixels').inputValue());
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
  const xml = (await readFile((await (await pending).path())!)).toString('utf8');
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText(message);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  return { xml, width, height };
}
const centreHint = 'Export is available once the centre of the map has loaded';

test('a searched city loads a bounded set of viewport cells, never one whole-area query', async ({ page, request }) => {
  await liveCity(page);
  const queries = (await stats(request)).roads;
  expect(queries.length).toBeGreaterThan(1); expect(queries.length).toBeLessThanOrEqual(16);
  for (const query of queries) { expect(query).toContain('out geom'); expect(query).not.toContain('area'); expect(query).toMatch(/\[timeout:(30|40|50|60)\]/); }
  // Requests combine up to four cells, and no cell is requested twice.
  const cells = await requestedCells(request);
  expect(cells.length).toBeGreaterThan(queries.length); expect(queries.every(query => parseCellQueries(query).length <= 4)).toBe(true);
  expect(new Set(cells.map(cellName)).size).toBe(cells.length);
  // Major roads load first, then streets; footpaths are not requested at street detail.
  expect(cells[0].rank).toBe(0); expect(cells.some(cell => cell.rank === 1)).toBe(true); expect(cells.some(cell => cell.rank === 2)).toBe(false);
  await detail(page, 'Data and source'); await expect(page.locator('aside')).toContainText('loaded by map view');
  await expect(page.locator('aside')).toContainText(/Source date: .*2026/);
  await detail(page, 'Load timings'); await expect(page.locator('aside')).toContainText(`${queries.length} road requests`);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
});

test('panning loads only new neighbouring cells; panning back, zoom oscillation and restyling reuse loaded roads', async ({ page, request }) => {
  await liveCity(page); await idle(request);
  const initial = (await cellQueries(request)).length;
  await drag(page, -0.9);
  await expect.poll(async () => (await cellQueries(request)).length).toBeGreaterThan(initial);
  await expect(status(page)).toContainText('ready'); await idle(request);
  const panned = await cellQueries(request), cells = (await requestedCells(request)).map(cellName);
  expect(new Set(cells).size, 'No cell is requested twice').toBe(cells.length);
  await drag(page, 0.9); await settle(page);
  await expect(status(page)).toContainText('ready'); expect(await cellQueries(request)).toHaveLength(panned.length);
  for (const zoom of ['Zoom in', 'Zoom out', 'Zoom in', 'Zoom out']) await page.getByRole('button', { name: zoom, exact: true }).click();
  await page.getByRole('button', { name: 'Night', exact: true }).click(); await page.getByLabel('Road color').fill('#123456');
  await settle(page); expect(await cellQueries(request)).toHaveLength(panned.length);
  // Fit map frames the searched place (a 0.1° box here), loading its cells by view.
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect.poll(async () => (await cellQueries(request)).length).toBeGreaterThan(panned.length);
  await expect(status(page)).toContainText('ready');
  const view = (await share(page)).searchParams.get('view')!.split(',').map(Number);
  expect(view[0]).toBeCloseTo(139.05, 2); expect(view[1]).toBeCloseTo(35.05, 2);
});

test('a zoomed-out view keeps major roads and asks to zoom in rather than requesting hundreds of cells', async ({ page, request }) => {
  await liveCity(page);
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(status(page)).toContainText('Zoom in to load streets here');
  await expect(page.locator('.live-status')).toContainText('zoom in for more road detail');
  const queries = await cellQueries(request);
  expect(queries.length).toBeLessThan(60);
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(status(page)).toContainText('ready');
});

test('road detail upgrades fetch only the newly shown classes and downgrades fetch nothing', async ({ page, request }) => {
  await liveCity(page, 'Detail city', '&detail=major');
  // Major-road views start wide; every way needs a closer view (a wider one asks to zoom in).
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await idle(request);
  const major = await cellQueries(request);
  expect(major.every(query => query.includes('motorway') && !query.includes('residential'))).toBe(true);
  await page.getByLabel('Roads shown').selectOption('streets');
  await expect.poll(async () => (await cellQueries(request)).length).toBeGreaterThan(major.length);
  await expect(status(page)).toContainText('ready'); await idle(request);
  const streets = (await cellQueries(request)).slice(major.length);
  expect(streets.every(query => query.includes('"^(unclassified|residential'))).toBe(true);
  await page.getByLabel('Roads shown').selectOption('all');
  await expect.poll(async () => (await cellQueries(request)).length).toBeGreaterThan(major.length + streets.length);
  await expect(status(page)).toContainText('ready'); await idle(request);
  const all = (await cellQueries(request)).slice(major.length + streets.length);
  expect(all.every(query => query.includes('["highway"]["highway"!~'))).toBe(true);
  const total = major.length + streets.length + all.length;
  await page.getByLabel('Roads shown').selectOption('major'); await page.getByLabel('Roads shown').selectOption('streets');
  await settle(page); expect(await cellQueries(request)).toHaveLength(total);
  // Exports hold exactly the shown classes, from roads already loaded.
  const segments = async () => ((await svg(page)).xml.match(/M[-0-9.]+,/g) || []).length;
  const shown = await segments();
  await page.getByLabel('Roads shown').selectOption('all'); const every = await segments();
  await page.getByLabel('Roads shown').selectOption('streets'); expect(await segments()).toBe(shown);
  expect(every).toBeGreaterThan(shown);
  expect((await share(page)).searchParams.get('detail')).toBe('streets');
});

test('a fully loaded view exports every road, and roads cross cell seams once without gaps', async ({ page, request }) => {
  await liveCity(page, 'Export city'); await idle(request);
  // The export has the view's shape, so every region of its frame has loaded.
  const { xml, width, height } = await svg(page);
  const pieces = [...xml.matchAll(/M([-\d.]+),([-\d.]+)L([-\d.]+),([-\d.]+)/g)].map(match => match.slice(1).map(Number));
  expect(pieces.length).toBeGreaterThan(500);
  expect(new Set(pieces.map(piece => piece.join(','))).size, 'No segment is drawn twice').toBe(pieces.length);
  // Every synthetic road is a meridian or a parallel. Pieces of one road must join end to end
  // across the whole frame: an overlap is a seam duplicate, a gap a missing cell.
  const lines = new Map<string, [number, number][]>();
  for (const [x1, y1, x2, y2] of pieces) {
    const vertical = Math.abs(x1 - x2) < 1e-6;
    expect(vertical || Math.abs(y1 - y2) < 1e-6).toBe(true);
    const key = vertical ? `x${x1.toFixed(3)}` : `y${y1.toFixed(3)}`;
    const interval: [number, number] = vertical ? [Math.min(y1, y2), Math.max(y1, y2)] : [Math.min(x1, x2), Math.max(x1, x2)];
    lines.set(key, [...lines.get(key) || [], interval]);
  }
  expect(lines.size).toBeGreaterThan(50);
  for (const [key, intervals] of lines) {
    intervals.sort((a, b) => a[0] - b[0]);
    const extent = key.startsWith('x') ? height : width;
    expect(intervals[0][0], `${key} starts at the frame edge`).toBeCloseTo(0, 3);
    expect(intervals.at(-1)![1], `${key} ends at the frame edge`).toBeCloseTo(extent, 3);
    for (let i = 1; i < intervals.length; i++) expect(Math.abs(intervals[i][0] - intervals[i - 1][1]), `${key} joins exactly`).toBeLessThan(1e-3);
  }
  const png = await (async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByLabel('Width in pixels').fill(String(width)); await page.getByLabel('Height in pixels').fill(String(height));
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PNG', exact: true }).click();
    const bytes = await readFile((await (await pending).path())!); await page.getByRole('button', { name: 'Close', exact: true }).click(); return bytes;
  })();
  expect(png.readUInt32BE(16)).toBe(width); expect(png.readUInt32BE(20)).toBe(height);
});

test('a dense cell is split into quarters only where needed, and rate limits wait without splitting', async ({ page, request }) => {
  // Major-road cells (about 0.18° wide) time out; their quarters load. Street cells are unaffected.
  await control(request, { roads: { dense: 0.1 } });
  await liveCity(page, 'Dense city'); await idle(request);
  const queries = await cellQueries(request), cells = await requestedCells(request);
  // A combined request with a major-road cell times out, so its cells load alone; only those time out again and split.
  const coarse = new Set(cells.filter(cell => span(cell) > 0.1).map(cellName)), quarters = cells.filter(cell => cell.rank === 0 && span(cell) < 0.1);
  expect(coarse.size).toBeGreaterThan(0); expect(quarters).toHaveLength(coarse.size * 4);
  expect(cells.filter(cell => cell.rank === 1).every(cell => span(cell) > 0.04)).toBe(true);
  await detail(page, 'Load timings'); await expect(page.locator('aside')).toContainText('dense regions split');
  await control(request, { roads: { status: 429, failures: 1, retryAfter: '1' } });
  await drag(page, -0.9);
  // Cross-origin responses hide Retry-After, so the wait comes from the status page: a free slot.
  await expect.poll(async () => (await cellQueries(request)).length, { timeout: 15_000 }).toBeGreaterThan(queries.length + 1);
  expect((await stats(request)).statusChecks).toBe(1);
  await expect(status(page)).toContainText('ready');
  const after = (await cellQueries(request)).slice(queries.length);
  // The rate-limited request is repeated as it was; nothing is split.
  expect(after[1]).toBe(after[0]);
  expect(after.flatMap(parseCellQueries).every(cell => span(cell) > (cell.rank === 0 ? 0.1 : 0.04))).toBe(true);
});

test('failed regions in the centre leave loaded roads visible and keep Export unavailable until retry recovers', async ({ page, request }) => {
  // Major roads fail; their cells cover the centre of the view.
  await control(request, { roads: { status: 400, match: 'motorway' } });
  await choose(page, 'Failing city');
  await expect(status(page)).toContainText('Some roads in view could not be loaded');
  await expect(page.locator('.live-status')).toContainText('failed');
  await expect(page.locator('.live-status')).toContainText(centreHint);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  await control(request, { roads: {} });
  await page.getByRole('button', { name: 'Retry loading roads', exact: true }).click();
  await expect(status(page)).toContainText('Failing city, Japan ready');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  expect((await svg(page)).xml.match(/<path d="M/g)!.length).toBeGreaterThan(0);
});

test('Export waits only for the centre of the map, then exports the map available around it', async ({ page, request }) => {
  const exportButton = page.getByRole('button', { name: 'Export', exact: true });
  // Slow responses show Export unavailable until the centre has loaded.
  await control(request, { roads: { delay: 300 } });
  await choose(page, 'Centre city');
  await expect(exportButton).toBeDisabled(); await expect(page.locator('.live-status')).toContainText(centreHint);
  await expect(exportButton).toBeEnabled({ timeout: 15_000 });
  await control(request, { roads: {} });
  await expect(status(page)).toContainText('Centre city, Japan ready'); await idle(request);
  // Zooming out keeps the centre within the loaded area; the new regions around it never answer.
  await control(request, { roads: { hold: true } });
  const before = (await cellQueries(request)).length;
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(async () => (await cellQueries(request)).length).toBeGreaterThan(before);
  await expect(status(page)).toContainText('Loading roads in view');
  await expect(exportButton).toBeEnabled();
  const { xml } = await svg(page, 'Exported available map.');
  expect(xml.match(/<path d="M/g)!.length).toBeGreaterThan(0);
});

test('a rate limit waits as long as the road service status page says, with a countdown', async ({ page, request }) => {
  // The status page asks for 9 s; the fallback guess would be about 5 s.
  await control(request, { roads: { status: 429, failures: 1, slotWait: 9 } });
  await choose(page, 'Waiting city');
  await expect(page.locator('.live-status')).toContainText(/The road service asked to wait: retrying in [7-9] s\./);
  await expect(status(page)).toContainText('The road service asked to wait');
  expect((await stats(request)).statusChecks).toBe(1); expect(await cellQueries(request)).toHaveLength(1);
  await expect(status(page)).toContainText('Waiting city, Japan ready', { timeout: 20_000 });
  await expect(page.getByText(/retrying in/)).toHaveCount(0);
});

test('a busy road service makes every request wait, with a countdown, instead of failing regions', async ({ page, request }) => {
  await control(request, { roads: { status: 504, failures: 1 } });
  await choose(page, 'Busy city');
  await expect(page.locator('.live-status')).toContainText(/The road service is busy: retrying in \d+ s\./);
  await expect(status(page)).toContainText('The road service is busy. Loading resumes by itself');
  await expect(page.locator('.live-status')).not.toContainText('failed');
  // Nothing else is requested during the wait, and a busy service needs no status page.
  await settle(page);
  expect(await cellQueries(request)).toHaveLength(1); expect((await stats(request)).statusChecks).toBe(0);
});

test('regions far behind the view are evicted with their GPU buffers and reload when revisited', async ({ page, request }) => {
  await page.addInitScript(() => {
    const counts = { created: 0, deleted: 0 };
    Object.defineProperty(window, 'bufferProbe', { value: counts });
    const create = WebGLRenderingContext.prototype.createBuffer, remove = WebGLRenderingContext.prototype.deleteBuffer;
    WebGLRenderingContext.prototype.createBuffer = function(this: WebGLRenderingContext) { if ((this.canvas as HTMLCanvasElement).isConnected) counts.created++; return create.call(this); };
    WebGLRenderingContext.prototype.deleteBuffer = function(this: WebGLRenderingContext, buffer: WebGLBuffer | null) { if ((this.canvas as HTMLCanvasElement).isConnected) counts.deleted++; return remove.call(this, buffer); };
  });
  const buffers = () => page.evaluate(() => (window as unknown as { bufferProbe: { created: number; deleted: number } }).bufferProbe);
  // Without the browser cell cache, evicted regions must come back from the road service.
  await liveCity(page, 'Evicting city', '&liveBudget=250000&cache=0'); await idle(request);
  const first = (await requestedCells(request)).map(cellName);
  const peaks: number[] = [];
  for (const [index, dx] of [-0.9, -0.9, -0.9, -0.9, -0.9, 0.9, 0.9, 0.9, 0.9, 0.9].entries()) {
    const count = (await cellQueries(request)).length;
    await drag(page, dx);
    // Going out always reaches new cells; coming back may find recent ones still loaded.
    if (index < 5) await expect.poll(async () => (await cellQueries(request)).length).toBeGreaterThan(count);
    await expect(status(page)).toContainText('ready'); await idle(request);
    const { created, deleted } = await buffers(); peaks.push(created - deleted);
  }
  const { deleted } = await buffers();
  expect(deleted, 'Evicted regions release their GPU buffers').toBeGreaterThan(0);
  // Live buffers plateau instead of growing with every pan.
  expect(Math.max(...peaks.slice(5))).toBeLessThanOrEqual(Math.max(...peaks.slice(0, 5)) + 4);
  // The starting cells were evicted far away and fetched again on return.
  const cells = (await requestedCells(request)).map(cellName);
  expect(first.some(cell => cells.filter(entry => entry === cell).length > 1)).toBe(true);
  await expect(page.locator('canvas')).toBeVisible();
});

test('share links reopen the same live view and load cells around it without a download prompt', async ({ page, request }) => {
  await liveCity(page, 'Shared city');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await drag(page, 0.3, 0.2);
  await expect(status(page)).toContainText('ready');
  const link = await share(page), expected = link.searchParams.get('view')!.split(',').map(Number);
  expect(link.searchParams.get('bbox')).toBe('35,139,35.1,139.1');
  await page.goto(`${link.href}&${LIVE}`);
  await expect(status(page)).toContainText('Shared city, Japan ready');
  const restored = (await share(page)).searchParams.get('view')!.split(',').map(Number);
  restored.forEach((value, index) => expect(value).toBeCloseTo(expected[index], index < 2 ? 5 : 0));
  expect((await stats(request)).roads.every(query => query.includes('out geom'))).toBe(true);
});

test('revisits use the browser cell cache; refresh fetches again and clearing removes cached cells', async ({ page, request }) => {
  const cached = () => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('citymap-cells', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('cells'); open.result.createObjectStore('metadata', { keyPath: 'key' }); };
    open.onsuccess = () => { const db = open.result, count = db.transaction('cells').objectStore('cells').count(); count.onsuccess = () => { db.close(); resolve(count.result); }; count.onerror = () => reject(count.error); };
    open.onerror = () => reject(open.error);
  }));
  await liveCity(page, 'Cached city'); await idle(request);
  // The cache holds cells, which requests combine.
  const requests = (await cellQueries(request)).length, requested = (await requestedCells(request)).length;
  await expect.poll(cached).toBe(requested);
  const link = await share(page);
  await page.goto(`${link.href}&${LIVE}`); await expect(status(page)).toContainText('Cached city, Japan ready');
  expect(await cellQueries(request)).toHaveLength(requests);
  await detail(page, 'Load timings'); await expect(page.locator('aside')).toContainText(`${requested} from the browser cache`);
  await detail(page, 'Data and source'); await page.getByRole('button', { name: 'Refresh city data' }).click();
  await expect.poll(async () => (await requestedCells(request)).length).toBe(2 * requested);
  await expect(status(page)).toContainText('ready');
  await page.getByRole('button', { name: 'Clear city cache' }).click();
  await expect.poll(cached).toBe(0);
});

test('an unreachable road service pauses loading with that reason, and retry recovers', async ({ page, request }) => {
  await control(request, { roads: { blocked: true } });
  await choose(page, 'Unreachable city');
  await expect(status(page)).toContainText('The road service cannot be reached from this network');
  await expect(page.locator('canvas')).toBeVisible();
  // Five consecutive failures pause loading; nothing more is requested until retried.
  const count = (await cellQueries(request)).length;
  expect(count).toBeGreaterThanOrEqual(5); await settle(page);
  expect(await cellQueries(request)).toHaveLength(count);
  await control(request, { roads: {} });
  await page.getByRole('button', { name: 'Retry loading roads', exact: true }).click();
  await expect(status(page)).toContainText('Unreachable city, Japan ready');
});

test('live roads load only within about 50 km of where the map started', async ({ page, request }) => {
  // The search result's box centre, where this map starts.
  const start = [139.05, 35.05], radians = Math.PI / 180;
  const distance = ([lon, lat]: number[]) => { const h = Math.sin((lat - start[1]) * radians / 2) ** 2 + Math.cos(start[1] * radians) * Math.cos(lat * radians) * Math.sin((lon - start[0]) * radians / 2) ** 2; return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h)); };
  // Nearest point of each requested cell's box to the start.
  const nearest = ({ box: [s, w, n, e] }: CellQuery) => distance([Math.min(e, Math.max(w, start[0])), Math.min(n, Math.max(s, start[1]))]);
  await liveCity(page, 'Radius city', '&detail=major');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await idle(request);
  let pans = 0;
  while (!(await status(page).textContent())!.includes('more than 50 km') && pans++ < 10) { await drag(page, -0.9); await idle(request); }
  await expect(status(page)).toContainText('This view is more than 50 km from where the map started');
  await expect(page.locator('.live-status')).toContainText('Roads load only within 50 km of where this map started');
  const queries = await cellQueries(request);
  expect(queries.length).toBeGreaterThan(3);
  for (const cell of queries.flatMap(parseCellQueries)) expect(nearest(cell), 'Every requested cell starts within the radius').toBeLessThanOrEqual(50_000);
  // Further away, nothing more is requested.
  await drag(page, -0.9); await settle(page);
  expect(await cellQueries(request)).toHaveLength(queries.length);
  // The centre there can never load, so the map cannot be exported.
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  await expect(page.locator('.live-status')).toContainText(centreHint);
  // Back at the start, roads are still there.
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect(status(page)).toContainText('Radius city, Japan ready');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
});

test('switching cities aborts live requests and never draws a previous city\'s cells', async ({ page, request }) => {
  await control(request, { roads: { hold: true } });
  await choose(page, 'Held city');
  await expect.poll(async () => (await cellQueries(request)).length).toBe(1);
  await expect(page.locator('canvas')).toBeVisible();
  await control(request, { roads: {} });
  await sample(page);
  await expect.poll(async () => (await stats(request)).aborted).toBe(1);
  await expect(status(page)).toContainText('Small synthetic grid ready');
  await detail(page, 'Load timings'); await expect(page.locator('aside')).toContainText('512 segments');
});
