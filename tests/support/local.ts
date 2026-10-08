import { test as base, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
export const provider = 'http://127.0.0.1:8091';
export interface Stats { searches: { query: string; userAgent: string; format: string; limit: string }[]; roads: string[]; aborted: number; blocked: string[]; datasets: string[] }
export async function stats(request: APIRequestContext): Promise<Stats> { return (await request.get(`${provider}/__stats`)).json(); }
export async function control(request: APIRequestContext, scenario: unknown) { expect((await request.post(`${provider}/__control`, { data: scenario })).ok()).toBe(true); }
export const status = (page: Page) => page.locator('aside [role=status]');
export const label = (page: Page) => page.getByRole('button', { name: 'Move map label with arrow keys or drag' });
export async function sample(page: Page, size = 'Small') {
  await detail(page, 'Try a sample map');
  await page.getByRole('button', { name: `${size} sample`, exact: true }).click();
  await expect(status(page)).toContainText('ready');
}
export async function search(page: Page, query: string) { await page.getByLabel('Find a city').fill(query); await page.getByRole('button', { name: 'Search', exact: true }).click(); }
export async function live(page: Page, query: string) { await search(page, query); await page.getByRole('button', { name: `${query}, Japan city · relation`, exact: true }).click(); await expect(status(page)).toContainText('ready'); }
export async function share(page: Page): Promise<URL> { await page.getByRole('button', { name: 'Copy share link', exact: true }).click(); return new URL(await page.getByLabel('Share link').inputValue()); }
export async function detail(page: Page, title: string) { const summary = page.getByText(title, { exact: true }); if (!await summary.evaluate(el => el.parentElement!.hasAttribute('open'))) await summary.click(); }
export async function slider(page: Page, name: string, value: number) { await page.getByLabel(name, { exact: true }).evaluate((el, n) => { (el as HTMLInputElement).value = String(n); el.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
export async function cacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('citymap-geometry', 1);
    open.onsuccess = () => { const db = open.result; if (!db.objectStoreNames.contains('cities')) { db.close(); resolve([]); return; } const query = db.transaction('cities').objectStore('cities').getAllKeys(); query.onsuccess = () => { db.close(); resolve(query.result.map(String)); }; query.onerror = () => { db.close(); reject(query.error); }; };
    open.onerror = () => reject(open.error);
  }));
}
export const test = base.extend<{ localGuard: void }>({
  localGuard: [async ({ context, page, request }, use) => {
    expect((await request.post(`${provider}/__reset`)).ok()).toBe(true);
    const denied = 'http://127.0.0.1:8099/proxy-denial-probe';
    expect((await page.goto(denied))!.status(), 'Browser traffic must pass through the allowlist proxy').toBe(403);
    expect((await stats(request)).blocked).toContain(denied);
    expect((await request.post(`${provider}/__reset`)).ok()).toBe(true);
    const errors: string[] = [], external: string[] = [];
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && !['http://127.0.0.1:8082',provider].includes(url.origin)) external.push(url.origin);
    });
    page.on('pageerror', error => errors.push(error.message));
    await use();
    expect(external, 'The application must never request external services').toEqual([]);
    expect(errors, 'Unhandled browser exceptions').toEqual([]);
  }, { auto: true }],
});
export { expect };
