import type { Boundary, Camera, GeoView, Origin, RoadDetail } from '../domain.ts';
import { projector } from '../geometry.ts';
import { metresPerSceneUnit } from '../scale-bar.ts';
import { MAX_LATITUDE, RAD, SCALE, wrapLongitude } from '../view.ts';

/**
 * Ground width of a searched place's first view by road detail. A wider view needs more
 * live cells before it is complete; users can zoom out or Fit map to the whole place.
 */
export const START_METRES: Record<RoadDetail, number> = { major: 30_000, streets: 5_000, all: 2_500 };

/**
 * `origin` fixes the scene projection for the whole session, so cells loaded at any time
 * line up. `bounds` frames the place for Fit map. `camera` is the first view, unless a
 * shared design view applies.
 */
export interface LiveStart { origin: Origin; bounds: Camera; camera?: Camera }

export function liveStart(boundary: Boundary, view: GeoView | undefined, detail: RoadDetail): LiveStart | undefined {
  const box = boundary.bbox;
  // Bounding boxes may cross the antimeridian (west > east).
  const span = box ? (box[3] - box[1] + 360) % 360 || 360 : 0;
  const centre = view ? [view.lon, view.lat] : boundary.center || (box && [wrapLongitude(box[1] + span / 2), (box[0] + box[2]) / 2]);
  if (!centre) return;
  const origin: Origin = [Math.abs(centre[0]) <= 180 ? centre[0] : wrapLongitude(centre[0]), Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, centre[1]))];
  const { project } = projector([origin[0], origin[1], origin[0], origin[1]]);
  const [cx, cy] = project(...origin);
  const half = START_METRES[detail] / metresPerSceneUnit(origin[1]) / 2;
  let place: Camera = { left: cx - half, right: cx + half, bottom: cy - half, top: cy + half };
  if (box) {
    const clamp = (lat: number) => Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
    const [west, south] = project(box[1], clamp(box[0])), [east, north] = project(wrapLongitude(box[1] + span), clamp(box[2]));
    // Longitudes project relative to the origin; an east edge beyond 180° from it wraps around.
    place = { left: west, right: east < west ? east + 360 * RAD * SCALE : east, bottom: south, top: north };
  }
  const pad = Math.max(place.right - place.left, place.top - place.bottom, 1) * 0.12;
  const bounds = { left: place.left - pad, right: place.right + pad, bottom: place.bottom - pad, top: place.top + pad };
  if (view) return { origin, bounds };
  // An explicitly drawn box is shown whole. A searched place starts at a bounded view of its
  // centre, never its whole administrative area, so the first live requests stay small.
  if (box && boundary.kind === 'bounding box') return { origin, bounds, camera: bounds };
  const size = box ? Math.min(2 * half, Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom)) : 2 * half;
  return { origin, bounds, camera: { left: cx - size / 2, right: cx + size / 2, bottom: cy - size / 2, top: cy + size / 2 } };
}
