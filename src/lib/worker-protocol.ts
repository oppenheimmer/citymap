import type { Boundary, Camera, LoadProgress, Origin, PreparationTimings, Providers, SourceInfo } from './domain.ts';
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
  | { type: 'chunk'; positions: ArrayBuffer; bounds: Camera; origin: Origin; index: number }
  | { type: 'done'; source: SourceInfo; segmentCount: number; preparation?: PreparationTimings }
  | { type: 'large'; bytes: number }
  | { type: 'error'; message: string };
