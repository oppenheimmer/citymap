export class RequestError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.name = 'RequestError'; this.status = status; }
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
/**
 * `deadline` bounds the wait for response headers, including one retry. Body reads are
 * bounded by responseBytes' stall timeout instead, so a large download that keeps
 * arriving is not cut off part-way. Cancelling `options.signal` aborts either phase.
 */
export async function request(url: string, options: RequestInit & { signal: AbortSignal }, deadline = 150_000): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('The data service did not respond in time. Retry or choose a smaller area.', 'TimeoutError')), deadline);
  try { return await fetchWithRetry(url, options, AbortSignal.any([options.signal, timeout.signal])); }
  finally { clearTimeout(timer); }
}
async function fetchWithRetry(url: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try { response = await fetch(url, { ...options, signal }); }
    catch {
      if (signal.aborted) throw signal.reason;
      if (attempt >= 1) throw new RequestError('The data service could not be reached. Check your connection and retry.');
      await sleep(500, signal);
      continue;
    }
    if (response.ok) return response;
    if (attempt < 1 && [429, 502, 503, 504].includes(response.status)) {
      const retry = response.headers.get('Retry-After');
      const seconds = retry ? Number(retry) : NaN;
      const wait = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 1000;
      // A long provider cooldown is surfaced instead of retrying earlier than requested.
      await response.body?.cancel();
      if (wait > 5000) throw new RequestError('The provider is busy. Please retry later.', response.status);
      await sleep(Math.max(500, wait || 1000), signal);
      continue;
    }
    await response.body?.cancel();
    throw new RequestError(`Data request failed (${response.status}).`, response.status);
  }
}
