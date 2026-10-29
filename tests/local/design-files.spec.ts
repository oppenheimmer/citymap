import { readFile } from 'node:fs/promises';
import { test, expect, sample, status, label, detail, share, stats } from '../support/local.ts';

test('Open Monaco and its shared link use the bundled revision without search or road services', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Monaco', exact: true }).click();
  await expect(status(page)).toContainText('Monaco ready');
  await detail(page, 'Data and source'); await expect(page.locator('aside')).toContainText('Built-in city data');
  const link = await share(page);
  expect(link.searchParams.get('revision')).toMatch(/^[a-f0-9]{64}$/);
  await page.goto(`${link.href}&cache=0`); await expect(status(page)).toContainText('Monaco ready');
  const result = await stats(request);
  expect(result.searches).toHaveLength(0); expect(result.roads).toHaveLength(0); expect(result.datasets).toHaveLength(0);
});

test('broken bundled data fails visibly without switching Open Monaco to Overpass', async ({ page, request }) => {
  await page.route('**/data/v2/cities/**/manifest.json', route => route.fulfill({ json: {} }));
  await page.goto('/'); await page.getByRole('button', { name: 'Open Monaco', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await stats(request)).roads).toHaveLength(0);
});

test('a downloaded design imports its Unicode, palette and view without adding a duplicate save', async ({ page, request }) => {
  await page.goto('/'); await sample(page);
  await page.getByLabel('Label text').fill('Imported 東京 & <Map>');
  await page.getByRole('button', { name: 'Night', exact: true }).click();
  const expected = await share(page);
  await page.getByRole('button', { name: 'Save design', exact: true }).click();
  await detail(page, 'Saved designs');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export settings Imported 東京 & <Map>', exact: true }).click();
  const file = await pending, buffer = await readFile((await file.path())!);
  await sample(page, 'Medium');
  const input = page.getByLabel('Import design file');
  await input.setInputFiles({ name: 'saved.citymap.json', mimeType: 'application/json', buffer });
  await expect(label(page)).toHaveText('Imported 東京 & <Map>'); await expect(status(page)).toContainText('ready');
  await expect(page.getByLabel('Road color')).toHaveValue('#e1e7d9');
  expect((await share(page)).searchParams.get('view')).toBe(expected.searchParams.get('view'));
  expect(await input.inputValue()).toBe('');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('citymap:designs:v1')!).length)).toBe(1);
  expect((await stats(request)).roads).toHaveLength(0);
});

for (const [name, buffer, message] of [
  ['broken.json', Buffer.from('{'), 'not a readable JSON'],
  ['future.json', Buffer.from(JSON.stringify({ format: 'citymap-design', version: 2 })), 'unsupported design format'],
  ['large.json', Buffer.alloc(64 * 1024 + 1, 32), '64 KB or smaller'],
] as const) test(`invalid design ${name} leaves the current map available`, async ({ page, request }) => {
  await page.goto('/'); await sample(page);
  await page.getByLabel('Import design file').setInputFiles({ name, mimeType: 'application/json', buffer });
  await expect(page.locator('.design-import').getByRole('alert')).toContainText(message);
  await expect(label(page)).toHaveText('Small synthetic grid');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  expect((await stats(request)).roads).toHaveLength(0);
});

test('switching maps while a file is being read prevents a late import from replacing it', async ({ page }) => {
  await page.addInitScript(() => {
    File.prototype.text = function() { return new Promise(resolve => { Object.defineProperty(window, 'finishDesignRead', { configurable: true, value: resolve }); }); };
  });
  await page.goto('/'); await sample(page);
  const file = await page.evaluate(async () => {
    const path = '/src/lib/design-file.ts', { designFile } = await import(path);
    const domainPath = '/src/lib/domain.ts', { DEFAULT_DESIGN } = await import(domainPath);
    return designFile({ id: 'test', name: 'Late', savedAt: '', boundary: { key: 'fixture-small', name: 'Late map', kind: 'synthetic', fixture: 'small' }, design: { ...DEFAULT_DESIGN, label: { ...DEFAULT_DESIGN.label, text: 'Late import' } } }, location.origin, '/');
  });
  await page.getByLabel('Import design file').setInputFiles({ name: 'late.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { finishDesignRead?: unknown }).finishDesignRead)).toBe('function');
  await sample(page, 'Medium');
  await page.evaluate(value => (window as unknown as { finishDesignRead: (value: string) => void }).finishDesignRead(value), file);
  await expect(page.getByRole('button', { name: 'Import design', exact: true })).toBeEnabled();
  await expect(label(page)).toHaveText('Medium synthetic grid');
});

test('saved maps can be renamed and updated in place while their map label stays independent', async ({ page }) => {
  await page.goto('/'); await sample(page);
  await page.getByRole('button', { name: 'Save design', exact: true }).click();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('citymap:designs:v1')!)[0].id);
  await detail(page, 'Saved designs');
  await page.getByRole('button', { name: 'Rename design Small synthetic grid', exact: true }).click();
  await expect(page.getByLabel('Saved design name')).toBeFocused();
  await page.getByLabel('Saved design name').fill('   ');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('.saved').locator('..').getByRole('alert')).toContainText('Enter a saved design name');
  await page.getByLabel('Saved design name').fill('My 東京 poster');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(label(page)).toHaveText('Small synthetic grid');
  await page.getByLabel('Label text').fill('Updated map label');
  await page.getByRole('button', { name: 'Update saved design', exact: true }).click();
  await expect(status(page)).toContainText('Saved design updated');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('citymap:designs:v1')!));
  expect(saved).toHaveLength(1); expect(saved[0].id).toBe(id); expect(saved[0].name).toBe('My 東京 poster');
  expect(saved[0].design.label.text).toBe('Updated map label');
  await page.goto('/'); await detail(page, 'Saved designs');
  await page.getByRole('button', { name: 'My 東京 poster', exact: true }).click();
  await expect(status(page)).toContainText('ready'); await expect(label(page)).toHaveText('Updated map label');
  await expect(page.locator('.saved time')).toBeVisible();
});

test('a failed saved-design deletion remains visible and can still be exported', async ({ page }) => {
  await page.goto('/'); await sample(page); await page.getByRole('button', { name: 'Save design', exact: true }).click();
  await detail(page, 'Saved designs');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Denied', 'SecurityError'); }; });
  await page.getByRole('button', { name: 'Delete design Small synthetic grid', exact: true }).click();
  await expect(page.locator('.saved').locator('..').getByRole('alert')).toContainText('could not be deleted');
  await expect(page.locator('.saved')).toHaveCount(1);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export settings Small synthetic grid', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.citymap\.json$/);
});
