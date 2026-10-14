import { SceneController, color } from './SceneController.ts';
import type { SceneSnapshot } from './SceneController.ts';
import type { Geometry, MapFont } from './domain.ts';
import { canvasFont, embeddedFonts, exportFaces, labelWidth, loadFonts } from './fonts.ts';
import { EXPORT_LIMITS } from './export-size.ts';
import { EXPORT_BORDER, placeMarks } from './marks.ts';
import type { Centre, Size } from './marks.ts';
import { NORTH_ARROW } from './north-arrow.ts';
import { fittedWidth, metresPerSceneUnit, scaleBar, SCALE_BAR } from './scale-bar.ts';
import { gridDrawing } from './graticule.ts';
import type { GridDrawing, GridOptions } from './graticule.ts';
import { fitCamera } from './view.ts';
export { download } from './download.ts';

export interface ExportOptions { width: number; height: number; transparent: boolean; grid: GridOptions }
export function checkDimensions(options: ExportOptions) {
  const { min, max, pixels } = EXPORT_LIMITS;
  if (!Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) || options.width < min || options.height < min || options.width > max || options.height > max || options.width * options.height > pixels) throw new Error('Export dimensions must be 256–8192 pixels and at most 16 megapixels.');
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
    // The chosen typeface travels inside the file, so viewers without it draw the same text.
    const faces = exportFaces(snapshot.design, options.grid.mode !== 'none');
    const fonts = await embeddedFonts(snapshot.design.font, faces, signal);
    // The label is measured with the same typeface, so it fits the map as on screen.
    await loadFonts(snapshot.design.font, faces);
    signal?.throwIfAborted();
    worker.postMessage({ type: 'start', ...options, camera: snapshot.camera, design: snapshot.design, centre: { lon: snapshot.view.lon, lat: snapshot.view.lat }, scale, labelWidth: labelWidth(snapshot.design), strokeWidth: scale / snapshot.pixelRatio, fonts }, fonts.map(font => font.bytes));
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

function drawGrid(context: CanvasRenderingContext2D, grid: GridDrawing, ink: string, font: MapFont) {
  context.save();
  context.strokeStyle = context.fillStyle = ink; context.lineWidth = grid.lineWidth;
  const stroke = (lines: GridDrawing['lines'], alpha: number) => {
    if (!lines.length) return;
    context.globalAlpha = alpha; context.beginPath();
    for (const line of lines) { context.moveTo(line.x1, line.y1); context.lineTo(line.x2, line.y2); }
    context.stroke();
  };
  stroke(grid.lines, grid.lineOpacity); stroke(grid.teeth, 1);
  context.globalAlpha = 1; context.font = canvasFont(font, { weight: 400, italic: false }, grid.font); context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const text of grid.texts) {
    context.save(); context.translate(text.x, text.y); context.rotate(text.angle * Math.PI / 180);
    context.fillText(text.text, 0, 0);
    context.restore();
  }
  context.restore();
}

export async function exportMap(snapshot: SceneSnapshot, options: ExportOptions, format: 'png' | 'svg', signal?: AbortSignal): Promise<Blob> {
  checkDimensions(options);
  await document.fonts.ready;
  signal?.throwIfAborted();
  if (format === 'svg') return svg(snapshot, options, signal);
  // Canvas text draws with whatever font is ready, so load each face it uses first.
  const font = snapshot.design.font;
  await loadFonts(font, exportFaces(snapshot.design, options.grid.mode !== 'none'));
  signal?.throwIfAborted();
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
    if (grid) drawGrid(context, grid, snapshot.design.roadColor, font);
    // Marks and the label move inward a few pixels when they would cover grid teeth or labels.
    const placed = placeMarks(snapshot.design, area, scale, bar, grid?.keepouts, 4 * Math.max(1, scale), labelWidth(snapshot.design));
    const c = color(label.color, label.opacity);
    context.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
    context.font = canvasFont(font, { weight: label.bold ? 700 : 400, italic: !!label.italic }, placed.labelSize);
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
      context.font = canvasFont(font, { weight: 700, italic: false }, letter.size);
      context.fillText('N', letter.x, letter.y);
    });
    if (bar && placed.scaleBar) mark(placed.scaleBar, bar, () => {
      context.lineWidth = SCALE_BAR.stroke; context.lineCap = 'square';
      context.beginPath();
      for (const line of bar.lines) { context.moveTo(line.x1, line.y1); context.lineTo(line.x2, line.y2); }
      context.stroke();
      context.font = canvasFont(font, { weight: 400, italic: false }, SCALE_BAR.font);
      for (const text of bar.texts) context.fillText(text.text, text.x, text.y);
    });
    context.strokeStyle = snapshot.design.roadColor; context.lineWidth = EXPORT_BORDER;
    context.strokeRect(EXPORT_BORDER / 2, EXPORT_BORDER / 2, options.width - EXPORT_BORDER, options.height - EXPORT_BORDER);
    return await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'));
  } finally { controller?.dispose(); }
}
