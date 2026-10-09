import { bbox, DEFAULT_DESIGN, id, ROAD_DETAILS } from './domain.ts';
import type { Boundary, Design, GeoView, OSMType, RoadDetail } from './domain.ts';
import { MAX_LATITUDE } from './view.ts';

function number(value: string | null, fallback: number, min: number, max: number) {
  if (value === null || !value.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
function color(value: string | null, fallback: string) { return value && /^#?[0-9a-f]{6}$/i.test(value) ? `#${value.replace('#', '')}` : fallback; }
/** `view=lon,lat,width,height`: a geographic centre and projected span, independent of the data extent. */
export function parseView(value: string | null): GeoView | undefined {
  if (!value) return;
  const values = value.split(',').map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) return;
  const [lon, lat, width, height] = values;
  if (Math.abs(lon) > 180 || Math.abs(lat) > MAX_LATITUDE || !(width > 0 && width < 1e9 && height > 0 && height < 1e9)) return;
  return { lon, lat, width, height };
}
export function parseUrl(search: string): { query: string; boundary?: Boundary; design: Design; cache: boolean; auto: boolean; warning?: string } {
  const p = new URLSearchParams(search);
  const query = (p.get('q') || '').slice(0, 256);
  const label = DEFAULT_DESIGN.label;
  const design: Design = {
    roadColor: color(p.get('roads') || p.get('lineColor'), DEFAULT_DESIGN.roadColor), roadOpacity: number(p.get('roadOpacity'), 0.8, 0, 1),
    backgroundColor: color(p.get('background') || p.get('backgroundColor'), DEFAULT_DESIGN.backgroundColor), backgroundOpacity: number(p.get('backgroundOpacity'), 1, 0, 1),
    label: { text: (p.get('label') || '').slice(0, 256), color: color(p.get('labelColor'), label.color), opacity: number(p.get('labelOpacity'), 1, 0, 1), x: number(p.get('labelX'), label.x, 0, 1), y: number(p.get('labelY'), label.y, 0, 1), size: number(p.get('labelSize'), label.size, 10, 128) },
    detail: ROAD_DETAILS.includes(p.get('detail') as RoadDetail) ? p.get('detail') as RoadDetail : DEFAULT_DESIGN.detail,
    north: p.get('north') !== '0',
    northAt: { x: number(p.get('northX'), DEFAULT_DESIGN.northAt.x, 0, 1), y: number(p.get('northY'), DEFAULT_DESIGN.northAt.y, 0, 1) },
    scaleBar: p.get('scaleBar') !== '0',
    view: parseView(p.get('view')),
  };
  // A scale bar without its own position follows the north arrow.
  const scaleX = number(p.get('scaleX'), -1, 0, 1), scaleY = number(p.get('scaleY'), -1, 0, 1);
  if (scaleX >= 0 && scaleY >= 0) design.scaleBarAt = { x: scaleX, y: scaleY };
  let boundary: Boundary | undefined, warning: string | undefined;
  if (p.has('v') && p.get('v') !== '2') warning = 'This design link uses an unsupported version. City identifiers can still be loaded.';
  try {
    const sample = p.get('sample');
    const osmType = p.get('osm_type');
    const osmId = p.get('osm_id');
    const areaId = p.get('areaId');
    const box = p.get('bbox');
    if (sample && ['small', 'medium', 'large'].includes(sample)) boundary = { key: `fixture-${sample}`, name: `${sample[0].toUpperCase()}${sample.slice(1)} synthetic grid`, kind: 'synthetic', fixture: sample as 'small' | 'medium' | 'large' };
    else if (areaId || box) {
      if (box && box.split(',').some(value => !value.trim())) throw new Error('Empty bounding coordinate');
      const parsedBox = box ? bbox(box.split(',').map(Number)) : undefined;
      const parsedId = osmId ? id(osmId) : undefined;
      const parsedType = osmType && ['node', 'way', 'relation'].includes(osmType) ? osmType as OSMType : undefined;
      const parsedArea = areaId ? id(areaId) : undefined;
      boundary = { key: parsedId && parsedType ? `osm-${parsedType}-${parsedId}` : parsedArea ? `overpass-area-${parsedArea}` : `bbox-${parsedBox!.join(',')}`, name: query || 'Selected map', kind: 'shared area', osmId: parsedId, osmType: parsedType, areaId: parsedArea, bbox: parsedBox };
    } else if (osmId && osmType && ['node', 'way', 'relation'].includes(osmType)) {
      const parsedId = id(osmId);
      const area = osmType === 'relation' ? String(BigInt(parsedId) + 3600000000n) : osmType === 'way' ? String(BigInt(parsedId) + 2400000000n) : undefined;
      if (area) boundary = { key: `osm-${osmType}-${parsedId}`, name: query || 'Selected map', kind: 'shared city', osmId: parsedId, osmType: osmType as OSMType, areaId: area };
    }
    if (boundary && p.has('revision')) {
      const revision = p.get('revision'), hash = p.get('manifestHash');
      if (!revision || !hash || !/^[a-f0-9]{64}$/.test(revision) || !/^[a-f0-9]{64}$/.test(hash) || !/^osm-/.test(boundary.key)) throw new Error('Invalid immutable dataset link');
      boundary.revision = revision; boundary.manifestSha256 = hash;
    }
  } catch { boundary = undefined; warning = 'This link contains an invalid city identifier or bounding box. Search for a city to continue.'; }
  const cache = !['0', 'false', 'no'].includes(p.get('cache') || '');
  const auto = ['1', 'true', 'yes'].includes(p.get('auto') || '') && !warning;
  return { query, boundary, design, cache, auto, warning };
}

export function shareUrl(origin: string, path: string, boundary: Boundary, design: Design, useCache = true): string {
  const url = new URL(path, origin);
  const p = url.searchParams;
  p.set('v', '2'); p.set('q', boundary.name); p.set('auto', '1');
  if (boundary.fixture) p.set('sample', boundary.fixture);
  if (boundary.areaId) p.set('areaId', boundary.areaId);
  if (boundary.osmId) p.set('osm_id', boundary.osmId);
  if (boundary.osmType) p.set('osm_type', boundary.osmType);
  if (boundary.bbox) p.set('bbox', boundary.bbox.join(','));
  if (boundary.revision && boundary.manifestSha256) { p.set('revision', boundary.revision); p.set('manifestHash', boundary.manifestSha256); }
  if (!useCache) p.set('cache', '0');
  p.set('roads', design.roadColor.slice(1)); p.set('roadOpacity', String(design.roadOpacity));
  p.set('background', design.backgroundColor.slice(1)); p.set('backgroundOpacity', String(design.backgroundOpacity));
  p.set('label', design.label.text); p.set('labelColor', design.label.color.slice(1)); p.set('labelOpacity', String(design.label.opacity));
  p.set('labelX', String(design.label.x)); p.set('labelY', String(design.label.y)); p.set('labelSize', String(design.label.size));
  // Designs saved before these settings existed keep the defaults.
  if (design.detail) p.set('detail', design.detail);
  if (design.north === false) p.set('north', '0');
  if (design.northAt) { p.set('northX', String(design.northAt.x)); p.set('northY', String(design.northAt.y)); }
  if (design.scaleBar === false) p.set('scaleBar', '0');
  if (design.scaleBarAt) { p.set('scaleX', String(design.scaleBarAt.x)); p.set('scaleY', String(design.scaleBarAt.y)); }
  if (design.view) p.set('view', [design.view.lon.toFixed(7), design.view.lat.toFixed(7), design.view.width.toFixed(2), design.view.height.toFixed(2)].map(Number).join(','));
  return url.href;
}
