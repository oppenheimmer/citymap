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
export async function request(url: string, options: RequestInit & { signal: AbortSignal }, deadline = 150_000): Promise<Response> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(deadline)]);
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
