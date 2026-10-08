import type { Boundary, Camera, LoadProgress, Providers, SourceInfo } from './domain.ts';
export interface WorkerLoad {
  boundary: Boundary;
  providers: Providers;
  fixtureUrl?: string;
  useCache: boolean;
  allowLarge: boolean;
  forceNetwork?: boolean;
}
export type WorkerCommand = WorkerLoad | { type: 'cancel' };
export type WorkerResult =
  | { type: 'cancelled' }
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'chunk'; positions: ArrayBuffer; bounds: Camera; index: number }
  | { type: 'done'; source: SourceInfo; segmentCount: number }
  | { type: 'large'; bytes: number }
  | { type: 'error'; message: string };
