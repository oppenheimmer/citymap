import { projector } from '../lib/geometry.ts';
import { cellRoads } from '../lib/live/cell-roads.ts';
import { tileRect } from '../lib/live/grid.ts';
import { CellFailure, cellsQuery, FAILURE_CODES, fetchCell, queryTimeout } from '../lib/live/overpass.ts';
import type { CellCommand, CellReply, CellRequest } from '../lib/worker-protocol.ts';

const scope = self as unknown as { onmessage: (event: MessageEvent<CellCommand>) => void; postMessage: (message: CellReply, transfer?: Transferable[]) => void };
const active = new Map<number, AbortController>();
// Transport limits per request; a larger or slower request is retried cell by cell, then split.
const MAX_BYTES = 32 * 1024 * 1024, IDLE = 30_000, MAX_CELLS = 8;

const validTile = (tile: CellRequest['cells'][number]['tile']) => Number.isInteger(tile?.z) && tile.z >= 0 && tile.z <= 22 && Number.isInteger(tile.x) && Number.isInteger(tile.y) && tile.x >= 0 && tile.y >= 0 && tile.x < 2 ** tile.z && tile.y < 2 ** tile.z;
function valid({ id, cells, origin, overpass }: CellRequest) {
  return Number.isSafeInteger(id) && Array.isArray(cells) && cells.length >= 1 && cells.length <= MAX_CELLS && cells.every(cell => validTile(cell?.tile) && [0, 1, 2].includes(cell.rank))
    && Array.isArray(origin) && origin.every(Number.isFinite) && Math.abs(origin[0]) <= 180 && Math.abs(origin[1]) < 86 && typeof overpass === 'string';
}

async function load(request: CellRequest, signal: AbortSignal) {
  if (!valid(request)) throw new CellFailure('invalid_request', { message: 'Invalid cell request' });
  const started = performance.now();
  // Overpass computes before it answers: allow the query's own time limit, and some more.
  const deadline = (queryTimeout(request.cells.length) + 20) * 1000;
  const { data, bytes } = await fetchCell({ url: request.overpass, query: cellsQuery(request.cells), signal, maxBytes: MAX_BYTES, deadline, idle: IDLE });
  const fetched = performance.now();
  const [lon, lat] = request.origin, { project } = projector([lon, lat, lon, lat]);
  // Each cell keeps the ways of its rank, clipped to it, as if it had been fetched alone.
  const cells = request.cells.map(cell => cellRoads(data, project, tileRect(cell.tile, request.origin), cell.rank));
  return { cells, bytes, fetchMs: fetched - started, decodeMs: performance.now() - fetched };
}

scope.onmessage = async ({ data: command }) => {
  if (command.type === 'abort') { active.get(command.id)?.abort(); return; }
  if (command.type !== 'fetch') return;
  const controller = new AbortController();
  active.set(command.id, controller);
  try {
    const { cells, bytes, fetchMs, decodeMs } = await load(command, controller.signal);
    if (controller.signal.aborted) return;
    const results = cells.map(roads => ({ positions: roads.positions.buffer as ArrayBuffer, segments: roads.segments }));
    scope.postMessage({ type: 'cells', id: command.id, cells: results, bytes, fetchMs, decodeMs, snapshotAt: cells[0]?.snapshotAt }, results.map(result => result.positions));
  } catch (error) {
    if (controller.signal.aborted) return;
    const failure = error instanceof CellFailure && FAILURE_CODES.includes(error.code) ? error : new CellFailure('decode_failure', { message: error instanceof Error ? error.message : undefined });
    scope.postMessage({ type: 'failure', id: command.id, code: failure.code, status: failure.status, retryAfter: failure.retryAfter, remark: failure.remark, message: failure.message.slice(0, 200) });
  } finally { active.delete(command.id); }
};
