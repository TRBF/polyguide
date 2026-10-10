import type { LatLon } from '@polyguide/shared';

/** Metres per degree for the local equirectangular (ENU) projection (SPEC §4.1). */
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_EQ = 111320;

export interface Projection {
  origin: LatLon;
  toXY(lon: number, lat: number): [number, number];
  toLonLat(x: number, y: number): [number, number];
}

export function makeProjection(origin: LatLon): Projection {
  const kx = Math.cos((origin.lat * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  return {
    origin,
    toXY: (lon, lat) => [(lon - origin.lon) * kx, (lat - origin.lat) * M_PER_DEG_LAT],
    toLonLat: (x, y) => [origin.lon + x / kx, origin.lat + y / M_PER_DEG_LAT],
  };
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export const dist2D = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3D = (a: XYZ, b: XYZ) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Compass bearing (0 = north, clockwise) of the horizontal vector a→b in ENU, in [0, 360). */
export function bearingDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Normalize an angle to (-180, 180]. */
export function normalize180(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/** Distance from point p to segment ab (2D) and the projection parameter t ∈ [0,1]. */
export function pointSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { d: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t };
}
