import type Pbf from 'pbf';

export interface LegacyPlace {
  version: number;
  name: string;
  date: string;
  id: string;
  nodes: { id: number; lat: number; lon: number }[];
  ways: { nodes: number[] }[];
}

export const place: {
  read(pbf: Pbf, end?: number): LegacyPlace;
  write(value: LegacyPlace, pbf: Pbf): void;
};
