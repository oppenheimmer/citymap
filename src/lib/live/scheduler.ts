import type { RoadRank } from '../domain.ts';
import { children, tileKey } from './grid.ts';
import type { Tile } from './grid.ts';
import { CellFailure } from './overpass.ts';
import type { FailureCode } from './overpass.ts';

/** One road rank in one cell. Lower priorities load first. */
export interface JobSpec { key: string; tile: Tile; rank: RoadRank; priority: number }
/** A leaf is the job's cell, or a quarter of it after the provider could not complete the cell. */
export interface LeafTask { job: string; leaf: string; tile: Tile; rank: RoadRank; depth: number }
export type JobStatus = 'pending' | 'loading' | 'ready' | 'failed';

export interface Clock { now(): number; set(callback: () => void, ms: number): unknown; clear(handle: unknown): void; random(): number }
export const systemClock: Clock = { now: () => performance.now(), set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), random: Math.random };

export interface SchedulerOptions {
  /** Requests in flight at once: 1 for a shared public provider. */
  concurrency: number;
  /** How many times a cell may be quartered after resource failures. */
  maxDepth: number;
  /** Extra attempts after the provider is transiently unavailable. */
  retries: number;
  /** Network requests per session before loading waits for an explicit retry. */
  maxRequests: number;
  /** Consecutive provider failures (busy, unavailable or overloaded) that pause the session. */
  pauseAfter: number;
  clock?: Clock;
}

export interface SchedulerHooks<T> {
  /** Fetches one leaf. Rejections are CellFailures; anything else counts as a decode failure. */
  execute(task: LeafTask, signal: AbortSignal): Promise<T>;
  /** Optional fast path, such as a browser cache, tried once per new job before any request. */
  lookup?(task: LeafTask, signal: AbortSignal): Promise<T | undefined>;
  /** A leaf loaded; its job is ready once every leaf has. */
  loaded(task: LeafTask, result: T, cached: boolean): void;
  /** Job, leaf or session state changed. */
  changed(): void;
  /** A request failed, for diagnostics. */
  failed?(task: LeafTask, failure: CellFailure, outcome: 'split' | 'retry' | 'cooldown' | 'failed'): void;
}

type LeafState = 'lookup' | 'queued' | 'active' | 'ready' | 'failed';
interface Leaf { key: string; tile: Tile; depth: number; state: LeafState; attempts: number; notBefore: number; code?: FailureCode; controller?: AbortController }
interface Job { spec: JobSpec; leaves: Map<string, Leaf> }

const RATE_LIMIT_BACKOFF = 5_000, BUSY_BACKOFF = 10_000, RETRY_BACKOFF = 2_000, MAX_BACKOFF = 60_000;
/** Shorter waits are lengthened; a provider asking for longer pauses the session instead. */
export const MIN_COOLDOWN = 1_000, MAX_COOLDOWN = 300_000;

/**
 * Loads wanted cells in priority order with bounded concurrency. Work for cells that are no
 * longer wanted is dropped, and in-flight requests are aborted unless their cell is retained.
 * Resource failures split only that cell, to a bounded depth; rate limits and a busy provider
 * pause every request without splitting; repeated provider failures pause the session until
 * `retry()`.
 */
export class CellScheduler<T> {
  private readonly jobs = new Map<string, Job>();
  private wanted: JobSpec[] = [];
  private active = 0;
  private timer: unknown;
  private failures = 0;
  private disposed = false;
  private readonly clock: Clock;
  /** Paused after repeated provider failures or a very long cooldown. */
  paused = false;
  /** The session request budget is spent. */
  exhausted = false;
  cooldownUntil = 0;
  /** Why every request is waiting until `cooldownUntil`. */
  cooldownReason?: FailureCode;
  requests = 0;
  /** The provider failure that paused the session, to explain it. */
  pauseReason?: FailureCode;
  private readonly options: SchedulerOptions;
  private readonly hooks: SchedulerHooks<T>;

  constructor(options: SchedulerOptions, hooks: SchedulerHooks<T>) {
    this.options = options; this.hooks = hooks; this.clock = options.clock || systemClock;
  }

