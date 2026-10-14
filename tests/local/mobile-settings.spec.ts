import { readFile } from 'node:fs/promises';
import { test, expect, sample, detail, label, slider, share, status, control, stats } from '../support/local.ts';

test('saved settings download preserves the design and its portable restore link', async ({ page }) => {
  await page.goto('/'); await sample(page);
  await page.getByLabel('Label text').fill('Saved 東京 & <Map>'); await page.getByRole('button',{name:'Night',exact:true}).click();
  await slider(page,'Label size',48); await label(page).focus(); await page.keyboard.press('Shift+ArrowLeft');
  const expected = await share(page);
  await page.getByRole('button',{name:'Save design',exact:true}).click(); await page.goto('/'); await detail(page,'Saved designs');
  const pending = page.waitForEvent('download'); await page.getByRole('button',{name:'Export settings Saved 東京 & <Map>',exact:true}).click();
  const file = await pending; expect(file.suggestedFilename()).toMatch(/\.citymap\.json$/);
  const settings = JSON.parse((await readFile((await file.path())!)).toString('utf8'));
  expect(settings.format).toBe('citymap-design'); expect(settings.version).toBe(1);
  expect(settings.design.label.text).toBe('Saved 東京 & <Map>'); expect(settings.design.label.size).toBe(48);
  expect(new URL(settings.link).searchParams.get('view')).toBe(expected.searchParams.get('view'));
  await page.goto(settings.link); await expect(status(page)).toContainText('ready');
  await expect(label(page)).toHaveText('Saved 東京 & <Map>'); await expect(page.getByLabel('Road color')).toHaveValue('#e1e7d9');
});

test.describe('mobile sheet', () => {
  test.use({viewport:{width:390,height:844},hasTouch:true,isMobile:process.env.PLAYWRIGHT_BROWSER !== 'firefox',deviceScaleFactor:2});
  test('settings scroll independently, collapsing expands the map, and desktop resize restores controls', async ({ page }) => {
    await page.goto('/'); await sample(page);
    const before = (await page.locator('canvas').boundingBox())!;
    await page.locator('aside').evaluate(aside => { aside.scrollTop = aside.scrollHeight; });
    const scrolled = (await page.locator('canvas').boundingBox())!; expect(scrolled.y).toBe(before.y); expect(scrolled.height).toBe(before.height);
    await page.getByRole('button',{name:'Hide controls',exact:true}).tap();
    await expect(page.getByRole('button',{name:'Show controls',exact:true})).toHaveAttribute('aria-expanded','false');
    await expect(page.getByLabel('Find a city')).not.toBeVisible();
    await expect.poll(async () => (await page.locator('canvas').boundingBox())!.height).toBeGreaterThan(before.height);
    await page.setViewportSize({width:1000,height:750}); await expect(page.getByLabel('Find a city')).toBeVisible();
    await page.setViewportSize({width:390,height:844}); await page.getByRole('button',{name:'Show controls',exact:true}).tap();
    await expect(page.getByLabel('Find a city')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  });
  test('the open sheet shows the whole composed map, and links and exports keep it', async ({ page }) => {
    await page.goto('/'); await sample(page);
    const canvas = page.locator('canvas'), frame = page.locator('.map .frame');
    const view = async () => (await share(page)).searchParams.get('view')!.split(',').map(Number);
    const before = await view();
    // The composed map is the map area with the sheet collapsed, shown whole and smaller above the open sheet.
    const open = (await canvas.boundingBox())!, shown = (await frame.boundingBox())!;
    expect(shown.height).toBeCloseTo(open.height, 0); expect(shown.width / shown.height).toBeCloseTo(390 / (844 - 96), 2);
    expect(shown.x - open.x).toBeCloseTo(open.x + open.width - shown.x - shown.width, 0);
    await expect(frame).not.toHaveCSS('box-shadow', 'none');
    await page.getByRole('button',{name:'Export',exact:true}).click();
    await expect(page.getByLabel('Width in pixels')).toHaveValue('780'); await expect(page.getByLabel('Height in pixels')).toHaveValue(String(2 * (844 - 96)));
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Hide controls',exact:true}).tap();
    await expect.poll(async () => (await canvas.boundingBox())!.height).toBe(844 - 96);
    expect(await frame.boundingBox()).toEqual(await canvas.boundingBox()); await expect(frame).toHaveCSS('box-shadow', 'none');
    await page.getByRole('button',{name:'Show controls',exact:true}).tap();
    (await view()).forEach((value, index) => expect(value).toBeCloseTo(before[index], index < 2 ? 5 : 1));
  });
  test('a collapsed sheet keeps cancellation available and error recovery opens the controls', async ({ page, request }) => {
    await control(request,{roads:{hold:true}}); await page.goto('/?q=Held&areaId=3600000101&cache=0');
    await page.getByRole('button',{name:'Load roads',exact:true}).click(); await expect.poll(async () => (await stats(request)).roads.length).toBe(1);
    await page.getByRole('button',{name:'Hide controls',exact:true}).tap();
    await page.getByRole('button',{name:'Cancel load',exact:true}).tap(); await expect(page.locator('.sheet-status')).toContainText('cancelled');
    await page.getByRole('button',{name:'Show controls',exact:true}).tap();
    await control(request,{roads:{body:{elements:[]}}}); await page.getByRole('button',{name:'Load roads',exact:true}).click();
    await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('button',{name:'Hide controls',exact:true})).toBeVisible();
  });
});
