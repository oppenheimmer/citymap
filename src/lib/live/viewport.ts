import { detailRank } from '../domain.ts';
import type { Camera, Origin, RoadDetail, RoadRank } from '../domain.ts';
import type { SceneController } from '../SceneController.ts';
import type { CellCommand, CellReply } from '../worker-protocol.ts';
import { frameCorners, viewFromCamera } from '../view.ts';
import { metresPerSceneUnit } from '../scale-bar.ts';
import { cellLevel, coverTiles, GRID_VERSION, groundDistance, intersects, tileDistance, tileKey, tileRect } from './grid.ts';
import type { Tile } from './grid.ts';
import { CellFailure, QUERY_SCHEMA } from './overpass.ts';
import type { FailureCode } from './overpass.ts';
import { CellScheduler } from './scheduler.ts';
import type { Clock, JobSpec, LeafTask } from './scheduler.ts';
import type { CellCache } from './cell-cache.ts';
import { cellCacheEpoch } from './cell-cache.ts';

/** Initial live-loading limits, to tune with measurements; not hardware or provider guarantees. */
export const LIVE_LIMITS = {
  /**
   * Cells load only within this ground distance of where the map started (a cell partly
   * inside still loads), so panning away can never keep loading new areas.
   */
  radiusMetres: 50_000,
  /** Cells per road rank a view may request. A denser view asks the user to zoom in. */
  viewCells: 36,
  /**
   * The centre of the map: this share of the frame's width and height around its middle.
   * It loads first, and must be fully loaded before the map can be exported.
   */
  core: 0.5,
  /**
   * Cells per road rank an export lists in its frame; a wider frame exports every loaded
   * region of that rank. Listing requests nothing.
   */
  exportCells: 480,
  /** Cells one request may combine; fewer after a combined request runs out of time or memory. */
  batch: 4,
  /** The view is padded by this factor, so edges are ready when panning a little. */
  padding: 1.15,
  /** Requests for cells beyond this multiple of the view are aborted. */
  retain: 2,
  debounceMs: 250,
  /** A continuous pan still updates this often. */
  maxWaitMs: 1000,
  maxDepth: 2,
  retries: 1,
  maxRequests: 600,
  pauseAfter: 5,
  /** Pause new requests while more than this much prepared geometry waits for upload. */
  pendingUploadBytes: 8 * 1024 * 1024,
};

export interface LiveSettings {
  overpass: string;
  /** Requests in flight: keep 1 for a shared public provider. */
  concurrency: number;
  /** Bytes of loaded road geometry kept before unseen regions are evicted. */
  budgetBytes: number;
  /** Browser cell cache; omitted when caching is off. */
  cache?: CellCache;
  /** Skip cache reads (still refreshing the cache). */
  forceNetwork?: boolean;
  /** Log sanitized provider failures to the console. */
  debug?: boolean;
  createWorker?: () => Worker;
  clock?: Clock;
}

export interface LiveStats {
  requests: number;
  cached: number;
  /** Bytes received from the road service. */
  bytes: number;
  /** Regions (cells of one road rank) and segments currently loaded. */
  regions: number;
  segments: number;
  splits: number;
  failures: Partial<Record<FailureCode, number>>;
  firstRoadMs?: number;
  medianFetchMs?: number;
  snapshotAt?: string;
  /** When the oldest loaded region was fetched from the road service. */
  oldestFetch?: number;
}

/** Loading state of the visible map. */
export interface LiveCoverage {
  required: number;
  ready: number;
  loading: number;
  failed: number;
  /** Road ranks too dense to load at this zoom; zooming in loads them. */
  limited: RoadRank[];
  /** Every visible region at the chosen detail has loaded. */
  complete: boolean;
  /**
   * Every region in the centre of the map has loaded, or none can load at this zoom, so the
   * map can be exported.
   */
  exportable: boolean;
  /** How much of the view lies beyond the loading radius, where roads never load. */
  beyond: 'none' | 'partly' | 'entirely';
  /** The loading radius in metres. */
  radius: number;
  paused: boolean;
  /** The provider failure that paused loading. */
  pauseReason?: FailureCode;
  exhausted: boolean;
  /** Milliseconds until a provider cooldown ends. */
  cooldown: number;
  /** Why requests wait during a cooldown: a rate limit or a busy provider. */
  waiting?: FailureCode;
  stats: LiveStats;
}

