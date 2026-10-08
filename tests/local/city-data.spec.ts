import { readFile } from 'node:fs/promises';
import { test, expect, status, detail, share, stats, control } from '../support/local.ts';

const city = '/?q=Monaco&osm_type=relation&osm_id=1124039&auto=1';

test('a real offline-extract city decodes actual gzip delivery, exports every segment and pins its revision', async ({ page, request }, testInfo) => {
  await page.goto(city); await expect(status(page)).toContainText('Monaco ready');
  await detail(page,'Load timings'); await expect(page.locator('aside')).toContainText('15,369 segments');
  await detail(page,'Data and source'); await expect(page.locator('aside')).toContainText('R2 cache');
  const calls = await stats(request); expect(calls.roads).toHaveLength(0); expect(calls.datasets.filter(key => key.endsWith('.pbf'))).toHaveLength(10);
  const link = await share(page); expect(link.searchParams.get('revision')).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole('button',{ name:'Export', exact:true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button',{ name:'Download SVG', exact:true }).click();
  const file = await pending, bytes = await readFile((await file.path())!);
  expect((bytes.toString('utf8').match(/M[-0-9]/g) || []).length).toBe(15369);
  expect(bytes.toString('utf8')).toContain('OpenStreetMap contributors');
  await testInfo.attach('monaco.svg',{ body:bytes, contentType:'image/svg+xml' });
  await page.getByRole('button',{ name:'Close', exact:true }).click();
  await page.getByRole('button',{ name:'Clear city cache', exact:true }).click();
  const before = (await stats(request)).datasets.length;
  await page.goto(link.href); await expect(status(page)).toContainText('Monaco ready');
  expect((await stats(request)).datasets.slice(before).some(key => key.endsWith('latest.json'))).toBe(false);
});

test('corrupt real-city decoded bytes fail visibly without live fallback or exports', async ({ page, request }) => {
  await control(request,{ corruptData:true }); await page.goto(city);
  await expect(page.getByRole('alert')).toContainText('checksum');
  await expect(page.getByRole('button',{ name:'Export', exact:true })).toBeDisabled();
  expect((await stats(request)).roads).toHaveLength(0);
  await control(request,{ corruptData:false }); await page.getByRole('button',{ name:'Retry map', exact:true }).click();
  await expect(status(page)).toContainText('Monaco ready');
});
