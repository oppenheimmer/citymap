/** Shared across tabs. The IDB marker also guards queued transactions when storage is denied. */
export const GENERATION_KEY = '!citymap-generation';
export class CacheGeneration {
  private value = 0;
  private readonly key: string;
  constructor(name: string) { this.key = `citymap:cache-generation:${name}`; }
  read(): number {
    try { this.observe(Number(localStorage.getItem(this.key))); } catch { /* Storage may be denied. */ }
    return this.value;
  }
  observe(value: unknown) { if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) this.value = Math.max(this.value, value); }
  invalidate(): number { this.value = this.read() + 1; this.publish(); return this.value; }
  publish() { try { localStorage.setItem(this.key, String(this.value)); } catch { /* The IDB marker remains authoritative. */ } }
}

export interface LocalCacheEntry { key: string; label: string; bytes: number; savedAt: number; detail?: string }
