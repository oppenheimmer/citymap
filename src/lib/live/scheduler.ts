import type { RoadRank } from '../domain.ts';
import { children, tileKey } from './grid.ts';
import type { Tile } from './grid.ts';
import { CellFailure, isOutage } from './overpass.ts';
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
  /** Leaves one request may combine; 1, the default, requests each alone. */
  batch?: number;
  clock?: Clock;
}

/** What a failed request led to, for diagnostics; `alone` retries a combined request's cells one by one. */
export type FailureOutcome = 'split' | 'retry' | 'cooldown' | 'failed' | 'alone';

export interface SchedulerHooks<T> {
  /**
   * Fetches leaves in one request, resolving with one result per task, in order. Rejections
   * are CellFailures; anything else counts as a decode failure.
   */
  execute(tasks: LeafTask[], signal: AbortSignal): Promise<T[]>;
  /** Optional fast path, such as a browser cache, tried once per new job before any request. */
  lookup?(task: LeafTask, signal: AbortSignal): Promise<T | undefined>;
  /** Optional outage fallback. Misses retain the original retry/failure state and cooldown. */
  recover?(task: LeafTask, failure: CellFailure, signal: AbortSignal): Promise<T | undefined>;
  /** A leaf loaded; its job is ready once every leaf has. */
  loaded(task: LeafTask, result: T, cached: boolean): void;
  /** Job, leaf or session state changed. */
  changed(): void;
  /** A request failed, for diagnostics; `task` is its first leaf. */
  failed?(task: LeafTask, failure: CellFailure, outcome: FailureOutcome): void;
}

type LeafState = 'lookup' | 'queued' | 'active' | 'ready' | 'failed';
/** `controller` cancels a cache lookup; `request` is the request the leaf waits for; `alone` keeps it out of combined requests. */
interface Leaf { key: string; tile: Tile; depth: number; state: LeafState; attempts: number; notBefore: number; code?: FailureCode; controller?: AbortController; request?: Request; alone?: boolean }
interface Job { spec: JobSpec; leaves: Map<string, Leaf> }
/** A request in flight, with the leaves still waiting for it. */
interface Request { controller: AbortController; leaves: Set<Leaf> }
interface Entry { job: Job; leaf: Leaf }
/** Failures of a combined request that say nothing about its cells, which then load one by one. */
const ALONE: ReadonlySet<FailureCode> = new Set(['timeout_or_resource_limit', 'response_too_large', 'invalid_request', 'decode_failure']);

const RATE_LIMIT_BACKOFF = 5_000, BUSY_BACKOFF = 10_000, RETRY_BACKOFF = 2_000, MAX_BACKOFF = 60_000;
/** Shorter waits are lengthened; a provider asking for longer pauses the session instead. */
export const MIN_COOLDOWN = 1_000, MAX_COOLDOWN = 300_000;

