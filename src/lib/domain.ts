export type BBox = [south: number, west: number, north: number, east: number];
export type OSMType = 'node' | 'way' | 'relation';
export interface Boundary {
  key: string;
  name: string;
  kind: string;
  osmId?: string;
  osmType?: OSMType;
  areaId?: string;
  bbox?: BBox;
  fixture?: 'small' | 'medium' | 'large';
  revision?: string;
  manifestSha256?: string;
}
export interface Camera { left: number; right: number; top: number; bottom: number }
/** Projection centre of a prepared geometry; scene coordinates are only meaningful relative to it. */
export type Origin = [lon: number, lat: number];
/** Data-independent view: geographic centre plus projected scene width/height. */
export interface GeoView { lon: number; lat: number; width: number; height: number }
/**
 * How many road classes a map shows. Each level includes the previous one; `all`
 * adds footways/sidewalks, paths, steps, service and parking ways, tracks and the rest.
 */
export type RoadDetail = 'major' | 'streets' | 'all';
export const ROAD_DETAILS: readonly RoadDetail[] = ['major', 'streets', 'all'];
/** Road rank 0 is shown at every detail level, 1 from `streets`, 2 only at `all`. */
export type RoadRank = 0 | 1 | 2;
const MAJOR_ROADS = '(motorway|trunk|primary|secondary|tertiary)(_link)?';
const STREETS = 'unclassified|residential|living_street|pedestrian|road|busway';
const MAJOR_PATTERN = new RegExp(`^${MAJOR_ROADS}$`), STREET_PATTERN = new RegExp(`^(${STREETS})$`);
/** Untagged legacy-cache roads have no class and are always shown. */
export function roadRank(highway: unknown): RoadRank {
  if (typeof highway !== 'string') return 0;
  return MAJOR_PATTERN.test(highway) ? 0 : STREET_PATTERN.test(highway) ? 1 : 2;
}
export const detailRank = (detail: RoadDetail): RoadRank => ROAD_DETAILS.indexOf(detail) as RoadRank;
/** Whether geometry downloaded at `coverage` contains every road shown at `detail`. */
export const covers = (coverage: RoadDetail, detail: RoadDetail) => detailRank(coverage) >= detailRank(detail);
/** Normalized centre of a draggable map mark, as a fraction of the map's width and height. */
export interface MarkPosition { x: number; y: number }
export interface Design {
  roadColor: string;
  roadOpacity: number;
  backgroundColor: string;
  backgroundOpacity: number;
  label: { text: string; x: number; y: number; size: number; color: string; opacity: number };
  detail: RoadDetail;
  north: boolean;
  northAt: MarkPosition;
  scaleBar: boolean;
  /** Clockwise map rotation in degrees, 0–180; the north arrow turns with it. */
  rotation: number;
  /** Unset until moved: the scale bar then sits just below the north arrow. */
  scaleBarAt?: MarkPosition;
  view?: GeoView;
}
export const DEFAULT_DESIGN: Design = {
  roadColor: '#1a1a1a', roadOpacity: 0.8, backgroundColor: '#f7f2e8', backgroundOpacity: 1,
  label: { text: '', x: 0.75, y: 0.83, size: 28, color: '#161616', opacity: 1 },
  detail: 'streets', north: true, northAt: { x: 0.9, y: 0.12 }, scaleBar: true, rotation: 0,
};
/** `cityDataBundled` marks `cityDataBase` as the app's own `/data`, which holds only the bundled cities. */
export interface Providers { cityDataBase: string; cityDataBundled?: boolean; legacyCacheBase: string; overpass: string; search: string }
export interface SourceInfo { kind: 'fixture' | 'r2' | 'legacy' | 'live'; downloadedAt: string; snapshotAt?: string; revision?: string; manifestSha256?: string; complete: boolean; local?: boolean; bundled?: boolean }
export interface PreparationTimings { downloadMs: number; decodeMs: number; indexMs: number; projectMs: number }
/** `ranks` parallels `buffers`; `coverage` is the most detailed level the geometry contains. */
export interface Geometry { buffers: Float32Array[]; ranks: RoadRank[]; coverage: RoadDetail; bounds: Camera; origin: Origin; segmentCount: number; source: SourceInfo; preparation?: PreparationTimings }
export type LoadStage = 'cache' | 'download' | 'decode' | 'project' | 'draw';
/** `bytes` counts decoded bytes received so far; `totalBytes` is present only when the size is known. */
export interface LoadProgress { stage: LoadStage; message: string; bytes?: number; totalBytes?: number; completedChunks?: number; totalChunks?: number }

export function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n) return value;
  throw new Error('Invalid OpenStreetMap identifier');
}

export function bbox(value: unknown): BBox {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('Invalid bounding box');
  const [s, w, n, e] = value as number[];
  if (s < -90 || n > 90 || s >= n || w < -180 || w > 180 || e < -180 || e > 180 || w === e) throw new Error('Invalid bounding box');
  return [s, w, n, e];
}

export function boundaryFromNominatim(value: unknown): Boundary {
  if (!value || typeof value !== 'object') throw new Error('Invalid search result');
  const row = value as Record<string, unknown>;
  const osmId = id(row.osm_id);
  if (!['node', 'way', 'relation'].includes(String(row.osm_type))) throw new Error('Invalid boundary type');
  const osmType = row.osm_type as OSMType;
  if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new Error('Missing place name');
  const box = Array.isArray(row.boundingbox) ? bbox([Number(row.boundingbox[0]), Number(row.boundingbox[2]), Number(row.boundingbox[1]), Number(row.boundingbox[3])]) : undefined;
  const areaId = osmType === 'relation' ? String(BigInt(osmId) + 3600000000n) : osmType === 'way' ? String(BigInt(osmId) + 2400000000n) : undefined;
  if (!areaId && !box) throw new Error('This place has no usable area or bounding box');
  return { key: `osm-${osmType}-${osmId}`, name: row.display_name.slice(0, 1024), kind: typeof row.type === 'string' ? row.type : osmType, osmId, osmType, areaId, bbox: box };
}

/** Live queries download only the road classes shown at `detail`. */
export function overpassQuery(boundary: Boundary, detail: RoadDetail = 'all'): string {
  const way = detail === 'all' ? 'way["highway"]' : `way["highway"~"^(${MAJOR_ROADS}${detail === 'streets' ? `|${STREETS}` : ''})$"]`;
  let selection: string;
  if (boundary.areaId) selection = `area(${id(boundary.areaId)})->.city;${way}(area.city);`;
  else if (boundary.bbox) {
    const [s, w, n, e] = bbox(boundary.bbox);
    selection = w < e ? `${way}(${s},${w},${n},${e});` : `(${way}(${s},${w},${n},180);${way}(${s},-180,${n},${e}););`;
  } else throw new Error('No city area or bounding box was supplied');
  return `[out:json][timeout:120][maxsize:268435456];${selection}out body;>;out skel qt;`;
}

export function publicUrl(value: string, fallback = ''): string {
  if (!value.trim()) return fallback;
  const url = new URL(value, typeof location === 'undefined' ? 'http://localhost' : location.origin);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Provider URL must use HTTPS (HTTP is allowed for localhost)');
  return url.href.replace(/\/+$/, '');
}
