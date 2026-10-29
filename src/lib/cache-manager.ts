import { clearCityCache, listCityCache } from './city-storage.ts';
import { clearCellCache, listCellCache } from './live/cell-cache.ts';
export { listCityCache, listCellCache };
export async function clearLocalMaps() {
  const [cities, cells] = await Promise.all([clearCityCache(), clearCellCache()]);
  return { ok: cities && cells, message: cities && cells ? 'Saved city geometry cleared. Road fragments cleared. Designs are preserved.' : cities || cells ? 'Some local maps were cleared. One cache is unavailable; retry to finish. Designs are preserved.' : 'Local cache is unavailable in this browser. Designs are preserved.' };
}
export interface CloudObject { key: string; bytes: number; modified: string }
export interface CloudCity { key: string; count: number; bytes: number; modified: string }
export function cloudCities(objects: CloudObject[]): CloudCity[] {
  const cities = new Map<string, CloudCity>();
  for (const object of objects) {
    const match = /^v2\/cities\/(osm-(?:node|way|relation)-[1-9][0-9]*)\//.exec(object.key);
    if (!match) continue;
    const entry = cities.get(match[1]) || { key: match[1], count: 0, bytes: 0, modified: object.modified };
    entry.count++; entry.bytes += object.bytes;
    if (object.modified > entry.modified) entry.modified = object.modified;
    cities.set(entry.key, entry);
  }
  return [...cities.values()].sort((a, b) => a.key.localeCompare(b.key));
}
