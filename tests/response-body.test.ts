import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseBytes, responseJson } from '../src/lib/data/response-body.ts';

test('streamed response cap rejects absent or misleading lengths and cancels the stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  await assert.rejects(responseBytes(new Response(stream, { headers: { 'Content-Length': '1' } }), 10), /byte limit/);
  assert.equal(cancelled, true);
});
test('bounded response restores bytes and JSON exactly, including Unicode', async () => {
  const text = '{"label":"東京"}', bytes = new TextEncoder().encode(text);
  assert.deepEqual(await responseBytes(new Response(bytes), bytes.length), bytes);
  assert.deepEqual(await responseJson(new Response(bytes), bytes.length), { label: '東京' });
  await assert.rejects(responseJson(new Response('{'), 4), SyntaxError);
});
