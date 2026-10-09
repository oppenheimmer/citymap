import { createScene } from 'w-gl';
import type { Scene } from 'w-gl';
import { OwnedWireCollection } from './OwnedWireCollection.ts';
import { detailRank } from './domain.ts';
import type { Camera, Design, GeoView, Geometry, RoadRank } from './domain.ts';
import { cameraFromView, viewFromCamera } from './view.ts';

export function color(hex: string, alpha = 1) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Invalid color');
  return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: alpha };
}
export function copyDesign(settings: Design): Design { return { ...settings, label: { ...settings.label }, view: settings.view ? { ...settings.view } : undefined }; }
export interface SceneSnapshot { buffers: Float32Array[]; bounds: Camera; camera: Camera; design: Design; width: number; height: number; pixelRatio: number }
export interface SceneOptions {
  /** Called with the data-independent view after camera and size changes. */
  onView?: (view: GeoView) => void;
  /** Fixed-size offscreen rendering, such as PNG export. */
  fixedSize?: { width: number; height: number };
  lineWidth?: number;
  /** Scene camera to show instead of the design's geographic view. */
  camera?: Camera;
}
const UPLOAD_FLOATS = 262_144; // 1 MiB, aligned to complete four-float segments.

export class SceneController {
  readonly renderer: Scene;
  readonly canvas: HTMLCanvasElement;
  readonly geometry: Geometry;
  private collections: OwnedWireCollection[] = [];
  private disposed = false;
  private observer: ResizeObserver;
  private settings: Design;
  private onTransform: (() => void) | undefined;
  private lineWidth: number;
  private frameWaits = new Set<() => void>();

