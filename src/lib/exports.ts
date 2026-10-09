import { SceneController, color } from './SceneController.ts';
import type { SceneSnapshot } from './SceneController.ts';
import type { Geometry } from './domain.ts';
import { NORTH_ARROW } from './north-arrow.ts';
export { download } from './download.ts';

export interface ExportOptions { width: number; height: number; transparent: boolean }
function dimensions(options: ExportOptions) {
  if (!Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) || options.width < 256 || options.height < 256 || options.width > 8192 || options.height > 8192 || options.width * options.height > 16_777_216) throw new Error('Export dimensions must be 256–8192 pixels and at most 16 megapixels.');
}
async function svg(snapshot: SceneSnapshot, options: ExportOptions, signal?: AbortSignal): Promise<Blob> {
  const worker = new Worker(new URL('../workers/svg.worker.ts', import.meta.url), { type: 'module' });
  let abort: (() => void) | undefined;
  try {
    const result = new Promise<Blob>((resolve, reject) => {
      worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.blob);
      worker.onerror = () => reject(new Error('Background SVG export failed'));
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
    });
    void result.catch(() => {});
    const scale = options.width / snapshot.width;
    worker.postMessage({ type: 'start', ...options, camera: snapshot.camera, design: snapshot.design, scale, labelSize: snapshot.design.label.size * scale, licenseSize: Math.max(10, 12 * scale), strokeWidth: scale / snapshot.pixelRatio });
    for (const buffer of snapshot.buffers) {
      signal?.throwIfAborted();
      // Bounded copies preserve screen/export geometry ownership and allow UI feedback.
      for (let offset = 0; offset < buffer.length; offset += 262144) {
        const copy = buffer.slice(offset, offset + 262144);
        worker.postMessage({ type: 'geometry', positions: copy.buffer }, [copy.buffer]);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    }
    worker.postMessage({ type: 'finish' });
    return await result;
  } finally { if (abort) signal?.removeEventListener('abort', abort); worker.terminate(); }
}

export async function exportMap(snapshot: SceneSnapshot, options: ExportOptions, format: 'png' | 'svg', signal?: AbortSignal): Promise<Blob> {
  dimensions(options);
  await document.fonts.ready;
  signal?.throwIfAborted();
  if (format === 'svg') return svg(snapshot, options, signal);
  const canvas = document.createElement('canvas');
  canvas.width = options.width; canvas.height = options.height;
  const geometry: Geometry = { buffers: [], ranks: [], coverage: 'all', bounds: snapshot.bounds, origin: [0, 0], segmentCount: 0, source: { kind: 'live', complete: true, downloadedAt: '' } };
  const design = { ...snapshot.design, backgroundOpacity: options.transparent ? 0 : snapshot.design.backgroundOpacity };
  let controller: SceneController | undefined;
  try {
    controller = new SceneController(canvas, geometry, design, { camera: snapshot.camera, fixedSize: { width: options.width, height: options.height }, lineWidth: options.width / snapshot.width / snapshot.pixelRatio });
    for (const buffer of snapshot.buffers) await controller.appendGeometry(buffer, 0, signal);
    signal?.throwIfAborted();
    controller.render();
    const output = document.createElement('canvas');
    output.width = options.width; output.height = options.height;
    const context = output.getContext('2d');
    if (!context) throw new Error('Canvas export is unavailable');
    context.drawImage(canvas, 0, 0);
    const label = snapshot.design.label, scale = options.width / snapshot.width;
    const c = color(label.color, label.opacity);
    context.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
    context.font = `${label.size * scale}px sans-serif`;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(label.text, label.x * options.width, label.y * options.height);
    if (snapshot.design.north) {
      const { width, margin, path, letter } = NORTH_ARROW;
      context.save();
      context.translate(options.width - (margin + width) * scale, margin * scale); context.scale(scale, scale);
      context.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      context.fill(new Path2D(path));
      context.font = `bold ${letter.size}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText('N', letter.x, letter.y);
      context.restore();
    }
    context.font = `${Math.max(10, 12 * scale)}px sans-serif`; context.textAlign = 'right';
    context.strokeStyle = '#ffffff'; context.lineWidth = Math.max(10, 12 * scale) / 6;
    context.strokeText('© OpenStreetMap contributors', options.width * 0.97, options.height * 0.97);
    context.fillStyle = '#303030';
    context.fillText('© OpenStreetMap contributors', options.width * 0.97, options.height * 0.97);
    return await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'));
  } finally { controller?.dispose(); }
}
