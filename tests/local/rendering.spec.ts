import { test, expect, sample, detail, status } from '../support/local.ts';
import type { Page } from '@playwright/test';

interface RenderProbe {
  uploads: { bytes: number; offset: number; offscreen: boolean }[];
  frames: number[];
  arm?: 'map' | 'png';
  holding: boolean;
  held?: FrameRequestCallback;
  contexts: WebGLRenderingContext[];
}
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: RenderProbe = { uploads: [], frames: [], holding: false, contexts: [] };
    Object.defineProperty(window, 'renderProbe', { value: probe });
    const upload = WebGLRenderingContext.prototype.bufferData;
    let holdNext = false;
    WebGLRenderingContext.prototype.bufferData = function(this: WebGLRenderingContext, ...args: Parameters<typeof upload>) {
      const data = args[1];
      if (data instanceof Float32Array && data.byteLength >= 16 && data.length !== 12) {
        const offscreen = !(this.canvas as HTMLCanvasElement).isConnected;
        probe.uploads.push({ bytes: data.byteLength, offset: data.byteOffset, offscreen });
        if (!probe.contexts.includes(this)) probe.contexts.push(this);
        if (probe.arm === (offscreen ? 'png' : 'map')) { probe.arm = undefined; holdNext = true; }
      }
      upload.apply(this, args);
    } as typeof upload;
    const clear = WebGLRenderingContext.prototype.clear, draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.clear = function(this: WebGLRenderingContext, ...args: Parameters<typeof clear>) {
      if ((this.canvas as HTMLCanvasElement).isConnected) probe.frames.push(0);
      clear.apply(this, args);
    };
    WebGLRenderingContext.prototype.drawArrays = function(this: WebGLRenderingContext, ...args: Parameters<typeof draw>) {
      if ((this.canvas as HTMLCanvasElement).isConnected && args[0] === this.LINES) probe.frames[probe.frames.length - 1] += args[2] / 2;
      draw.apply(this, args);
    };
    const frame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => {
      if (holdNext) { holdNext = false; probe.holding = true; probe.held = callback; return 0; }
      return frame(callback);
    };
  });
}
const probe = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as { renderProbe: RenderProbe }).renderProbe;
  return { uploads: p.uploads, frames: p.frames, holding: p.holding, liveContexts: p.contexts.filter(context => !context.isContextLost()).length };
});
const arm = (page: Page, kind: 'map' | 'png') => page.evaluate(value => { (window as unknown as { renderProbe: RenderProbe }).renderProbe.arm = value; }, kind);
const release = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as { renderProbe: RenderProbe }).renderProbe;
  p.holding = false; const callback = p.held; p.held = undefined; callback?.(performance.now());
});

// The large sample has 32,768 primary (major) and 229,376 residential (street) segments,
// delivered as one buffer per road rank with major roads first.
test('large maps upload bounded views once and draw every segment across progressive frames', async ({ page }) => {
  await installProbe(page); await page.goto('/'); await sample(page, 'Large');
  const p = await probe(page), uploads = p.uploads.filter(upload => !upload.offscreen);
  expect(uploads.map(upload => upload.bytes)).toEqual([524_288, 1_048_576, 1_048_576, 1_048_576, 524_288]);
  expect(uploads.map(upload => upload.offset)).toEqual([0, 0, 1_048_576, 2_097_152, 3_145_728]);
  expect(p.frames).toEqual(expect.arrayContaining([32_768, 98_304, 163_840, 229_376, 262_144]));
  expect(Math.max(...p.frames)).toBe(262_144);
});

test('hidden road classes cost no uploads until shown, then upload once', async ({ page }) => {
  await installProbe(page); await page.goto('/?detail=major'); await sample(page, 'Large');
  const visible = async () => (await probe(page)).uploads.filter(upload => !upload.offscreen).map(upload => upload.bytes);
  expect(await visible()).toEqual([524_288]);
  await page.getByLabel('Roads shown').selectOption('streets');
  await expect.poll(visible).toEqual([524_288, 1_048_576, 1_048_576, 1_048_576, 524_288]);
  await page.getByLabel('Roads shown').selectOption('major'); await page.getByLabel('Roads shown').selectOption('all');
  await expect.poll(async () => Math.max(...(await probe(page)).frames)).toBe(262_144);
  expect(await visible()).toHaveLength(5);
});

test('cancelling during a held map upload stops later batches and switching recovers', async ({ page }) => {
  await installProbe(page); await page.goto('/'); await arm(page, 'map'); await detail(page, 'Try a sample map');
  await page.getByRole('button', { name: 'Large sample', exact: true }).click();
  await expect.poll(async () => (await probe(page)).holding).toBe(true);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel load', exact: true }).click(); await expect(status(page)).toContainText('cancelled');
  await expect.poll(async () => (await probe(page)).liveContexts).toBe(0);
  await release(page); await sample(page);
  expect((await probe(page)).uploads.map(upload => upload.bytes)).toEqual([524_288, 1024, 7168]);
  await expect.poll(async () => (await probe(page)).liveContexts).toBe(1);
});

test('PNG uploads are bounded, cancellation releases its context and a complete retry downloads', async ({ page }) => {
  await installProbe(page); await page.goto('/'); await sample(page, 'Large');
  const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Width in pixels').fill('1024'); await page.getByLabel('Height in pixels').fill('768');
  await arm(page, 'png'); await page.getByRole('button', { name: 'Download PNG', exact: true }).click();
  await expect.poll(async () => (await probe(page)).holding).toBe(true);
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect.poll(async () => (await probe(page)).liveContexts).toBe(1);
  await release(page);
  await expect.poll(async () => (await probe(page)).liveContexts).toBe(1); expect(downloads).toEqual([]);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PNG', exact: true }).click(); await pending;
  const uploads = (await probe(page)).uploads.filter(upload => upload.offscreen);
  expect(uploads.map(upload => upload.bytes)).toEqual([524_288, 524_288, 1_048_576, 1_048_576, 1_048_576, 524_288]);
  await expect.poll(async () => (await probe(page)).liveContexts).toBe(1); expect(downloads).toHaveLength(1);
});