  /** Replaces the wanted jobs. Active requests of jobs outside `wanted` and `retain` are aborted. */
  want(specs: JobSpec[], retain: Iterable<string> = []) {
    if (this.disposed) return;
    this.wanted = [...specs].sort((a, b) => a.priority - b.priority);
    for (const spec of this.wanted) {
      const job = this.jobs.get(spec.key);
      if (job) job.spec = spec; else this.create(spec);
    }
    const keep = new Set([...this.wanted.map(spec => spec.key), ...retain]);
    for (const [key, job] of this.jobs) {
      if (keep.has(key)) continue;
      for (const leaf of job.leaves.values()) this.abort(leaf);
      // Unstarted work is cheap to recreate; loaded or failed regions are kept until forgotten.
      if (![...job.leaves.values()].some(leaf => leaf.state === 'ready' || leaf.state === 'failed')) this.jobs.delete(key);
    }
    this.hooks.changed(); this.pump();
  }

  /** Drops a job, aborting its requests, so a later want starts again. */
  forget(key: string) {
    const job = this.jobs.get(key);
    if (!job) return;
    for (const leaf of job.leaves.values()) this.abort(leaf);
    this.jobs.delete(key);
    this.hooks.changed(); this.pump();
  }

  /**
   * Requeues failed leaves and resumes a paused or exhausted session. A rate-limit cooldown
   * still running is kept, so retrying never asks a busy provider again early.
   */
  retry() {
    for (const job of this.jobs.values()) for (const leaf of job.leaves.values()) {
      if (leaf.state === 'failed') Object.assign(leaf, { state: 'queued', attempts: 0, notBefore: 0, code: undefined });
    }
    this.paused = this.exhausted = false; this.failures = this.requests = 0; this.pauseReason = undefined;
    this.hooks.changed(); this.pump();
  }