  constructor(canvas: HTMLCanvasElement, geometry: Geometry, settings: Design, { onView, fixedSize, lineWidth = 1, camera }: SceneOptions = {}) {
    this.canvas = canvas;
    this.settings = copyDesign(settings);
    this.lineWidth = lineWidth;
    this.geometry = { ...geometry, buffers: [], ranks: [] };
    if (!canvas.getContext('webgl', { alpha: true, antialias: true })) throw new Error('WebGL unavailable. Try a browser with hardware acceleration enabled.');
    this.renderer = createScene(canvas, { devicePixelRatio: fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, 2), allowRotation: false, allowPinchRotation: false, size: fixedSize });
    this.geometry.segmentCount = 0;
    geometry.buffers.forEach((buffer, index) => this.append(buffer, geometry.ranks[index] ?? 0));
    this.applyColors(settings);
    this.setCamera(camera || (settings.view ? cameraFromView(settings.view, geometry.origin) : geometry.bounds));
    this.onTransform = onView ? () => onView(this.view()) : undefined;
    if (this.onTransform) this.renderer.on('transform', this.onTransform);
    // Leave browser zoom shortcuts available while the canvas has focus.
    canvas.addEventListener('wheel', this.browserWheel, { capture: true });
    canvas.addEventListener('keydown', this.browserKeys, { capture: true });
    this.observer = new ResizeObserver(() => {
      if (this.disposed || fixedSize) return;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.renderFrame();
      onView?.(this.view());
    });
    if (!fixedSize) this.observer.observe(canvas);
  }

  private browserWheel = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.stopImmediatePropagation(); };
  private browserKeys = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key)) event.stopImmediatePropagation(); };

  private hidden(rank: RoadRank) { return rank > detailRank(this.settings.detail); }

  append(positions: Float32Array, rank: RoadRank = 0) {
    if (this.disposed || !positions.length || positions.length % 4) throw new Error('Invalid geometry');
    const collection = new OwnedWireCollection(positions, this.lineWidth, rank);
    collection.color = color(this.settings.roadColor, this.settings.roadOpacity);
    collection.hidden = this.hidden(rank);
    this.collections.push(collection);
    this.geometry.buffers.push(positions);
    this.geometry.ranks.push(rank);
    this.geometry.segmentCount += positions.length / 4;
    this.renderer.appendChild(collection);
    this.renderer.renderFrame();
  }

  async appendGeometry(positions: Float32Array, rank: RoadRank = 0, signal?: AbortSignal): Promise<number | undefined> {
    if (!positions.length || positions.length % 4) throw new Error('Invalid geometry');
    let firstFrameAt: number | undefined;
    const hidden = this.hidden(rank);
    for (let offset = 0; offset < positions.length; offset += UPLOAD_FLOATS) {
      signal?.throwIfAborted();
      if (this.disposed) return firstFrameAt;
      this.append(positions.subarray(offset, offset + UPLOAD_FLOATS), rank);
      // Hidden road classes upload only when shown, so they cost no frames now.
      if (hidden) continue;
      // Draw this batch before yielding, rather than accumulating one large upload.
      this.render();
      await this.nextFrame(signal);
      firstFrameAt ??= performance.now();
    }
    signal?.throwIfAborted();
    return firstFrameAt;
  }

  private nextFrame(signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        cancelAnimationFrame(token);
        signal?.removeEventListener('abort', finish);
        this.frameWaits.delete(finish);
        resolve();
      };
      const token = requestAnimationFrame(finish);
      this.frameWaits.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (this.disposed || signal?.aborted) finish();
    });
  }

  setSettings(settings: Design) {
    const changed = settings.roadColor !== this.settings.roadColor || settings.roadOpacity !== this.settings.roadOpacity || settings.backgroundColor !== this.settings.backgroundColor || settings.backgroundOpacity !== this.settings.backgroundOpacity;
    const detailChanged = settings.detail !== this.settings.detail;
    this.settings = copyDesign(settings);
    if (changed) this.applyColors(settings);
    if (detailChanged) {
      for (const collection of this.collections) collection.hidden = this.hidden(collection.rank);
      this.renderer.renderFrame();
    }
  }
  private applyColors(settings: Design) {
    const lineColor = color(settings.roadColor, settings.roadOpacity);
    this.collections.forEach(collection => { collection.color = lineColor; });
    const c = color(settings.backgroundColor, settings.backgroundOpacity);
    this.renderer.setClearColor(c.r * c.a, c.g * c.a, c.b * c.a, c.a);
    this.renderer.renderFrame();
  }

  setCamera(camera: Camera) {
    const { width, height } = this.renderer.getDrawContext();
    const verticalSpan = Math.max(camera.top - camera.bottom, (camera.right - camera.left) / (width / height));
    const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2;
    // w-gl's fit function multiplies its world bounds by DPR. Compensate once here.
    const half = verticalSpan / (2 * this.renderer.getPixelRatio());
    this.renderer.setViewBox({ left: cx, right: cx, top: cy + half, bottom: cy - half });
    this.renderer.renderFrame();
  }
  fit() { this.setCamera(this.geometry.bounds); }
  zoom(factor: number) {
    const camera = this.renderer.getCameraController();
    camera.zoomCenterByScaleFactor(1 - 1 / factor, 0, 0);
    camera.redraw();
  }
  camera(): Camera {
    const rect = this.canvas.getBoundingClientRect();
    const a = this.renderer.getSceneCoordinate(rect.left, rect.top);
    const b = this.renderer.getSceneCoordinate(rect.right, rect.bottom);
    return { left: Math.min(a[0], b[0]), right: Math.max(a[0], b[0]), top: Math.max(a[1], b[1]), bottom: Math.min(a[1], b[1]) };
  }
  /** The current camera as a geographic view that survives different data extents. */
  view(): GeoView { return viewFromCamera(this.camera(), this.geometry.origin); }
  snapshot(): SceneSnapshot {
    const rect = this.canvas.getBoundingClientRect();
    // Exports contain only the road classes currently shown.
    return { buffers: this.geometry.buffers.filter((_buffer, index) => !this.hidden(this.geometry.ranks[index])), bounds: { ...this.geometry.bounds }, camera: this.camera(), design: copyDesign(this.settings), width: rect.width, height: rect.height, pixelRatio: this.renderer.getPixelRatio() };
  }
  render() { this.renderer.renderFrame(true); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const finish of this.frameWaits) finish();
    this.observer.disconnect();
    if (this.onTransform) this.renderer.off('transform', this.onTransform);
    this.canvas.removeEventListener('wheel', this.browserWheel, { capture: true });
    this.canvas.removeEventListener('keydown', this.browserKeys, { capture: true });
    this.renderer.dispose();
    this.collections = [];
    this.geometry.buffers = [];
    this.renderer.getGL().getExtension('WEBGL_lose_context')?.loseContext();
  }
}
