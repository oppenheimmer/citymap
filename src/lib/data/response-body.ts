/** Bound streamed bodies even when Content-Length is absent or compressed. */
export async function responseBytes(response: Response, limit: number, progress?: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid response byte limit');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
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