interface CellResult { positions: Float32Array; segments: number; bytes: number; fetchMs: number; fetchedAt: number; snapshotAt?: string }
/** `drawing` counts uploads queued or under way; the region is drawn once none is left. */
interface Region { tile: Tile; rank: RoadRank; bytes: number; segments: number; buffers: Float32Array[]; lastSeen: number; fetchedAt: number; cached: boolean; drawing: number; snapshotAt?: string }

const jobKey = (rank: RoadRank, tile: Tile) => `${rank}:${tileKey(tile)}`;

/**
 * Live roads for the scene's current view. Cells intersecting the (rotated) view load in
 * priority order, the centre of the view first; regions that leave the view stay drawn
 * until the memory budget evicts the least recently seen. The map can be exported once the
 * centre of the view has loaded; exports contain exactly the roads drawn.
 */
export class LiveViewport {
  private readonly scheduler: CellScheduler<CellResult>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, { count: number; resolve(results: CellResult[]): void; reject(error: unknown): void }>();
  private readonly regions = new Map<string, Region>();
  private readonly scene: SceneController;
  private readonly origin: Origin;
  private readonly settings: LiveSettings;
  private readonly onChange: (coverage: LiveCoverage) => void;
  private detail: RoadDetail;
  private visible: JobSpec[] = [];
  private required: string[] = [];
  /**
   * Regions in the centre of the view, which load before the map can be exported: none when
   * no road class shown can load at this zoom, and undefined when the centre never loads.
   */
  private centre?: string[];
  private limited: RoadRank[] = [];
  private beyond: LiveCoverage['beyond'] = 'none';
  private uploads = Promise.resolve();
  private pendingUploadBytes = 0;
  private nextId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private firstChange?: number;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly started = performance.now();
  private readonly fetchTimes: number[] = [];
  private readonly stats: LiveStats = { requests: 0, cached: 0, bytes: 0, regions: 0, segments: 0, splits: 0, failures: {} };

  constructor(scene: SceneController, origin: Origin, detail: RoadDetail, settings: LiveSettings, onChange: (coverage: LiveCoverage) => void) {
    this.scene = scene; this.origin = origin; this.detail = detail; this.settings = settings; this.onChange = onChange;
    this.worker = settings.createWorker?.() || new Worker(new URL('../../workers/cells.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.reply;
    this.worker.onerror = () => this.rejectAll(new CellFailure('provider_unavailable', { message: 'Background road processing failed' }));
    const cache = settings.cache;
    this.scheduler = new CellScheduler<CellResult>({ concurrency: settings.concurrency, maxDepth: LIVE_LIMITS.maxDepth, retries: LIVE_LIMITS.retries, maxRequests: LIVE_LIMITS.maxRequests, pauseAfter: LIVE_LIMITS.pauseAfter, batch: LIVE_LIMITS.batch, clock: settings.clock }, {
      execute: this.execute,
      lookup: cache && !settings.forceNetwork ? async (task, signal) => {
        const hit = await cache.get(this.cacheKey(task.job), this.origin);
        if (!hit || signal.aborted) return;
        return { positions: hit.positions, segments: hit.positions.length / 4, bytes: 0, fetchMs: 0, fetchedAt: hit.fetchedAt, snapshotAt: hit.snapshotAt };
      } : undefined,
      loaded: this.loaded,
      changed: () => this.emit(),
      failed: (task, failure, outcome) => {
        this.stats.failures[failure.code] = (this.stats.failures[failure.code] || 0) + 1;
        if (outcome === 'split') this.stats.splits++;
        // Development diagnostics: provider remarks are sanitized and never shown in the page.
        if (settings.debug) console.warn(`[citymap] cell ${task.job} (${task.leaf}): ${failure.code}${failure.status ? ` HTTP ${failure.status}` : ''} → ${outcome}`, failure.remark || '');
      },
    });
    this.update();
  }

  /** The camera moved, resized or rotated; loads follow after a short pause. */
  viewChanged() {
    if (this.disposed) return;
    const now = performance.now();
    this.firstChange ??= now;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), Math.max(0, Math.min(LIVE_LIMITS.debounceMs, this.firstChange + LIVE_LIMITS.maxWaitMs - now)));
  }

  /** Road detail changed: request the newly shown ranks; hidden ranks stay loaded until evicted. */
  setDetail(detail: RoadDetail) {
    if (detail === this.detail || this.disposed) return;
    this.detail = detail;
    this.update();
  }

