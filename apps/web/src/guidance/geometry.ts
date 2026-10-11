/**
 * Route geometry on [lon, lat] polylines: walking along a step, the bearing to the next path node, and
 * projecting a known position (a sign read, the user's word) back onto the route. Flat-earth metres are
 * plenty at building scale.
 */
import type { RouteStep } from '@polyguide/shared';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

export const norm360 = (d: number) => ((d % 360) + 360) % 360;
const bearingOf = (dx: number, dy: number) => norm360((Math.atan2(dx, dy) * 180) / Math.PI);

/** Point `distM` along a [lon, lat] polyline (clamped to its ends). */
export function pointAlong(polyline: [number, number][], distM: number): { lat: number; lon: number } | null {
  if (!polyline.length) return null;
  let left = Math.max(0, distM);
  for (let i = 1; i < polyline.length; i++) {
    const [lon0, lat0] = polyline[i - 1];
    const [lon1, lat1] = polyline[i];
    const kx = M_PER_DEG_LON(lat0);
    const seg = Math.hypot((lon1 - lon0) * kx, (lat1 - lat0) * M_PER_DEG_LAT);
    if (seg >= left && seg > 0) {
      const t = left / seg;
      return { lon: lon0 + (lon1 - lon0) * t, lat: lat0 + (lat1 - lat0) * t };
    }
    left -= seg;
  }
  const [lon, lat] = polyline[polyline.length - 1];
  return { lat, lon };
}

/** Compass bearing of the polyline segment `distM` along it (the way the route goes from there). */
export function bearingAt(polyline: [number, number][], distM: number): number | null {
  let left = Math.max(0, distM);
  let last: number | null = null;
  for (let i = 1; i < polyline.length; i++) {
    const [lon0, lat0] = polyline[i - 1];
    const [lon1, lat1] = polyline[i];
    const dx = (lon1 - lon0) * M_PER_DEG_LON(lat0);
    const dy = (lat1 - lat0) * M_PER_DEG_LAT;
    const seg = Math.hypot(dx, dy);
    if (seg < 0.3) continue;
    last = bearingOf(dx, dy);
    // Within a metre of a bend, the next segment is the one to face.
    if (seg - left > 1) return last;
    left -= seg;
  }
  return last;
}

/**
 * The next node of the path at least `minAheadM` ahead of `distM` along the step: how far it is and the
 * compass bearing from the user's spot to it. That bearing is what the user should face right now.
 */
export function nextNodeAhead(polyline: [number, number][], distM: number, minAheadM = 2): { distM: number; bearingDeg: number } | null {
  const here = pointAlong(polyline, distM);
  if (!here || polyline.length < 2) return null;
  let walked = 0;
  for (let i = 1; i < polyline.length; i++) {
    const [lon0, lat0] = polyline[i - 1];
    const [lon1, lat1] = polyline[i];
    walked += Math.hypot((lon1 - lon0) * M_PER_DEG_LON(lat0), (lat1 - lat0) * M_PER_DEG_LAT);
    const ahead = walked - distM;
    if (ahead >= minAheadM || i === polyline.length - 1) {
      const dx = (lon1 - here.lon) * M_PER_DEG_LON(here.lat);
      const dy = (lat1 - here.lat) * M_PER_DEG_LAT;
      if (Math.hypot(dx, dy) < 0.3) return null; // standing on the last node
      return { distM: Math.max(0, ahead), bearingDeg: bearingOf(dx, dy) };
    }
  }
  return null;
}

const isVertical = (s: RouteStep) => s.bearingDeg == null || (s.toLevelId != null && s.toLevelId !== s.levelId);

/** Nearest point of a polyline to (lat, lon): metres along it and metres off it. */
function projectOnPolyline(polyline: [number, number][], lat: number, lon: number): { alongM: number; offM: number } | null {
  if (!polyline.length) return null;
  const kx = M_PER_DEG_LON(lat);
  let walked = 0;
  let best: { alongM: number; offM: number } | null = null;
  for (let i = 1; i < polyline.length; i++) {
    const ax = (polyline[i - 1][0] - lon) * kx;
    const ay = (polyline[i - 1][1] - lat) * M_PER_DEG_LAT;
    const bx = (polyline[i][0] - lon) * kx;
    const by = (polyline[i][1] - lat) * M_PER_DEG_LAT;
    const sx = bx - ax;
    const sy = by - ay;
    const len2 = sx * sx + sy * sy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * sx + ay * sy) / len2)) : 0;
    const off = Math.hypot(ax + sx * t, ay + sy * t);
    const len = Math.sqrt(len2);
    if (!best || off < best.offM) best = { alongM: walked + len * t, offM: off };
    walked += len;
  }
  return best ?? { alongM: 0, offM: Math.hypot((polyline[0][0] - lon) * kx, (polyline[0][1] - lat) * M_PER_DEG_LAT) };
}

/**
 * Where on the route a known position lies: the walking step it is closest to (same floor, from one step
 * back onwards, since people do not skip back further), how far along it, and how far off the route.
 */
export function projectOntoRoute(
  steps: RouteStep[],
  at: { lat: number; lon: number; levelId: string },
  fromStep = 0,
): { stepIndex: number; alongM: number; offM: number } | null {
  let best: { stepIndex: number; alongM: number; offM: number } | null = null;
  for (let i = Math.max(0, fromStep - 1); i < steps.length; i++) {
    const s = steps[i];
    if (s.levelId !== at.levelId || isVertical(s) || s.maneuver === 'arrive') continue;
    const p = projectOnPolyline(s.polyline, at.lat, at.lon);
    if (!p) continue;
    // Ties (the shared node between two steps) go to the later step: the user is about to start it.
    if (!best || p.offM < best.offM - 0.5 || (p.offM <= best.offM + 0.5 && i > best.stepIndex && p.alongM < 1)) {
      best = { stepIndex: i, alongM: Math.min(p.alongM, s.distanceM), offM: p.offM };
    }
  }
  return best;
}
