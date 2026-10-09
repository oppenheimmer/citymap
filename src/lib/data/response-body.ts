/** Reject a read that receives no bytes within `ms`; the caller cancels the stream. */
function withinIdle<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DOMException('The data download stalled. Retry or choose a smaller area.', 'TimeoutError')), ms);
  });
  return Promise.race([read, stalled]).finally(() => clearTimeout(timer));
}

/**
 * Bound streamed bodies even when Content-Length is absent or compressed. A steadily
 * arriving body may take as long as it needs; a stall longer than `idleMs` fails.
 */
export async function responseBytes(response: Response, limit: number, progress?: (bytes: number) => void, idleMs = 30_000): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid response byte limit');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await withinIdle(reader.read(), idleMs);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('Data response exceeds the byte limit. Choose a smaller area.');
      parts.push(part.value);
      progress?.(bytes);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export async function responseJson(response: Response, limit: number, progress?: (bytes: number) => void): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await responseBytes(response, limit, progress)));
}
