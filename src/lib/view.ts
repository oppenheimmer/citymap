import type { Camera, GeoView, Origin } from './domain.ts';

// Mirrors projector() in geometry.ts: d3 Mercator at this scale, translated to [480, 250],
// rotated to the origin longitude, centred on the origin latitude and y-flipped for the scene.
// Mercator is linear in longitude, so changing the origin only translates the scene.
export const SCALE = 6371393;
const TX = 480, TY = 250, RAD = Math.PI / 180;
export const MAX_LATITUDE = 85.0511;

const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
export const wrapLongitude = (lon: number) => ((lon + 540) % 360 + 360) % 360 - 180;

export function viewFromCamera(camera: Camera, origin: Origin): GeoView {
  const x = (camera.left + camera.right) / 2, y = (camera.top + camera.bottom) / 2;
  const lat = (2 * Math.atan(Math.exp((y + TY) / SCALE + mercator(origin[1]))) - Math.PI / 2) / RAD;
  return { lon: wrapLongitude(origin[0] + (x - TX) / SCALE / RAD), lat: Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)), width: camera.right - camera.left, height: camera.top - camera.bottom };
}

/** The frame an export of `aspect` shows: the same centre, widened so both spans fit. */
export function fitCamera(camera: Camera, aspect: number): Camera {
  const height = Math.max(camera.top - camera.bottom, (camera.right - camera.left) / aspect);
  const cx = (camera.left + camera.right) / 2, cy = (camera.top + camera.bottom) / 2;
  return { left: cx - height * aspect / 2, right: cx + height * aspect / 2, bottom: cy - height / 2, top: cy + height / 2 };
}

export function cameraFromView(view: GeoView, origin: Origin): Camera {
  const x = TX + wrapLongitude(view.lon - origin[0]) * RAD * SCALE;
  const y = (mercator(view.lat) - mercator(origin[1])) * SCALE - TY;
  return { left: x - view.width / 2, right: x + view.width / 2, bottom: y - view.height / 2, top: y + view.height / 2 };
}
