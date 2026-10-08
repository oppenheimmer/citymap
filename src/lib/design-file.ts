import { parseUrl, shareUrl } from './url-state.ts';
import type { SavedDesign } from './city-storage.ts';

export function designFile(record: SavedDesign, origin: string, pathname: string): string {
  const link = shareUrl(origin, pathname, record.boundary, record.design);
  const parsed = parseUrl(new URL(link).search);
  if (!parsed.boundary || parsed.warning) throw new Error('This saved design has invalid map settings.');
  return JSON.stringify({
    format: 'citymap-design', version: 1, name: record.name,
    savedAt: record.savedAt, boundary: parsed.boundary, design: parsed.design,
    link,
  }, null, 2) + '\n';
}
