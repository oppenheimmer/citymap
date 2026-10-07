import type Pbf from 'pbf';
import type { CityRoadChunk as Chunk, RoadPolyline as Road } from '../lib/data/city-types.ts';

export const CityRoadChunk: {
  read(pbf: Pbf, end?: number): Chunk;
  write(chunk: Chunk, pbf: Pbf): void;
};
export const RoadPolyline: {
  read(pbf: Pbf, end?: number): Road;
  write(road: Road, pbf: Pbf): void;
};
