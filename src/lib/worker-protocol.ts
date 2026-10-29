import type { Boundary, Camera, LoadProgress, Origin, PreparationTimings, Providers, RoadDetail, RoadRank, SourceInfo } from './domain.ts';
import type { Tile } from './live/grid.ts';
import type { FailureCode } from './live/overpass.ts';
export interface WorkerLoad {
  boundary: Boundary;
  providers: Providers;
  fixtureUrl?: string;
  useCache: boolean;
  allowLarge: boolean;
  forceNetwork?: boolean;
  /** Live downloads fetch only these road classes; cached datasets contain every class. */
  detail: RoadDetail;
  /** Without a stored dataset, hand over to live loading by map view instead of one area query. */
  viewport?: boolean;
}
export type WorkerCommand = WorkerLoad | { type: 'cancel' } | { type: 'ack'; id: number };
export type WorkerResult =
  | { type: 'cancelled' }
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'chunk'; positions: ArrayBuffer; bounds: Camera; origin: Origin; index: number; rank: RoadRank; id?: number }
  | { type: 'done'; source: SourceInfo; segmentCount: number; coverage: RoadDetail; preparation?: PreparationTimings }
  | { type: 'large'; bytes: number }
  /** No stored dataset applies: the map loads live roads by view. */
  | { type: 'viewport' }
  /** `diagnostic` is sanitized provider detail for development logs, never for display. */
  | { type: 'error'; message: string; diagnostic?: string };

/** Live cells, each one road rank of one tile, fetched in one request and projected for the session origin. */
export interface CellRequest { type: 'fetch'; id: number; cells: { tile: Tile; rank: RoadRank }[]; origin: Origin; overpass: string }
export type CellCommand = CellRequest | { type: 'abort'; id: number };
/** `cells` parallels the request's cells; the byte count and times are the whole request's. */
export type CellReply =
  | { type: 'cells'; id: number; cells: { positions: ArrayBuffer; segments: number }[]; bytes: number; fetchMs: number; decodeMs: number; snapshotAt?: string }
  | { type: 'failure'; id: number; code: FailureCode; status?: number; retryAfter?: number; remark?: string; message?: string };
