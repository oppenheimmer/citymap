import { createScene } from 'w-gl';
import type { Scene } from 'w-gl';
import { OwnedWireCollection } from './OwnedWireCollection.ts';
import { detailRank } from './domain.ts';
import type { Camera, Design, GeoView, Geometry, RoadRank } from './domain.ts';
import type { Size } from './marks.ts';
import { cameraFromView, fitCamera, inscribedCamera, viewFromCamera } from './view.ts';
import { visibilityFrame, withinFrame } from './visibility.ts';
import type { VisibilityFrame } from './visibility.ts';

export function color(hex: string, alpha = 1) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Invalid color');
  return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: alpha };
}
export function copyDesign(settings: Design): Design { return { ...settings, label: { ...settings.label }, northAt: { ...settings.northAt }, scaleBarAt: settings.scaleBarAt ? { ...settings.scaleBarAt } : undefined, view: settings.view ? { ...settings.view } : undefined }; }
/**
 * The composed map: `camera` is its frame and `width` × `height` its size in CSS pixels;
 * `view` gives the latitude exports need to measure their scale bar.
 */
export interface SceneSnapshot { buffers: Float32Array[]; bounds: Camera; camera: Camera; view: GeoView; design: Design; width: number; height: number; pixelRatio: number }
export interface SceneOptions {
  /** Called with the data-independent view of the composed frame after camera and size changes. */
  onView?: (view: GeoView) => void;
  /** Fixed-size offscreen rendering, such as PNG export. */
  fixedSize?: { width: number; height: number };
  lineWidth?: number;
  /** Scene camera to show instead of the design's geographic view. */
  camera?: Camera;
  /**
   * What Fit map frames when rotated: the loaded roads, or the geometry bounds. Live maps
   * load by view, so their roads never describe the place to fit.
   */
  fit?: 'roads' | 'bounds';
  /** Estimated road-buffer bytes; offscreen GPU buffers are released before cached geometry. */
  gpuBudgetBytes?: number;
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
  private fitTo: 'roads' | 'bounds';
  /** CSS pixel size of the canvas, which shows exactly the composed map. */
  private area: Size;
  /**
   * What the map is composed around, set by a link, Fit map or a design and moved by
   * gestures. The frame is this in the canvas's shape, so resizing there and back restores it.
   */
  private intent!: Camera;
  /** Set while the scene moves its own camera, so only user gestures move the frame. */
  private showing = false;
  private visibility?: VisibilityFrame;
  private readonly gpuBudgetBytes: number;
  private seen = 0;