/**
 * Loads wanted cells in priority order with bounded concurrency, combining up to `batch`
 * cells per request. Work for cells that are no longer wanted is dropped, and in-flight
 * requests are aborted once none of their cells is wanted or retained. A combined request
 * that fails for its size or content retries its cells one by one. Resource failures split
 * only that cell, to a bounded depth; rate limits and a busy provider pause every request
 * without splitting; repeated provider failures pause the session until `retry()`.
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
  /** Leaves per request now: halved after a combined request runs out of time or memory. */
  private batch: number;

  constructor(options: SchedulerOptions, hooks: SchedulerHooks<T>) {
    this.options = options; this.hooks = hooks; this.clock = options.clock || systemClock;
    this.batch = Math.max(1, Math.floor(options.batch ?? 1));
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
    this.lookup(job, root);
  }

  /** Split children are cacheable independently; a partial parent is never a whole-cell hit. */
  private lookup(job: Job, root: Leaf, read = this.hooks.lookup, miss: LeafState = 'queued') {
    if (!read) return;
    root.state = 'lookup';
    const controller = root.controller = new AbortController(), task = this.task(job, root);
    const settle = (result: T | undefined) => {
      if (root.controller !== controller || this.disposed) return;
      root.controller = undefined;
      root.state = result === undefined ? miss : 'ready';
      if (result !== undefined) this.hooks.loaded(task, result, true);
      this.hooks.changed(); this.pump();
    };
    read(task, controller.signal).then(settle, () => settle(undefined));
  }

  private task(job: Job, leaf: Leaf): LeafTask { return { job: job.spec.key, leaf: leaf.key, tile: leaf.tile, rank: job.spec.rank, depth: leaf.depth }; }

  private abort(leaf: Leaf) {
    const controller = leaf.controller;
    if (controller) {
      leaf.controller = undefined;
      if (leaf.state === 'lookup') leaf.state = 'queued';
      controller.abort();
    }
    const request = leaf.request;
    if (!request) return;
    leaf.request = undefined;
    if (leaf.state === 'active') leaf.state = 'queued';
    request.leaves.delete(leaf);
    // A request still needed by other cells runs on; public Overpass keeps an aborted query's slot busy anyway.
    if (!request.leaves.size) { this.active--; request.controller.abort(); }
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
      // The next queued leaves in priority order, combined up to the batch size.
      const batch: Entry[] = [];
      for (const spec of this.wanted) {
        const job = this.jobs.get(spec.key);
        if (!job) continue;
        for (const leaf of job.leaves.values()) {
          if (leaf.state !== 'queued') continue;
          if (leaf.notBefore > now) { wake = Math.min(wake, leaf.notBefore); continue; }
          // Quarters of a split cell, and cells a combined request failed, load alone.
          const alone = leaf.depth > 0 || !!leaf.alone;
          if (batch.length && alone) continue;
          if (!batch.length && this.requests >= this.options.maxRequests) { this.exhausted = true; this.hooks.changed(); return; }
          batch.push({ job, leaf });
          if (alone || batch.length >= this.batch) { this.start(batch); continue next; }
        }
      }
      if (!batch.length) break;
      this.start(batch);
    }
    if (this.active < this.options.concurrency && wake < Infinity) this.wake(wake - now);
  }

  private start(batch: Entry[]) {
    const controller = new AbortController(), request: Request = { controller, leaves: new Set(batch.map(entry => entry.leaf)) };
    const tasks = batch.map(({ job, leaf }) => this.task(job, leaf));
    for (const { leaf } of batch) { leaf.state = 'active'; leaf.request = request; }
    this.active++; this.requests++;
    // Leaves that stopped being wanted were detached; their results are dropped.
    const attached = () => batch.flatMap((entry, index) => entry.leaf.request === request ? [{ ...entry, task: tasks[index], index }] : []);
    this.hooks.execute(tasks, controller.signal).then(results => {
      if (controller.signal.aborted || this.disposed) return;
      this.active--; this.failures = 0;
      for (const { leaf, task, index } of attached()) {
        leaf.request = undefined; leaf.state = 'ready';
        this.hooks.loaded(task, results[index], false);
      }
      this.hooks.changed(); this.pump();
    }, (error: unknown) => {
      if (controller.signal.aborted || this.disposed) return;
      this.active--;
      const entries = attached();
      for (const { leaf } of entries) leaf.request = undefined;
      this.failRequest(entries, error instanceof CellFailure ? error : new CellFailure('decode_failure', { message: error instanceof Error ? error.message : undefined }));
      this.hooks.changed(); this.pump();
    });
  }

  /** A request failed: its cells share the outcome, counted once for the session. */
  private failRequest(entries: (Entry & { task: LeafTask })[], failure: CellFailure) {
    if (!entries.length) return;
    if (entries.length > 1 && ALONE.has(failure.code)) {
      // No verdict on any one cell: each loads alone, and after running out of time or memory
      // later requests combine fewer cells.
      if (failure.code === 'timeout_or_resource_limit' || failure.code === 'response_too_large') this.batch = Math.max(1, Math.floor(this.batch / 2));
      for (const { leaf } of entries) { leaf.state = 'queued'; leaf.alone = true; }
      this.hooks.failed?.(entries[0].task, failure, 'alone');
      return;
    }
    entries.forEach(({ job, leaf, task }, index) => this.fail(job, leaf, task, failure, index > 0));
    if (this.hooks.recover && isOutage(failure.code)) for (const { job, leaf } of entries) {
      this.lookup(job, leaf, (task, signal) => this.hooks.recover!(task, failure, signal), leaf.state);
    }
  }

  private backoff(attempt: number, base: number) {
    return Math.min(MAX_BACKOFF, base * 2 ** (attempt - 1)) * (0.75 + 0.5 * this.clock.random());
  }

  /** `shared`: another cell of the same request already counted this failure for the session. */
  private fail(job: Job, leaf: Leaf, task: LeafTask, failure: CellFailure, shared = false) {
    const now = this.clock.now();
    let outcome: FailureOutcome = 'failed';
    const failed = () => { leaf.state = 'failed'; leaf.code = failure.code; };
    // Provider failures count towards pausing the session, once per request.
    const count = () => { if (!shared) this.failures++; };
    switch (failure.code) {
      case 'cancelled': leaf.state = 'queued'; return;
      case 'rate_limited': case 'provider_busy': {
        // Never split or retry around a rate limit or a busy provider: every request waits.
        count(); leaf.state = 'queued'; outcome = 'cooldown';
        if (shared) break;
        const wait = failure.retryAfter ?? this.backoff(this.failures, failure.code === 'rate_limited' ? RATE_LIMIT_BACKOFF : BUSY_BACKOFF);
        if (wait > MAX_COOLDOWN) { this.paused = true; this.pauseReason = failure.code; }
        else { this.cooldownUntil = Math.max(this.cooldownUntil, now + Math.max(MIN_COOLDOWN, wait)); this.cooldownReason = failure.code; }
        break;
      }
      case 'provider_unavailable': case 'unreachable':
        count(); leaf.attempts++;
        if (leaf.attempts > this.options.retries) failed();
        else { leaf.state = 'queued'; outcome = 'retry'; }
        // An outage affects the provider, including untouched cells. Keep combined cells
        // together and wait even when this cell has spent its retry allowance.
        if (!shared) {
          const wait = failure.retryAfter ?? this.backoff(this.failures, RETRY_BACKOFF);
          if (wait > MAX_COOLDOWN) { this.paused = true; this.pauseReason = failure.code; }
          else { this.cooldownUntil = Math.max(this.cooldownUntil, now + Math.max(MIN_COOLDOWN, wait)); this.cooldownReason = failure.code; }
        }
        break;
      case 'timeout_or_resource_limit': case 'response_too_large':
        count();
        if (leaf.depth >= this.options.maxDepth) { failed(); break; }
        job.leaves.delete(leaf.key);
        for (const tile of children(leaf.tile)) {
          const child: Leaf = { key: tileKey(tile), tile, depth: leaf.depth + 1, state: this.hooks.lookup ? 'lookup' : 'queued', attempts: 0, notBefore: 0 };
          job.leaves.set(child.key, child);
        }
        for (const child of job.leaves.values()) if (child.state === 'lookup' && !child.controller) this.lookup(job, child);
        outcome = 'split';
        break;
      default: failed();
    }
    if (shared) return;
    if (this.failures >= this.options.pauseAfter && !this.paused) { this.paused = true; this.pauseReason = failure.code; }
    this.hooks.failed?.(task, failure, outcome);
  }
}
