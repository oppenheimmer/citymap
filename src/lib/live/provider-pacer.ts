import { CellFailure, FAILURE_CODES, isPublicOverpass } from './overpass.ts';
import type { FailureCode } from './overpass.ts';
import { systemClock } from './scheduler.ts';
import type { Clock } from './scheduler.ts';

export type ProviderWaitReason = FailureCode | 'another_map' | 'previous_request' | 'pacing';
export interface ProviderWait { reason: ProviderWaitReason; until?: number }
interface State { until: number; reason: ProviderWaitReason; failures: number }
type ProviderLock = (key: string, signal: AbortSignal, work: () => Promise<void>) => Promise<void>;
export interface PacerEnvironment {
  /** Epoch milliseconds, shared across tabs; performance.now() is not suitable. */
  clock: Clock;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  lock?: ProviderLock;
}
const DAY = 24 * 60 * 60 * 1000;
const BASE: Partial<Record<FailureCode, number>> = { rate_limited: 5000, provider_busy: 10_000, provider_unavailable: 2000, unreachable: 2000 };
const reasons = new Set<ProviderWaitReason>([...FAILURE_CODES, 'another_map', 'previous_request', 'pacing']);
const browserClock: Clock = { ...systemClock, now: Date.now };

function browserEnvironment(): PacerEnvironment {
  let storage: PacerEnvironment['storage'];
  try { storage = globalThis.localStorage; } catch { /* The lock still keeps tabs paced when storage is denied. */ }
  const locks = globalThis.navigator?.locks;
  return { clock: browserClock, storage, lock: locks ? async (key, signal, work) => { await locks.request(key, { signal }, work); } : undefined };
}

/**
 * A network queue shared by map sessions, and by same-origin tabs through Web Locks.
 * Results return before the post-request pause, so pacing never delays drawing.
 * A persisted reservation protects reloads/cancellation; holding the lock through
 * cooldown also works with denied storage. No Web Locks means in-page coordination.
 */
export class ProviderPacer {
  private readonly key: string;
  private readonly env: PacerEnvironment;
  private memory: State = { until: 0, reason: 'pacing', failures: 0 };
  private tail = Promise.resolve();

  constructor(provider: string, environment = browserEnvironment()) {
    // An origin groups endpoint paths and contains no URL credentials or query strings.
    this.key = `citymap-overpass-v1:${new URL(provider).origin}`;
    this.env = environment;
  }

  run<T>(signal: AbortSignal, reserveMs: number, execute: () => Promise<T>, waiting: (state?: ProviderWait) => void = () => {}, preflight?: () => Promise<{ value: T } | undefined>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (result: { value: T } | { error: unknown }) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', cancel); waiting();
        if ('error' in result) reject(result.error); else resolve(result.value);
      };
      const cancel = () => done({ error: new CellFailure('cancelled') });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      const queued = this.read();
      waiting(queued.until > this.env.clock.now() && queued.reason !== 'previous_request' ? queued : { reason: 'another_map' });
      const work = async () => {
        try {
          const reuse = async () => {
            const hit = await preflight?.();
            if (signal.aborted) throw new CellFailure('cancelled');
            if (hit !== undefined) { done(hit); return true; }
            return false;
          };
          if (preflight && await reuse()) return;
          let state = this.read();
          let waited = false;
          while (state.until > this.env.clock.now()) {
            waited = true;
            waiting(state);
            await this.delay(state.until - this.env.clock.now(), signal);
            state = this.read();
          }
          if (preflight && waited && await reuse()) return;
          if (signal.aborted) throw new CellFailure('cancelled');
          const started = this.env.clock.now();
          // Store before dispatch: closing the tab releases its lock but must not
          // make the next tab assume that the upstream query has stopped.
          const reserved = started + Math.min(DAY, Math.max(1000, reserveMs));
          this.write({ until: reserved, reason: 'previous_request', failures: state.failures });
          waiting();
          let result: { value: T } | { error: unknown };
          try { result = { value: await execute() }; } catch (error) { result = { error }; }
          if (signal.aborted) result = { error: new CellFailure('cancelled') };
          const now = this.env.clock.now(), error = 'error' in result ? result.error : undefined;
          let until: number, reason: ProviderWaitReason = 'pacing', failures = 0;
          if (error instanceof CellFailure && error.code === 'cancelled') {
            until = Math.max(now + 1000, reserved); reason = 'previous_request'; failures = state.failures;
          } else {
            const base = error instanceof CellFailure ? BASE[error.code] : undefined;
            let wait = Math.min(60_000, Math.max(1000, now - started) * (1 + this.env.clock.random() * 0.25));
            if (base && error instanceof CellFailure) {
              failures = Math.min(20, state.failures + 1); reason = error.code;
              wait = error.retryAfter ?? Math.min(60_000, base * 2 ** (failures - 1)) * (0.75 + this.env.clock.random() * 0.5);
            }
            until = now + Math.min(DAY, Math.max(1000, Number.isFinite(wait) ? wait : 60_000));
          }
          this.write({ until, reason, failures });
          done(result);
          // Independent of the old map's abort signal. In particular, denied
          // storage must not let another tab skip this pause by acquiring its lock.
          await this.delay(Math.max(0, until - this.env.clock.now()));
        } catch (error) { done({ error: signal.aborted ? new CellFailure('cancelled') : error }); }
      };
      void this.lock(signal, work).catch(error => done({ error: signal.aborted ? new CellFailure('cancelled') : error }));
    });
  }

  private async lock(signal: AbortSignal, work: () => Promise<void>) {
    if (this.env.lock) {
      let entered = false;
      try { await this.env.lock(this.key, signal, () => { entered = true; return work(); }); return; }
      catch (error) { if (entered || signal.aborted) throw error; }
      // Some embedded/private contexts expose Web Locks but refuse access.
    }
    const next = this.tail.then(() => signal.aborted ? undefined : work());
    this.tail = next.catch(() => {});
    await next;
  }

  private read(): State {
    try {
      const raw = this.env.storage?.getItem(this.key);
      if (raw) {
        const state = JSON.parse(raw) as State;
        if (state && Number.isFinite(state.until) && state.until >= 0 && state.until <= this.env.clock.now() + DAY && reasons.has(state.reason) && Number.isInteger(state.failures) && state.failures >= 0 && state.failures <= 20) this.memory = state;
      }
    } catch { /* Malformed/denied storage falls back to this page's state. */ }
    if (this.env.clock.now() > this.memory.until + 300_000) this.memory = { until: 0, reason: 'pacing', failures: 0 };
    return this.memory;
  }

  private write(state: State) {
    this.memory = state;
    try { this.env.storage?.setItem(this.key, JSON.stringify(state)); } catch { /* Keep in-memory state and the held lock. */ }
  }

  private delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new CellFailure('cancelled')); return; }
      const cancel = () => { this.env.clock.clear(timer); reject(new CellFailure('cancelled')); };
      const timer = this.env.clock.set(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
}

const providers = new Map<string, ProviderPacer>();
/** Private endpoints opt in; known shared public endpoints are always paced. */
export function providerPacer(url: string, enabled = false): ProviderPacer | undefined {
  if (!enabled && !isPublicOverpass(url)) return;
  const key = new URL(url).origin;
  let pacer = providers.get(key);
  if (!pacer) { pacer = new ProviderPacer(url); providers.set(key, pacer); }
  return pacer;
}
