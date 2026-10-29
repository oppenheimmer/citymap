import { test, expect } from '@playwright/test';

test('the built cache manager clears map data while preserving saved designs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/cache*', route => route.fulfill({ json: { configured: false } }));
  await page.goto('/');
  await page.getByText('Try a sample map', { exact: true }).click();
  await page.getByRole('button', { name: 'Small sample', exact: true }).click();
  await expect(page.locator('aside [role=status]')).toContainText('ready');
  await expect.poll(() => page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(db => db.name === 'citymap-geometry')) return 0;
    return new Promise<number>((resolve, reject) => {
    const opened = indexedDB.open('citymap-geometry', 1);
    opened.onsuccess = () => {
      const db = opened.result;
      if (!db.objectStoreNames.contains('cities')) { db.close(); resolve(0); return; }
      const count = db.transaction('cities').objectStore('cities').count();
      count.onsuccess = () => { db.close(); resolve(count.result); }; count.onerror = () => reject(count.error);
    };
    opened.onerror = () => reject(opened.error);
    });
  })).toBe(1);
  await page.getByRole('button', { name: 'Save design', exact: true }).click();
  const saved = await page.evaluate(() => localStorage.getItem('citymap:designs:v1'));
  await page.getByRole('button', { name: 'Manage cached maps' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cached maps', exact: true });
  await expect(dialog.getByRole('list', { name: 'Local cached maps' }).getByRole('listitem')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Clear all local maps', exact: true }).click();
  await expect(dialog).toContainText('Road fragments cleared. Designs are preserved.');
  await expect(dialog.getByRole('list', { name: 'Local cached maps' }).getByRole('listitem')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('citymap:designs:v1'))).toBe(saved);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});