  /** Requeues failed regions and resumes a paused session. */
  retry() { this.scheduler.retry(); this.update(); }

  coverage(): LiveCoverage {
    let ready = 0, failed = 0;
    for (const key of this.required) {
      const status = this.scheduler.status(key);
      if (this.drawn(key)) ready++; else if (status === 'failed') failed++;
    }
    const loading = this.required.length - ready - failed;
    this.stats.requests = this.scheduler.requests;
    this.stats.regions = this.regions.size;
    this.stats.segments = [...this.regions.values()].reduce((sum, region) => sum + region.segments, 0);
    const sorted = [...this.fetchTimes].sort((a, b) => a - b);
    this.stats.medianFetchMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
    this.stats.oldestFetch = [...this.regions.values()].reduce<number | undefined>((oldest, region) => oldest === undefined || region.fetchedAt < oldest ? region.fetchedAt : oldest, undefined);
    return {
      required: this.required.length, ready, loading, failed, limited: [...this.limited],
      complete: !this.limited.length && ready === this.required.length,
      exportable: !!this.centre?.every(key => this.drawn(key)),
      beyond: this.beyond, radius: LIVE_LIMITS.radiusMetres,
      paused: this.scheduler.paused, pauseReason: this.scheduler.pauseReason, exhausted: this.scheduler.exhausted,
      cooldown: Math.max(0, this.scheduler.cooldownUntil - (this.settings.clock || performance).now()), waiting: this.scheduler.cooldownReason,
      stats: { ...this.stats, failures: { ...this.stats.failures } },
    };
  }