  status(key: string): JobStatus | undefined {
    const job = this.jobs.get(key);
    if (!job) return;
    let loading = false, pending = false, failed = false;
    for (const leaf of job.leaves.values()) {
      if (leaf.state === 'active' || leaf.state === 'lookup') loading = true;
      else if (leaf.state === 'queued') pending = true;
      else if (leaf.state === 'failed') failed = true;
    }
    return loading ? 'loading' : pending ? 'pending' : failed ? 'failed' : 'ready';
  }
  /** The first failure code of a job's failed leaves. */
  failure(key: string): FailureCode | undefined {
    for (const leaf of this.jobs.get(key)?.leaves.values() || []) if (leaf.state === 'failed') return leaf.code;
  }
  get inFlight() { return this.active; }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    for (const job of this.jobs.values()) for (const leaf of job.leaves.values()) this.abort(leaf);
    this.jobs.clear();
  }

  private create(spec: JobSpec) {
    const root: Leaf = { key: tileKey(spec.tile), tile: spec.tile, depth: 0, state: this.hooks.lookup ? 'lookup' : 'queued', attempts: 0, notBefore: 0 };
    const job: Job = { spec, leaves: new Map([[root.key, root]]) };
    this.jobs.set(spec.key, job);
    if (!this.hooks.lookup) return;
    const controller = root.controller = new AbortController(), task = this.task(job, root);
    const settle = (result: T | undefined) => {
      if (root.controller !== controller || this.disposed) return;
      root.controller = undefined;
      root.state = result === undefined ? 'queued' : 'ready';
      if (result !== undefined) this.hooks.loaded(task, result, true);
      this.hooks.changed(); this.pump();
    };
    this.hooks.lookup(task, controller.signal).then(settle, () => settle(undefined));
  }

  private task(job: Job, leaf: Leaf): LeafTask { return { job: job.spec.key, leaf: leaf.key, tile: leaf.tile, rank: job.spec.rank, depth: leaf.depth }; }

  private abort(leaf: Leaf) {
    const controller = leaf.controller;
    if (!controller) return;
    leaf.controller = undefined;
    if (leaf.state === 'active') this.active--;
    if (leaf.state === 'active' || leaf.state === 'lookup') leaf.state = 'queued';
    controller.abort();
  }

  private wake(ms: number) {
    this.timer = this.clock.set(() => { this.timer = undefined; this.hooks.changed(); this.pump(); }, Math.max(0, ms));
  }

  private pump() {
    if (this.disposed) return;
    if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined; }
    if (this.paused || this.exhausted) return;
    const now = this.clock.now();
    if (now < this.cooldownUntil) { this.wake(this.cooldownUntil - now); return; }
    let wake = Infinity;
    next: while (this.active < this.options.concurrency) {
      for (const spec of this.wanted) {
        const job = this.jobs.get(spec.key);
        if (!job) continue;
        for (const leaf of job.leaves.values()) {
          if (leaf.state !== 'queued') continue;
          if (leaf.notBefore > now) { wake = Math.min(wake, leaf.notBefore); continue; }
          if (this.requests >= this.options.maxRequests) { this.exhausted = true; this.hooks.changed(); return; }
          this.start(job, leaf);
          continue next;
        }
      }
      break;
    }
    if (this.active < this.options.concurrency && wake < Infinity) this.wake(wake - now);
  }

  private start(job: Job, leaf: Leaf) {
    leaf.state = 'active'; this.active++; this.requests++;
    const controller = leaf.controller = new AbortController(), task = this.task(job, leaf);
    this.hooks.execute(task, controller.signal).then(result => {
      if (leaf.controller !== controller || this.disposed) return;
      leaf.controller = undefined; this.active--; leaf.state = 'ready'; this.failures = 0;
      this.hooks.loaded(task, result, false);
      this.hooks.changed(); this.pump();
    }, (error: unknown) => {
      if (leaf.controller !== controller || this.disposed) return;
      leaf.controller = undefined; this.active--;
      this.fail(job, leaf, task, error instanceof CellFailure ? error : new CellFailure('decode_failure', { message: error instanceof Error ? error.message : undefined }));
      this.hooks.changed(); this.pump();
    });
  }

  private backoff(attempt: number, base: number) {
    return Math.min(MAX_BACKOFF, base * 2 ** (attempt - 1)) * (0.75 + 0.5 * this.clock.random());
  }

  private fail(job: Job, leaf: Leaf, task: LeafTask, failure: CellFailure) {
    const now = this.clock.now();
    let outcome: 'split' | 'retry' | 'cooldown' | 'failed' = 'failed';
    const failed = () => { leaf.state = 'failed'; leaf.code = failure.code; };
    switch (failure.code) {
      case 'cancelled': leaf.state = 'queued'; return;
      case 'rate_limited': case 'provider_busy': {
        // Never split or retry around a rate limit or a busy provider: every request waits.
        this.failures++; leaf.state = 'queued'; outcome = 'cooldown';
        const wait = failure.retryAfter ?? this.backoff(this.failures, failure.code === 'rate_limited' ? RATE_LIMIT_BACKOFF : BUSY_BACKOFF);
        if (wait > MAX_COOLDOWN) { this.paused = true; this.pauseReason = failure.code; }
        else { this.cooldownUntil = now + Math.max(MIN_COOLDOWN, wait); this.cooldownReason = failure.code; }
        break;
      }
      case 'provider_unavailable': case 'unreachable':
        this.failures++; leaf.attempts++;
        if (leaf.attempts > this.options.retries) failed();
        else { leaf.state = 'queued'; leaf.notBefore = now + this.backoff(leaf.attempts, RETRY_BACKOFF); outcome = 'retry'; }
        break;
      case 'timeout_or_resource_limit': case 'response_too_large':
        this.failures++;
        if (leaf.depth >= this.options.maxDepth) { failed(); break; }
        job.leaves.delete(leaf.key);
        for (const tile of children(leaf.tile)) job.leaves.set(tileKey(tile), { key: tileKey(tile), tile, depth: leaf.depth + 1, state: 'queued', attempts: 0, notBefore: 0 });
        outcome = 'split';
        break;
      default: failed();
    }
    if (this.failures >= this.options.pauseAfter && !this.paused) { this.paused = true; this.pauseReason = failure.code; }
    this.hooks.failed?.(task, failure, outcome);
  }
}
