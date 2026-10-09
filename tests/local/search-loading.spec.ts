import type { Page } from '@playwright/test';
import { test, expect, status, sample, search, live, detail, stats, control } from '../support/local.ts';

test('npm dev page and actual local search proxy validate methods, queries and provider identification', async ({ page, request }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Make a map.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
  for (const [method, code] of [['POST', 405], ['GET', 400]] as const) {
    const response = await request.fetch('/api/search', { method }); expect(response.status()).toBe(code); expect(response.headers()['cache-control']).toBe('no-store');
    if (method === 'POST') expect(response.headers().allow).toBe('GET');
  }
  const response = await request.get('/api/search?q=ActualProxy'); expect(response.status()).toBe(200); expect((await response.json())[0].display_name).toBe('ActualProxy, Japan');
  const calls = (await stats(request)).searches; expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ format: 'jsonv2', limit: '8' }); expect(calls[0].userAgent).toContain('Citymap/2.0');
});

test('search is explicit, caches normalized queries, and distinguishes typed results', async ({ page, request }) => {
  await control(request, { search: { body: [
    { osm_type: 'relation', osm_id: '101', display_name: 'Springfield, Japan', type: 'city' },
    { osm_type: 'way', osm_id: '102', display_name: 'Springfield, Canada', type: 'town' },
    { osm_type: 'node', osm_id: '103', display_name: 'Springfield, France', type: 'village', boundingbox: ['48', '48.1', '2', '2.1'] },
    { osm_type: 'invalid', osm_id: '104', display_name: 'Bad result' },
  ] } });
  await page.goto('/'); await page.getByLabel('Find a city').fill('Springfield'); expect((await stats(request)).searches).toHaveLength(0);
  await page.getByLabel('Find a city').press('Enter'); await expect(status(page)).toContainText('3 matching');
  await expect(page.getByRole('button', { name: 'Springfield, Canada town · way', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Springfield, France village · node', exact: true })).toBeVisible();
  await search(page, '  SPRINGFIELD  '); await expect(status(page)).toContainText('3 matching'); expect((await stats(request)).searches).toHaveLength(1);
});

for (const scenario of ['empty', 'malformed', 'busy'] as const) test(`search ${scenario} is recoverable`, async ({ page, request }) => {
  await control(request, { search: scenario === 'empty' ? { body: [] } : scenario === 'malformed' ? { body: '{' } : { status: 429, retryAfter: '30' } });
  await page.goto('/'); await search(page, `Search ${scenario}`);
  if (scenario === 'empty') await expect(status(page)).toContainText('No usable'); else await expect(page.getByRole('alert')).toBeVisible();
  await control(request, { search: {} }); await live(page, `Recovered ${scenario}`); await expect(page.locator('canvas')).toBeVisible();
});

test('editing a pending query rejects stale search results', async ({ page, request }) => {
  await control(request, { search: { delay: 700 } }); await page.goto('/'); await search(page, 'Old slow query');
  await expect.poll(async () => (await stats(request)).searches.length).toBe(1);
  await page.getByLabel('Find a city').fill('New current query'); await control(request, { search: {} });
  await page.getByRole('button', { name: 'Search', exact: true }).click(); await expect(status(page)).toContainText('Choose from 1');
  await expect(page.getByRole('button', { name: /New current query, Japan/ })).toBeVisible(); await expect(page.getByRole('button', { name: /Old slow query, Japan/ })).toHaveCount(0);
});

for (const [size, segments] of [['Small', '512'], ['Medium', '32,768'], ['Large', '262,144']]) test(`${size} sample renders complete geometry without provider requests`, async ({ page, request }) => {
  await page.goto('/'); await sample(page, size); await detail(page, 'Load timings'); await expect(page.locator('aside')).toContainText(`${segments} segments`);
  await detail(page, 'Data and source'); await expect(page.locator('aside')).toContainText('Synthetic sample'); expect((await stats(request)).roads).toHaveLength(0); expect((await stats(request)).searches).toHaveLength(0);
});

test('automatic live link asks before downloading and preserves configured design', async ({ page, request }) => {
  await page.goto('/?q=Linked&areaId=3600000101&auto=1&cache=0&label=Keep+me&roads=123456');
  await expect(status(page)).toContainText('Confirm this download'); expect((await stats(request)).roads).toHaveLength(0);
  await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect(status(page)).toContainText('ready');
  await expect(page.getByLabel('Label text')).toHaveValue('Keep me'); await expect(page.getByLabel('Road color')).toHaveValue('#123456');
});

test('node bounding boxes, valid custom bounds and antimeridian queries are sent correctly', async ({ page, request }) => {
  await control(request, { search: { body: [{ osm_type: 'node', osm_id: '9', display_name: 'Node area', type: 'village', boundingbox: ['35', '35.1', '139', '139.1'] }] } });
  await page.goto('/'); await search(page, 'Node bounds'); await page.getByRole('button', { name: 'Node area village · node', exact: true }).click(); await expect(status(page)).toContainText('ready');
  expect((await stats(request)).roads[0]).toContain('(35,139,35.1,139.1)');
  await detail(page, 'Data and source'); await page.getByLabel('Bounding box: south, west, north, east').fill('-10,170,10,-170'); await page.getByRole('button', { name: 'Load bounding box', exact: true }).click(); await expect(status(page)).toContainText('ready');
  expect((await stats(request)).roads.at(-1)).toContain('(-10,170,10,180)'); expect((await stats(request)).roads.at(-1)).toContain('-180,10,-170');
});

test('invalid URL and custom bounds never start a download and the app can recover', async ({ page, request }) => {
  await page.goto('/?areaId=bad&auto=1'); await expect(page.getByRole('alert')).toContainText('invalid city'); expect((await stats(request)).roads).toHaveLength(0);
  await sample(page); await detail(page, 'Data and source');
  for (const value of ['35,,36,140', '36,139,35,140', '0,0,1,181']) {
    await page.getByLabel('Bounding box: south, west, north, east').fill(value); await page.getByRole('button', { name: 'Load bounding box', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  }
  expect((await stats(request)).roads).toHaveLength(0);
});

for (const failure of ['empty', 'missing', 'remark', 'json', 'unavailable'] as const) test(`road ${failure} rejects incomplete output and retry recovers`, async ({ page, request }) => {
  const broken = failure === 'empty' ? { body: { elements: [] } } : failure === 'missing' ? { body: { elements: [{ type: 'node', id: '1', lat: 35, lon: 139 }, { type: 'way', id: '2', nodes: ['1', '9'] }] } } : failure === 'remark' ? { body: { remark: 'Query exhausted memory' } } : failure === 'json' ? { body: '{' } : { status: 503, retryAfter: '0' };
  await control(request, { roads: broken }); await page.goto('/?q=Failed&areaId=3600000101&cache=0'); await page.getByRole('button', { name: 'Load roads', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled(); await expect(page.locator('canvas')).toHaveCount(0);
  await control(request, { roads: {} }); await page.getByRole('button', { name: 'Retry map' }).click(); await expect(status(page)).toContainText('ready');
});

test('transient road errors retry once and restore useful source/freshness information', async ({ page, request }) => {
  await control(request, { roads: { status: 503, failures: 1, retryAfter: '0' } }); await page.goto('/'); await live(page, 'Transient roads');
  expect((await stats(request)).roads).toHaveLength(2); await detail(page, 'Data and source'); await expect(page.locator('aside')).toContainText('Live OpenStreetMap data'); await expect(page.locator('aside')).toContainText('2026');
});

test('cancel button, Escape and switching prevent delayed roads from replacing the map', async ({ page, request }) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    const events: { type: string; at: number }[] = [];
    Object.defineProperty(window, 'cancelProbe', { value: events });
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => events.push({ type: `received:${event.data.type}`, at: performance.now() }));
      }
      override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        events.push({ type: `sent:${(message as { type?: string }).type || 'load'}`, at: performance.now() });
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      override terminate() { events.push({ type: 'terminate', at: performance.now() }); super.terminate(); }
    };
  });
  await control(request, { roads: { hold: true } }); await page.goto('/?q=Slow&areaId=3600000101&cache=0');
  await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect.poll(async () => (await stats(request)).roads.length).toBe(1);
  await page.getByRole('button', { name: 'Cancel load' }).click(); await expect(status(page)).toContainText('cancelled');
  await expect.poll(async () => (await stats(request)).aborted).toBe(1);
  await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect.poll(async () => (await stats(request)).roads.length).toBe(2);
  await page.keyboard.press('Escape'); await expect(status(page)).toContainText('cancelled'); await expect.poll(async () => (await stats(request)).aborted).toBe(2);
  await page.getByRole('button', { name: 'Load roads', exact: true }).click(); await expect.poll(async () => (await stats(request)).roads.length).toBe(3);
  await sample(page); await expect(status(page)).toContainText('Small synthetic grid ready'); await expect.poll(async () => (await stats(request)).aborted).toBe(3);
  const events = await page.evaluate(() => (window as unknown as { cancelProbe: { type: string }[] }).cancelProbe);
  expect(events.filter(event => event.type === 'sent:cancel')).toHaveLength(3);
  expect(events.filter(event => event.type === 'received:cancelled')).toHaveLength(3);
});

const choosePlace = async (page: Page, name: string) => { await search(page, name); await page.getByRole('button', { name: `${name}, Japan city · relation`, exact: true }).click(); };
const position = (page: Page) => page.getByRole('progressbar', { name: 'Map download' }).evaluate(bar => (bar as HTMLProgressElement).position);

test('a known download size shows a determinate progress bar with bytes and percentage', async ({ page, request }) => {
  await control(request, { roads: { trickle: 400 } }); await page.goto('/'); await choosePlace(page, 'Progress city');
  await expect.poll(() => position(page)).toBeGreaterThan(0);
  await expect(page.locator('.load-status')).toContainText(/Downloading live roads… · \d+ KB of \d+ KB \(\d+%\)/);
  await expect(status(page)).toContainText('ready'); await expect(page.getByRole('progressbar', { name: 'Map download' })).toHaveCount(0);
});

test('a silent wait shows an indeterminate bar with a running timer and stays cancellable', async ({ page, request }) => {
  await control(request, { roads: { hold: true } }); await page.goto('/'); await choosePlace(page, 'Silent city');
  await expect.poll(() => position(page)).toBe(-1);
  const line = page.locator('.load-status .hint').first(), seconds = async () => Number((await line.textContent())!.match(/(\d+) s$/)![1]);
  await expect(line).toContainText('Waiting for the road service…');
  const first = await seconds(); await expect.poll(seconds).toBeGreaterThan(first);
  await page.getByRole('button', { name: 'Cancel load', exact: true }).click(); await expect(status(page)).toContainText('cancelled');
});
