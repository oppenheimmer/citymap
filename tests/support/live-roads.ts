/**
 * Deterministic synthetic roads for live cell queries: straight meridians and parallels on
 * a lattice per road rank, each extending past the requested box like real OSM ways. Streets
 * also run exactly along street-cell edges, to exercise half-open clipping at seams.
 */
const LATTICE = [{ step: 0.01, offset: 0.0013, highway: 'primary' }, { step: 0.002, offset: 0.0007, highway: 'residential' }, { step: 0.001, offset: 0.00033, highway: 'footway' }] as const;
/** Streets cells are zoom 13 at the test cities' latitudes. */
const EDGE_ZOOM = 13;

export interface CellQuery { rank: 0 | 1 | 2; box: [south: number, west: number, north: number, east: number] }
/** The cells of a live query: one `way[filter](s,w,n,e)` statement each, alone or in a union. */
export function parseCellQueries(query: string): CellQuery[] {
  if (!query.includes('out geom')) return [];
  return query.split(';').flatMap(statement => {
    const match = statement.match(/^\(?way(.*)\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)$/);
    if (!match) return [];
    // The `all` filter excludes the other classes with `!~`; the streets filter names residential.
    const rank = match[1].includes('!~') ? 2 : match[1].includes('residential') ? 1 : 0;
    return [{ rank, box: match.slice(2).map(Number) as CellQuery['box'] }];
  });
}
/** A stable name for a requested cell, for counting repeats across requests. */
export const cellName = ({ rank, box }: CellQuery) => `${rank}:${box.join(',')}`;

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

/**
 * Roads for the cells of one query. Like Overpass, each road is one way, returned once, across
 * every requested box of its rank it crosses, running one step beyond them with a node every step.
 */
export function syntheticCells(cells: CellQuery[]) {
  const elements: unknown[] = [];
  for (const rank of [0, 1, 2] as const) {
    const boxes = cells.filter(cell => cell.rank === rank).map(cell => cell.box);
    if (!boxes.length) continue;
    const { step, offset, highway } = LATTICE[rank];
    const way = (id: number, points: [number, number][]) => elements.push({ type: 'way', id, tags: { highway }, nodes: points.map((_, i) => id * 100 + i), geometry: points.map(([lon, lat]) => ({ lat, lon })) });
    const id = (kind: number, value: number) => 1_000_000_000 * (rank + 1) + kind * 100_000_000 + Math.round((value + 360) * 100_000) % 100_000_000;
    // Each road's extent across the boxes it crosses: latitudes for meridians, longitudes for parallels.
    const extend = (roads: Map<number, [number, number]>, value: number, from: number, to: number) => { const [a, b] = roads.get(value) || [Infinity, -Infinity]; roads.set(value, [Math.min(a, from), Math.max(b, to)]); };
    const meridians = new Map<number, [number, number]>(), parallels = new Map<number, [number, number]>(), edgeMeridians = new Map<number, [number, number]>(), edgeParallels = new Map<number, [number, number]>();
    for (const [south, west, north, east] of boxes) {
      for (const lon of range(west, east, step, offset)) extend(meridians, lon, south, north);
      for (const lat of range(south, north, step, offset)) extend(parallels, lat, west, east);
      if (rank !== 1) continue;
      // Edge index rounding keeps a road exactly on an edge within both neighbours' boxes.
      for (const lon of edges(west, east, edgeLon, edgeX)) extend(edgeMeridians, lon, south, north);
      for (const lat of edges(-north, -south, y => -edgeLat(y), value => edgeY(-value))) extend(edgeParallels, -lat, west, east);
    }
    const meridian = (lon: number, [south, north]: [number, number]) => range(south - step, north + step, step, offset).map(lat => [lon, lat] as [number, number]);
    const parallel = (lat: number, [west, east]: [number, number]) => range(west - step, east + step, step, offset).map(lon => [lon, lat] as [number, number]);
    for (const [lon, extent] of meridians) way(id(1, lon), meridian(lon, extent));
    for (const [lat, extent] of parallels) way(id(2, lat), parallel(lat, extent));
    for (const [lon, extent] of edgeMeridians) way(id(3, lon), meridian(lon, extent));
    for (const [lat, extent] of edgeParallels) way(id(4, lat), parallel(lat, extent));
  }
  return { version: 0.6, generator: 'citymap local fixture', osm3s: { timestamp_osm_base: '2026-10-07T00:00:00Z' }, elements };
}
