import type { Camera } from './domain.ts';

/** Cached axes of a rotated camera; testing collections requires no temporary arrays. */
export interface VisibilityFrame { x: number; y: number; halfWidth: number; halfHeight: number; cos: number; sin: number }

export function visibilityFrame(camera: Camera, rotation: number, margin = 0): VisibilityFrame {
  const angle = rotation * Math.PI / 180;
  return { x: (camera.left + camera.right) / 2, y: (camera.bottom + camera.top) / 2,
    halfWidth: (camera.right - camera.left) / 2 + margin, halfHeight: (camera.top - camera.bottom) / 2 + margin,
    cos: Math.cos(angle), sin: Math.sin(angle) };
}

/** Separating axes of an axis-aligned collection and rotated frame; touching stays visible. */
export function withinFrame(bounds: Camera, frame: VisibilityFrame): boolean {
  const x = (bounds.left + bounds.right) / 2 - frame.x, y = (bounds.bottom + bounds.top) / 2 - frame.y;
  const hw = (bounds.right - bounds.left) / 2, hh = (bounds.top - bounds.bottom) / 2;
  const c = Math.abs(frame.cos), s = Math.abs(frame.sin);
  return Math.abs(x) <= hw + frame.halfWidth * c + frame.halfHeight * s
    && Math.abs(y) <= hh + frame.halfWidth * s + frame.halfHeight * c
    && Math.abs(x * frame.cos + y * frame.sin) <= frame.halfWidth + hw * c + hh * s
    && Math.abs(-x * frame.sin + y * frame.cos) <= frame.halfHeight + hw * s + hh * c;
}

export function geometryBounds(positions: Float32Array): Camera {
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i], y = positions[i + 1];
    if (x < left) left = x; if (x > right) right = x;
    if (y < bottom) bottom = y; if (y > top) top = y;
  }
  return { left, right, bottom, top };
}
