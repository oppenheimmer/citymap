/**
 * Deterministic synthetic roads for live cell queries: straight meridians and parallels on
 * a lattice per road rank, each extending past the requested box like real OSM ways. Streets
 * also run exactly along street-cell edges, to exercise half-open clipping at seams.
 */
const LATTICE = [{ step: 0.01, offset: 0.0013, highway: 'primary' }, { step: 0.002, offset: 0.0007, highway: 'residential' }, { step: 0.001, offset: 0.00033, highway: 'footway' }] as const;
/** Streets cells are zoom 13 at the test cities' latitudes. */
const EDGE_ZOOM = 13;

export interface CellQuery { rank: 0 | 1 | 2; box: [south: number, west: number, north: number, east: number] }
export function parseCellQuery(query: string): CellQuery | undefined {
  const box = query.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);out geom/)?.slice(1).map(Number);
  if (!box || box.length !== 4) return;
  // The `all` filter excludes the other classes with `!~`; the streets filter names residential.
  const rank = query.includes('!~') ? 2 : query.includes('residential') ? 1 : 0;
  return { rank, box: box as CellQuery['box'] };
}

const range = (from: number, to: number, step: number, offset: number) => {
  const values: number[] = [];
  for (let k = Math.ceil((from - offset) / step); k * step + offset <= to; k++) values.push(Number((k * step + offset).toFixed(9)));
  return values;
};
const edges = (from: number, to: number, toCoordinate: (index: number) => number, toIndex: (value: number) => number) => {
  const values: number[] = [];
  for (let index = Math.ceil(toIndex(from)); toCoordinate(index) <= to; index++) values.push(toCoordinate(index));
  return values;
};
const n = 2 ** EDGE_ZOOM;
const edgeLon = (x: number) => x / n * 360 - 180, edgeX = (lon: number) => (lon + 180) / 360 * n;
const edgeLat = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
const edgeY = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * n;

export function syntheticCell({ rank, box: [south, west, north, east] }: CellQuery) {
  const { step, offset, highway } = LATTICE[rank];
  // Ways run one step beyond the box, with a node every step.
  const lats = range(south - step, north + step, step, offset), lons = range(west - step, east + step, step, offset);
  const elements: unknown[] = [];
  const way = (id: number, points: [number, number][]) => elements.push({ type: 'way', id, tags: { highway }, nodes: points.map((_, i) => id * 100 + i), geometry: points.map(([lon, lat]) => ({ lat, lon })) });
  const meridian = (lon: number) => lats.map(lat => [lon, lat] as [number, number]);
  const parallel = (lat: number) => lons.map(lon => [lon, lat] as [number, number]);
  const id = (kind: number, value: number) => 1_000_000_000 * (rank + 1) + kind * 100_000_000 + Math.round((value + 360) * 100_000) % 100_000_000;
  for (const lon of range(west, east, step, offset)) way(id(1, lon), meridian(lon));
  for (const lat of range(south, north, step, offset)) way(id(2, lat), parallel(lat));
  if (rank === 1) {
    // Edge index rounding keeps a road exactly on an edge within both neighbours' boxes.
    for (const lon of edges(west, east, edgeLon, edgeX)) way(id(3, lon), meridian(lon));
    for (const lat of edges(-north, -south, y => -edgeLat(y), value => edgeY(-value))) way(id(4, -lat), parallel(-lat));
  }
  return { version: 0.6, generator: 'citymap local fixture', osm3s: { timestamp_osm_base: '2026-10-07T00:00:00Z' }, elements };
}
