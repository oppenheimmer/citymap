import { SceneController, color } from './SceneController.ts';
import type { SceneSnapshot } from './SceneController.ts';
import type { Geometry } from './domain.ts';
import { EXPORT_BORDER, placeMarks } from './marks.ts';
import type { Centre, Size } from './marks.ts';
import { NORTH_ARROW } from './north-arrow.ts';
import { fittedWidth, metresPerSceneUnit, scaleBar, SCALE_BAR } from './scale-bar.ts';
import { gridDrawing } from './graticule.ts';
import type { GridDrawing, GridOptions } from './graticule.ts';
import { fitCamera } from './view.ts';
export { download } from './download.ts';

export interface ExportOptions { width: number; height: number; transparent: boolean; grid: GridOptions }
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
    worker.postMessage({ type: 'start', ...options, camera: snapshot.camera, design: snapshot.design, centre: { lon: snapshot.view.lon, lat: snapshot.view.lat }, scale, labelSize: snapshot.design.label.size * scale, strokeWidth: scale / snapshot.pixelRatio });
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

function drawGrid(context: CanvasRenderingContext2D, grid: GridDrawing, ink: string) {
  context.save();
  context.strokeStyle = context.fillStyle = ink; context.lineWidth = grid.lineWidth;
  const stroke = (lines: GridDrawing['lines'], alpha: number) => {
    if (!lines.length) return;
    context.globalAlpha = alpha; context.beginPath();
    for (const line of lines) { context.moveTo(line.x1, line.y1); context.lineTo(line.x2, line.y2); }
    context.stroke();
  };
  stroke(grid.lines, grid.lineOpacity); stroke(grid.teeth, 1);
  context.globalAlpha = 1; context.font = `${grid.font}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const text of grid.texts) {
    context.save(); context.translate(text.x, text.y); context.rotate(text.angle * Math.PI / 180);
    context.fillText(text.text, 0, 0);
    context.restore();
  }
  context.restore();
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
    // Coordinate grid above the roads, below the label and marks.
    // The export's own framing sets its scale; one CSS pixel is `scale` export pixels.
    const bar = snapshot.design.scaleBar ? scaleBar(fittedWidth(snapshot.camera, options.width / options.height) / options.width * metresPerSceneUnit(snapshot.view.lat) * scale) : undefined;
    const area = { width: options.width, height: options.height };
    const grid = gridDrawing(fitCamera(snapshot.camera, options.width / options.height), snapshot.view, options.width, options.height, scale, options.grid, EXPORT_BORDER, snapshot.design.rotation || 0);
    if (grid) drawGrid(context, grid, snapshot.design.roadColor);
    // Marks and the label move inward a few pixels when they would cover grid teeth or labels.
    const placed = placeMarks(snapshot.design, area, scale, bar, grid?.keepouts, 4 * Math.max(1, scale));
    const c = color(label.color, label.opacity);
    context.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
    context.font = `${label.size * scale}px sans-serif`;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(label.text, placed.label.x, placed.label.y);
    // Marks are CSS-pixel geometry, laid out as on screen and scaled to the export.
    const ink = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    const mark = (centre: Centre, size: Size, draw: () => void) => {
      context.save();
      context.translate(centre.x - size.width * scale / 2, centre.y - size.height * scale / 2); context.scale(scale, scale);
      context.fillStyle = context.strokeStyle = ink; context.textAlign = 'center'; context.textBaseline = 'middle';
      draw();
      context.restore();
    };
    if (snapshot.design.north) mark(placed.north, NORTH_ARROW, () => {
      const { path, circles, stroke, letter, cx, cy } = NORTH_ARROW;
      // Turn with the map so it points to map north.
      context.translate(cx, cy); context.rotate((snapshot.design.rotation || 0) * Math.PI / 180); context.translate(-cx, -cy);
      context.lineWidth = stroke; context.lineJoin = 'round'; context.lineCap = 'round';
      const rose = new Path2D(path);
      for (const circle of circles) { rose.moveTo(circle.cx + circle.r, circle.cy); rose.arc(circle.cx, circle.cy, circle.r, 0, 2 * Math.PI); }
      context.stroke(rose);
      context.font = `bold ${letter.size}px sans-serif`;
      context.fillText('N', letter.x, letter.y);
    });
    if (bar && placed.scaleBar) mark(placed.scaleBar, bar, () => {
      context.lineWidth = SCALE_BAR.stroke; context.lineCap = 'square';
      context.beginPath();
      for (const line of bar.lines) { context.moveTo(line.x1, line.y1); context.lineTo(line.x2, line.y2); }
      context.stroke();
      context.font = `${SCALE_BAR.font}px sans-serif`;
      for (const text of bar.texts) context.fillText(text.text, text.x, text.y);
    });
    context.strokeStyle = snapshot.design.roadColor; context.lineWidth = EXPORT_BORDER;
    context.strokeRect(EXPORT_BORDER / 2, EXPORT_BORDER / 2, options.width - EXPORT_BORDER, options.height - EXPORT_BORDER);
    return await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'));
  } finally { controller?.dispose(); }
}