  constructor(canvas: HTMLCanvasElement, geometry: Geometry, settings: Design, { onView, fixedSize, lineWidth = 1, camera, fit = 'roads', gpuBudgetBytes = 64 * 1024 * 1024 }: SceneOptions = {}) {
    this.canvas = canvas;
    this.settings = copyDesign(settings);
    this.lineWidth = lineWidth;
    this.fitTo = fit;
    this.gpuBudgetBytes = gpuBudgetBytes;
    this.area = fixedSize ? { ...fixedSize } : this.measure();
    this.geometry = { ...geometry, buffers: [], ranks: [] };
    if (!canvas.getContext('webgl', { alpha: true, antialias: true })) throw new Error('WebGL unavailable. Try a browser with hardware acceleration enabled.');
    this.renderer = createScene(canvas, { devicePixelRatio: fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, 2), allowRotation: false, allowPinchRotation: false, size: fixedSize });
    this.geometry.segmentCount = 0;
    geometry.buffers.forEach((buffer, index) => this.append(buffer, geometry.ranks[index] ?? 0));
    this.applyColors(settings);
    this.setCamera(camera || (settings.view ? cameraFromView(settings.view, geometry.origin) : geometry.bounds));
    // Panning and zooming move and scale the frame with the view.
    this.onTransform = () => {
      if (!this.showing) {
        const before = this.composed, after = inscribedCamera(this.camera(), this.area.width / this.area.height);
        const scale = (after.right - after.left) / (before.right - before.left), cx = (after.left + after.right) / 2, cy = (after.bottom + after.top) / 2;
        const halfWidth = (this.intent.right - this.intent.left) * scale / 2, halfHeight = (this.intent.top - this.intent.bottom) * scale / 2;
        this.intent = { left: cx - halfWidth, right: cx + halfWidth, bottom: cy - halfHeight, top: cy + halfHeight };
      }
      this.updateVisibility();
      onView?.(this.view());
    };
    this.renderer.on('transform', this.onTransform);
    // Leave browser zoom shortcuts available while the canvas has focus.
    canvas.addEventListener('wheel', this.browserWheel, { capture: true });
    canvas.addEventListener('keydown', this.browserKeys, { capture: true });
    this.observer = new ResizeObserver(() => {
      if (this.disposed || fixedSize) return;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      // The frame takes the canvas's new shape around the same map.
      this.area = this.measure();
      this.show();
      onView?.(this.view());
    });
    if (!fixedSize) this.observer.observe(canvas);
  }

  private browserWheel = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.stopImmediatePropagation(); };
  private browserKeys = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key)) event.stopImmediatePropagation(); };

  private hidden(rank: RoadRank) { return rank > detailRank(this.settings.detail); }

  private updateVisibility() {
    const camera = this.composed;
    // Include the stroke and antialiasing outside its centreline, also in large PNGs.
    const margin = Math.max((camera.right - camera.left) / this.area.width, (camera.top - camera.bottom) / this.area.height) * (this.lineWidth + 2);
    this.visibility = visibilityFrame(camera, this.rotation, margin);
  }

  private visible = (collection: OwnedWireCollection) => {
    if (this.visibility && !withinFrame(collection.bounds, this.visibility)) return false;
    collection.lastSeen = ++this.seen;
    if (!collection.resident) this.trimGPU(collection.positions.byteLength);
    return true;
  };

  private trimGPU(incoming = 0) {
    let bytes = incoming;
    const candidates: OwnedWireCollection[] = [];
    for (const collection of this.collections) {
      if (!collection.resident) continue;
      bytes += collection.positions.byteLength;
      if (collection.hidden || this.visibility && !withinFrame(collection.bounds, this.visibility)) candidates.push(collection);
    }
    if (bytes <= this.gpuBudgetBytes) return;
    candidates.sort((a, b) => a.lastSeen - b.lastSeen);
    for (const collection of candidates) {
      collection.releaseGPU(); bytes -= collection.positions.byteLength;
      if (bytes <= this.gpuBudgetBytes) break;
    }
  }

  /** `owner` names a live map region, so its roads can later be removed together. */
  append(positions: Float32Array, rank: RoadRank = 0, owner?: string) {
    if (this.disposed || !positions.length || positions.length % 4) throw new Error('Invalid geometry');
    const collection = new OwnedWireCollection(positions, this.lineWidth, rank, owner, this.visible);
    collection.color = color(this.settings.roadColor, this.settings.roadOpacity);
    collection.hidden = this.hidden(rank);
    this.collections.push(collection);
    this.geometry.buffers.push(positions);
    this.geometry.ranks.push(rank);
    this.geometry.segmentCount += positions.length / 4;
    this.renderer.appendChild(collection);
    this.renderer.renderFrame();
    return collection;
  }

  async appendGeometry(positions: Float32Array, rank: RoadRank = 0, signal?: AbortSignal, owner?: string): Promise<number | undefined> {
    if (!positions.length || positions.length % 4) throw new Error('Invalid geometry');
    let firstFrameAt: number | undefined;
    const hidden = this.hidden(rank);
    for (let offset = 0; offset < positions.length; offset += UPLOAD_FLOATS) {
      signal?.throwIfAborted();
      if (this.disposed) return firstFrameAt;
      const collection = this.append(positions.subarray(offset, offset + UPLOAD_FLOATS), rank, owner);
      // Hidden road classes upload only when shown, so they cost no frames now.
      if (hidden) continue;
      // Draw this batch before yielding, rather than accumulating one large upload.
      this.render();
      await this.nextFrame(signal);
      if (collection.resident) firstFrameAt ??= performance.now();
    }
    signal?.throwIfAborted();
    return firstFrameAt;
  }

  /**
   * Removes a live map region's roads and frees their GPU buffers, keeping the shader program
   * the remaining roads share. Returns the number of segments removed.
   */
  removeOwner(owner: string): number {
    if (this.disposed) return 0;
    const kept: OwnedWireCollection[] = [];
    let removed = 0;
    for (const collection of this.collections) {
      if (collection.owner !== owner) { kept.push(collection); continue; }
      removed += collection.count;
      this.renderer.removeChild(collection);
      collection.release();
    }
    if (kept.length === this.collections.length) return 0;
    // Geometry buffers parallel the collections that draw them.
    this.collections = kept;
    this.geometry.buffers = kept.map(collection => collection.positions);
    this.geometry.ranks = kept.map(collection => collection.rank);
    this.geometry.segmentCount -= removed;
    this.renderer.renderFrame();
    return removed;
  }

  get rotation() { return this.settings.rotation || 0; }

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
    // Rotating keeps the frame's centre and zoom, like turning the paper.
    const rotated = (settings.rotation || 0) !== (this.settings.rotation || 0);
    this.settings = copyDesign(settings);
    if (rotated) this.show();
    if (changed) this.applyColors(settings);
    if (detailChanged) {
      for (const collection of this.collections) collection.hidden = this.hidden(collection.rank);
      this.trimGPU();
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

  /**
   * Composes the map around `camera` (a centre with extents along the screen's axes): the
   * frame takes the canvas's shape, widened so all of `camera` stays in it.
   */
  setCamera(camera: Camera) {
    this.intent = { ...camera };
    this.show();
  }

  private measure(): Size {
    const rect = this.canvas.getBoundingClientRect();
    return { width: rect.width || 1, height: rect.height || 1 };
  }

  /** The composed frame: what the map was composed around, in the canvas's shape. */
  private get composed(): Camera { return fitCamera(this.intent, this.area.width / this.area.height); }

  /**
   * Shows the whole frame in the canvas, centred, at the design's rotation. w-gl's setViewBox
   * resets the camera to north-up, so rotation follows it.
   */
  private show() {
    const { width, height } = this.renderer.getDrawContext(), camera = this.composed;
    const verticalSpan = Math.max(camera.top - camera.bottom, (camera.right - camera.left) / (width / height));
    const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2;
    // w-gl's fit function multiplies its world bounds by DPR. Compensate once here.
    const half = verticalSpan / (2 * this.renderer.getPixelRatio());
    this.showing = true;
    try {
      this.renderer.setViewBox({ left: cx, right: cx, top: cy + half, bottom: cy - half });
      const rotation = (this.settings.rotation || 0) * Math.PI / 180;
      if (rotation) {
        // Increasing w-gl's phi turns the map clockwise on screen.
        const controls = this.renderer.getCameraController();
        controls.rotateByAngle(rotation, 0); controls.redraw();
      }
    } finally { this.showing = false; }
    this.updateVisibility();
    this.renderer.renderFrame();
  }
  /** Fits the roads (or bounds); when rotated, fits their actual extent along the rotated screen axes. */
  fit() {
    const rotation = (this.settings.rotation || 0) * Math.PI / 180;
    if (!rotation) { this.setCamera(this.geometry.bounds); return; }
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const { left, right, bottom, top } = this.geometry.bounds;
    const points = this.fitTo === 'bounds' ? [new Float32Array([left, bottom, right, bottom, right, top, left, top])] : this.geometry.buffers;
    for (const buffer of points) for (let i = 0; i < buffer.length; i += 2) {
      const x = buffer[i] * cos + buffer[i + 1] * sin, y = -buffer[i] * sin + buffer[i + 1] * cos;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return;
    // Same padding as the unrotated bounds from the projector, which bounds already include.
    const pad = this.fitTo === 'bounds' ? 0 : Math.max(maxX - minX, maxY - minY, 1) * 0.12;
    const width = maxX - minX + 2 * pad, height = maxY - minY + 2 * pad, sx = (minX + maxX) / 2, sy = (minY + maxY) / 2;
    const cx = sx * cos - sy * sin, cy = sx * sin + sy * cos;
    this.setCamera({ left: cx - width / 2, right: cx + width / 2, bottom: cy - height / 2, top: cy + height / 2 });
  }
  zoom(factor: number) {
    const camera = this.renderer.getCameraController();
    camera.zoomCenterByScaleFactor(1 - 1 / factor, 0, 0);
    camera.redraw();
  }
  /** The composed frame, which the canvas shows and exports draw. */
  frame(): Camera { return this.composed; }
  /** The visible centre with its extents along the (possibly rotated) screen axes. */
  camera(): Camera {
    const rect = this.canvas.getBoundingClientRect();
    const midX = (rect.left + rect.right) / 2, midY = (rect.top + rect.bottom) / 2;
    const at = (x: number, y: number) => this.renderer.getSceneCoordinate(x, y);
    const centre = at(midX, midY), left = at(rect.left, midY), right = at(rect.right, midY), top = at(midX, rect.top), bottom = at(midX, rect.bottom);
    const width = Math.hypot(right[0] - left[0], right[1] - left[1]), height = Math.hypot(top[0] - bottom[0], top[1] - bottom[1]);
    return { left: centre[0] - width / 2, right: centre[0] + width / 2, bottom: centre[1] - height / 2, top: centre[1] + height / 2 };
  }
  /** The composed frame as a geographic view that survives different data extents. */
  view(): GeoView { return viewFromCamera(this.composed, this.geometry.origin); }
  /** The composed map as shown. `regions` limits live map regions to those an export frame needs; other roads are kept. */
  snapshot(regions?: ReadonlySet<string>): SceneSnapshot {
    // Exports contain only the road classes currently shown.
    const buffers = this.collections.filter(collection => !this.hidden(collection.rank) && (!regions || !collection.owner || regions.has(collection.owner))).map(collection => collection.positions);
    return { buffers, bounds: { ...this.geometry.bounds }, camera: this.frame(), view: this.view(), design: copyDesign(this.settings), width: this.area.width, height: this.area.height, pixelRatio: this.renderer.getPixelRatio() };
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
