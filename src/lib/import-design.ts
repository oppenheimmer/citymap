import { bbox, id, MAP_FONTS, ROAD_DETAILS } from './domain.ts';
import type { Boundary, Design } from './domain.ts';
import { parseUrl, shareUrl } from './url-state.ts';

export const MAX_DESIGN_FILE_BYTES = 64 * 1024;
export interface ImportedDesign { name: string; boundary: Boundary; design: Design }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The file has invalid ${name}.`);
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`The file has an invalid ${name}.`);
}
function color(value: unknown) { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('The file has an invalid color.'); }
function position(value: unknown, name: string) {
  const at = object(value, name); number(at.x, `${name} position`, 0, 1); number(at.y, `${name} position`, 0, 1);
}

/** Validate settings and reconstruct their link on this app; never navigate a file-supplied URL. */
export function importDesign(text: string, origin: string, pathname: string, allowFixtures = false): ImportedDesign {
  if (text.length > MAX_DESIGN_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_DESIGN_FILE_BYTES) throw new Error('Design files must be 64 KB or smaller.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('This is not a readable JSON file. Choose a Citymap design file.'); }
  const file = object(value, 'design settings');
  if (file.format !== 'citymap-design' || file.version !== 1) throw new Error('This file uses an unsupported design format or version.');
  const boundary = object(file.boundary, 'city settings'), design = object(file.design, 'map settings');
  if (typeof boundary.name !== 'string' || !boundary.name.trim() || boundary.name.length > 1024) throw new Error('The file has an invalid city name.');
  if (boundary.osmId !== undefined) id(boundary.osmId);
  if (boundary.areaId !== undefined) id(boundary.areaId);
  if (boundary.osmType !== undefined && !['node', 'way', 'relation'].includes(String(boundary.osmType))) throw new Error('The file has an invalid city identifier.');
  if ((boundary.osmType === undefined) !== (boundary.osmId === undefined)) throw new Error('The file has an incomplete city identifier.');
  if (boundary.bbox !== undefined) bbox(boundary.bbox);
  if (boundary.fixture !== undefined && (!allowFixtures || !['small', 'medium', 'large'].includes(String(boundary.fixture)))) throw new Error('Test maps cannot be imported in this app.');
  for (const field of ['revision', 'manifestSha256']) if (boundary[field] !== undefined && (typeof boundary[field] !== 'string' || !/^[a-f0-9]{64}$/.test(boundary[field]))) throw new Error('The file has an invalid dataset revision.');
  if ((boundary.revision === undefined) !== (boundary.manifestSha256 === undefined)) throw new Error('The file has an incomplete dataset revision.');
  for (const field of ['roadColor', 'backgroundColor']) color(design[field]);
  for (const field of ['roadOpacity', 'backgroundOpacity']) number(design[field], 'opacity', 0, 1);
  const label = object(design.label, 'label settings');
  if (typeof label.text !== 'string' || label.text.length > 256) throw new Error('Map labels must be 256 characters or shorter.');
  color(label.color); number(label.opacity, 'label opacity', 0, 1); number(label.size, 'label size', 10, 128); position(label, 'label');
  for (const field of ['bold', 'italic']) if (label[field] !== undefined && typeof label[field] !== 'boolean') throw new Error('The file has an invalid label style.');
  for (const field of ['north', 'scaleBar']) if (design[field] !== undefined && typeof design[field] !== 'boolean') throw new Error('The file has an invalid map mark setting.');
  for (const field of ['northAt', 'scaleBarAt']) if (design[field] !== undefined) position(design[field], 'map mark');
  if (design.rotation !== undefined) number(design.rotation, 'rotation', -180, 180);
  if (design.detail !== undefined && !ROAD_DETAILS.includes(design.detail as Design['detail'])) throw new Error('The file has an invalid road detail setting.');
  if (design.font !== undefined && !MAP_FONTS.includes(design.font as Design['font'])) throw new Error('The file has an invalid typeface.');
  if (design.view !== undefined) {
    const view = object(design.view, 'map view');
    number(view.lon, 'longitude', -180, 180); number(view.lat, 'latitude', -85.0511, 85.0511);
    number(view.width, 'map width', Number.MIN_VALUE, 1e9 - 1); number(view.height, 'map height', Number.MIN_VALUE, 1e9 - 1);
  }
  const parsed = parseUrl(new URL(shareUrl(origin, pathname, boundary as unknown as Boundary, design as unknown as Design)).search);
  if (!parsed.boundary || parsed.warning) throw new Error('The file has an invalid city or map view.');
  return { name: typeof file.name === 'string' ? file.name.slice(0, 1024) : boundary.name, boundary: parsed.boundary, design: parsed.design };
}