  /**
   * The regions an export of `frame` turned by `rotation` draws, read when it starts: the
   * frame's regions at every road class shown, including classes too dense to load at this
   * zoom, so it holds exactly the roads drawn on screen. Exports have the map's shape, so
   * their centre is the view's, which Export waits for; nothing is requested. `complete`
   * says whether every region of the frame has loaded and is drawn.
   */
  exportRegions(frame: Camera, rotation: number): { regions: Set<string>; complete: boolean } {
    const exact = frameCorners(frame, rotation), regions = new Set<string>();
    let complete = true;
    for (const rank of this.ranks()) {
      const tiles = coverTiles(exact, this.origin, cellLevel(rank, this.origin[1]), LIVE_LIMITS.exportCells);
      if (tiles) for (const tile of tiles) regions.add(jobKey(rank, tile));
      // A frame too wide to list takes every loaded region of the class.
      else { complete = false; for (const [key, region] of this.regions) if (region.rank === rank) regions.add(key); }
    }
    for (const key of regions) if (this.scheduler.status(key) !== 'ready' || this.regions.get(key)?.drawing) complete = false;
    return { regions, complete };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer); clearTimeout(this.emitTimer);
    this.scheduler.dispose();
    this.rejectAll(new CellFailure('cancelled'));
    this.settings.cache?.close();
    // Let abort messages reach the worker's fetches before it stops.
    const worker = this.worker;
    setTimeout(() => worker.terminate(), 100);
  }

  private ranks(): RoadRank[] { return ([0, 1, 2] as const).filter(rank => rank <= detailRank(this.detail)); }
  private cacheKey(job: string) { return `${GRID_VERSION}|${QUERY_SCHEMA}|${this.settings.overpass}|${job}`; }
  private drawn(key: string) { return this.scheduler.status(key) === 'ready' && this.regions.has(key) && !this.regions.get(key)!.drawing; }
  private near = (tile: Tile) => tileDistance(tile, this.origin) <= LIVE_LIMITS.radiusMetres;

  private update() {
    clearTimeout(this.timer); this.timer = undefined; this.firstChange = undefined;
    if (this.disposed) return;
    // Roads load for the composed map, which fills the canvas.
    const camera = this.scene.frame(), rotation = this.scene.rotation;
    if (![camera.left, camera.right, camera.bottom, camera.top].every(Number.isFinite) || camera.right <= camera.left || camera.top <= camera.bottom) return;
    const visible = frameCorners(camera, rotation, LIVE_LIMITS.padding), exact = frameCorners(camera, rotation), retain = frameCorners(camera, rotation, LIVE_LIMITS.retain);
    const core = frameCorners(camera, rotation, LIVE_LIMITS.core);
    const specs: JobSpec[] = [], outer: { spec: JobSpec; gap: number }[] = [], required: string[] = [], retained: string[] = [], limited: RoadRank[] = [];
    const centre: string[] = [];
    let reachable = true;
    // Scene distance from the map's centre to the nearest point of a cell.
    const cx = (camera.left + camera.right) / 2, cy = (camera.bottom + camera.top) / 2;
    const gap = (tile: Tile) => { const box = tileRect(tile, this.origin); return Math.hypot(Math.max(box.left - cx, 0, cx - box.right), Math.max(box.bottom - cy, 0, cy - box.top)); };
    for (const rank of this.ranks()) {
      const z = cellLevel(rank, this.origin[1]);
      const tiles = coverTiles(visible, this.origin, z, LIVE_LIMITS.viewCells);
      if (!tiles) { limited.push(rank); continue; }
      // The centre's cells load first, major roads before streets; the rest follow by distance
      // from the centre, whatever their rank. Nothing loads beyond the radius.
      const inner = coverTiles(core, this.origin, z, LIVE_LIMITS.viewCells) || [], keys = new Set(inner.map(tileKey));
      for (const [index, tile] of tiles.filter(this.near).entries()) {
        const spec = { key: jobKey(rank, tile), tile, rank, priority: rank * 1e4 + index };
        if (keys.has(tileKey(tile))) specs.push(spec); else outer.push({ spec, gap: gap(tile) });
      }
      // A centre partly beyond the radius can never load completely.
      if (!inner.every(this.near)) reachable = false;
      centre.push(...inner.map(tile => jobKey(rank, tile)));
      for (const tile of (coverTiles(exact, this.origin, z, LIVE_LIMITS.viewCells) || []).filter(this.near)) required.push(jobKey(rank, tile));
      for (const tile of (coverTiles(retain, this.origin, z, LIVE_LIMITS.viewCells * 4) || []).filter(this.near)) retained.push(jobKey(rank, tile));
    }
    outer.sort((a, b) => a.gap - b.gap || a.spec.rank - b.spec.rank).forEach(({ spec }, index) => specs.push({ ...spec, priority: 1e5 + index }));
    // The view's centre and furthest corner against the radius; a rotated frame's corners
    // are all half a diagonal from its centre.
    const view = viewFromCamera(camera, this.origin), reach = Math.hypot(view.width, view.height) / 2 * metresPerSceneUnit(view.lat);
    const distance = groundDistance(this.origin, [view.lon, view.lat]), radius = LIVE_LIMITS.radiusMetres;
    this.beyond = distance - reach > radius ? 'entirely' : distance + reach > radius ? 'partly' : 'none';
    // With every road class shown too dense to load here, no centre needs to load: the map
    // exports as drawn, unless its centre lies beyond the radius.
    const dense = limited.length === this.ranks().length;
    this.visible = specs; this.required = required; this.limited = limited;
    this.centre = reachable && !(dense && distance > radius) ? centre : undefined;
    // Every loaded region in view counts as seen, including classes too dense to load at this
    // zoom, so regions out of view are evicted first.
    const now = performance.now(), shown = this.ranks();
    for (const region of this.regions.values()) if (shown.includes(region.rank) && intersects(visible, tileRect(region.tile, this.origin))) region.lastSeen = now;
    this.scheduler.want(specs, retained);
    this.evict();
    this.emit();
  }

  private execute = async (tasks: LeafTask[], signal: AbortSignal): Promise<CellResult[]> => {
    if (this.pendingUploadBytes > LIVE_LIMITS.pendingUploadBytes) {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new CellFailure('cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        void this.uploads.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
        if (signal.aborted) cancel();
      });
    }
    return new Promise<CellResult[]>((resolve, reject) => {
      if (signal.aborted) { reject(new CellFailure('cancelled')); return; }
      const id = ++this.nextId;
      this.pending.set(id, { count: tasks.length, resolve, reject });
      signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.post({ type: 'abort', id });
        reject(new CellFailure('cancelled'));
      }, { once: true });
      this.post({ type: 'fetch', id, cells: tasks.map(task => ({ tile: task.tile, rank: task.rank })), origin: this.origin, overpass: this.settings.overpass });
    });
  };

  private post(command: CellCommand) {
    try { this.worker.postMessage(command); }
    catch { this.rejectAll(new CellFailure('provider_unavailable', { message: 'Background road processing is unavailable' })); }
  }

  private reply = (event: MessageEvent<CellReply>) => {
    const message = event.data, entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.type === 'cells') {
      const invalid = () => entry.reject(new CellFailure('decode_failure', { message: 'Invalid prepared geometry' }));
      if (!Array.isArray(message.cells) || message.cells.length !== entry.count) { invalid(); return; }
      const fetchedAt = Date.now(), results: CellResult[] = [];
      for (const cell of message.cells) {
        const positions = new Float32Array(cell.positions);
        if (positions.length % 4 || positions.length / 4 !== cell.segments) { invalid(); return; }
        results.push({ positions, segments: cell.segments, bytes: message.bytes, fetchMs: message.fetchMs, fetchedAt, snapshotAt: message.snapshotAt });
      }
      this.fetchTimes.push(message.fetchMs); if (this.fetchTimes.length > 200) this.fetchTimes.shift();
      this.stats.bytes += message.bytes;
      entry.resolve(results);
    } else entry.reject(new CellFailure(message.code, { status: message.status, retryAfter: message.retryAfter, remark: message.remark, message: message.message }));
  };

  private rejectAll(error: CellFailure) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  private loaded = (task: LeafTask, result: CellResult, cached: boolean) => {
    let region = this.regions.get(task.job);
    // The region's cell: a leaf is that cell, or a quarter of it `depth` times over.
    const tile = { z: task.tile.z - task.depth, x: task.tile.x >> task.depth, y: task.tile.y >> task.depth };
    if (!region) this.regions.set(task.job, region = { tile, rank: task.rank, bytes: 0, segments: 0, buffers: [], lastSeen: performance.now(), fetchedAt: result.fetchedAt, cached, drawing: 0, snapshotAt: result.snapshotAt });
    region.bytes += result.positions.byteLength; region.segments += result.segments; region.buffers.push(result.positions);
    region.fetchedAt = Math.min(region.fetchedAt, result.fetchedAt);
    if (result.snapshotAt && (!region.snapshotAt || result.snapshotAt > region.snapshotAt)) region.snapshotAt = result.snapshotAt;
    if (result.snapshotAt && (!this.stats.snapshotAt || result.snapshotAt > this.stats.snapshotAt)) this.stats.snapshotAt = result.snapshotAt;
    if (cached) this.stats.cached++;
    const current = region;
    if (result.positions.length) {
      current.drawing++;
      this.pendingUploadBytes += result.positions.byteLength;
      this.enqueue(async () => {
        try {
          if (this.regions.get(task.job) !== current) return;
          const drawn = await this.scene.appendGeometry(result.positions, task.rank, undefined, task.job);
          if (drawn !== undefined) this.stats.firstRoadMs ??= drawn - this.started;
        } finally {
          current.drawing--; this.pendingUploadBytes -= result.positions.byteLength;
          this.emit();
        }
      });
    }
    // A complete region fetched from the road service is cached for later sessions.
    if (!cached && !region.cached && this.settings.cache && this.scheduler.status(task.job) === 'ready') {
      const cache = this.settings.cache, key = this.cacheKey(task.job), buffers = [...region.buffers], meta = { fetchedAt: region.fetchedAt, snapshotAt: region.snapshotAt };
      const epoch = cellCacheEpoch();
      const save = () => { void cache.put(key, this.origin, buffers, meta, epoch); };
      if ('requestIdleCallback' in globalThis) requestIdleCallback(save, { timeout: 2000 }); else setTimeout(save, 0);
    }
    this.evict();
  };

  /** Uploads and removals run in order, so a removed region can never be redrawn by a late upload. */
  private enqueue(work: () => Promise<void> | void) {
    this.uploads = this.uploads.then(() => this.disposed ? undefined : work()).catch(error => {
      if (!this.disposed && this.settings.debug) console.debug('[citymap] live road upload failed', error);
    });
  }

  /** Removes the least recently seen regions outside the view until within budget. */
  private evict() {
    let total = 0;
    for (const region of this.regions.values()) total += region.bytes;
    if (total <= this.settings.budgetBytes) return;
    const kept = new Set(this.visible.map(spec => spec.key));
    const candidates = [...this.regions].filter(([key]) => !kept.has(key)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key, region] of candidates) {
      if (total <= this.settings.budgetBytes) break;
      total -= region.bytes;
      this.regions.delete(key);
      this.scheduler.forget(key);
      this.enqueue(() => { this.scene.removeOwner(key); });
    }
  }

  /** Coalesces coverage updates so screen readers and the page see at most a few per second. */
  private emit() {
    if (this.emitTimer || this.disposed) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = undefined; if (!this.disposed) this.onChange(this.coverage()); }, 100);
  }
}
