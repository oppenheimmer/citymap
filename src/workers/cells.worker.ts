import { projector } from '../lib/geometry.ts';
import { cellRoads } from '../lib/live/cell-roads.ts';
import { tileRect } from '../lib/live/grid.ts';
import { CELL_LIMITS, CellFailure, cellQuery, FAILURE_CODES, fetchCell } from '../lib/live/overpass.ts';
import type { CellCommand, CellReply, CellRequest } from '../lib/worker-protocol.ts';

const scope = self as unknown as { onmessage: (event: MessageEvent<CellCommand>) => void; postMessage: (message: CellReply, transfer?: Transferable[]) => void };
const active = new Map<number, AbortController>();
// Per-cell transport limits; a larger or slower cell is split by the scheduler instead.
const MAX_BYTES = 32 * 1024 * 1024, DEADLINE = (CELL_LIMITS.timeout + 20) * 1000, IDLE = 30_000;

function valid({ id, tile, rank, origin, overpass }: CellRequest) {
  return Number.isSafeInteger(id) && Number.isInteger(tile?.z) && tile.z >= 0 && tile.z <= 22 && Number.isInteger(tile.x) && Number.isInteger(tile.y) && tile.x >= 0 && tile.y >= 0 && tile.x < 2 ** tile.z && tile.y < 2 ** tile.z
    && [0, 1, 2].includes(rank) && Array.isArray(origin) && origin.every(Number.isFinite) && Math.abs(origin[0]) <= 180 && Math.abs(origin[1]) < 86 && typeof overpass === 'string';
}

async function load(request: CellRequest, signal: AbortSignal) {
  if (!valid(request)) throw new CellFailure('invalid_request', { message: 'Invalid cell request' });
  const started = performance.now();
  const { data, bytes } = await fetchCell({ url: request.overpass, query: cellQuery(request.tile, request.rank), signal, maxBytes: MAX_BYTES, deadline: DEADLINE, idle: IDLE });
  const fetched = performance.now();
  const [lon, lat] = request.origin;
  const roads = cellRoads(data, projector([lon, lat, lon, lat]).project, tileRect(request.tile, request.origin), request.rank);
  return { roads, bytes, fetchMs: fetched - started, decodeMs: performance.now() - fetched };
}

scope.onmessage = async ({ data: command }) => {
  if (command.type === 'abort') { active.get(command.id)?.abort(); return; }
  if (command.type !== 'fetch') return;
  const controller = new AbortController();
  active.set(command.id, controller);
  try {
    const { roads, bytes, fetchMs, decodeMs } = await load(command, controller.signal);
    if (controller.signal.aborted) return;
    const positions = roads.positions.buffer as ArrayBuffer;
    scope.postMessage({ type: 'cell', id: command.id, positions, segments: roads.segments, bytes, fetchMs, decodeMs, snapshotAt: roads.snapshotAt }, [positions]);
  } catch (error) {
    if (controller.signal.aborted) return;
    const failure = error instanceof CellFailure && FAILURE_CODES.includes(error.code) ? error : new CellFailure('decode_failure', { message: error instanceof Error ? error.message : undefined });
    scope.postMessage({ type: 'failure', id: command.id, code: failure.code, status: failure.status, retryAfter: failure.retryAfter, remark: failure.remark, message: failure.message.slice(0, 200) });
  } finally { active.delete(command.id); }
};
