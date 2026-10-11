/**
 * The "[Live state]" message the realtime agent gets before every turn: everything the app knows about where
 * the user is and which way they face, in plain words. Pure functions so they can be unit-tested.
 */
import { useTypeLabel, type Place, type PositionInfo, type RouteStep } from '@polyguide/shared';
import { bearingAt, norm360, pointAlong } from '../guidance/geometry';

/* ───────────── Geometry ───────────── */

export { bearingAt, norm360, pointAlong };

/** Signed turn from heading to bearing in (-180, 180]; positive = to the right. */
export const turnTo = (bearing: number, heading: number) => {
  const d = norm360(bearing - heading + 180) - 180;
  return d === -180 ? 180 : d;
};

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassName = (deg: number) => COMPASS[Math.round(norm360(deg) / 45) % 8];

/** "ahead", "slightly right (20°)", "right (85°)", "behind-left (140°)", "behind". */
export function relDirection(bearing: number, heading: number): string {
  const d = turnTo(bearing, heading);
  const a = Math.abs(Math.round(d));
  const side = d > 0 ? 'right' : 'left';
  if (a <= 12) return 'ahead';
  if (a <= 35) return `slightly ${side} (${a}°)`;
  if (a <= 120) return `${side} (${a}°)`;
  if (a <= 165) return `behind-${side} (${a}°)`;
  return 'behind';
}

/** What the user must do to face a direction `turn` degrees away (positive = right), in words first. */
export function turnPhrase(turn: number): string {
  const a = Math.abs(Math.round(turn));
  const side = turn > 0 ? 'right' : 'left';
  if (a <= 15) return 'already facing it, go straight ahead';
  if (a <= 35) return `turn slightly ${side} (${a}° to the ${side})`;
  if (a <= 120) return `turn ${side} (${a}° to the ${side})`;
  if (a <= 160) return `turn around over your ${side} shoulder (${a}° to the ${side})`;
  return `turn around (${a}°)`;
}

/* ───────────── Position estimate ───────────── */

export interface Fix {
  place: Place;
  /**
   * How we know: a sign the camera read, the user said so, the end of a finished route, a room recognised from ETH
   * photos, or remembered from an earlier session on this phone (the user may have moved since).
   */
  source: 'sign' | 'user' | 'route' | 'photo' | 'remembered';
  at: number;
  /** Rough distance from the place when the fix was taken. */
  distanceM?: number;
}

export interface Estimate {
  /** What /api/position is asked about. */
  request: { placeId?: string; lat?: number; lon?: number; levelId?: string };
  /** One line for the model. */
  text: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

/** A sign or the user's word beats dead reckoning for this long. */
export const FIX_FRESH_MS = 30_000;

export function estimatePosition(args: {
  now: number;
  fix: Fix | null;
  navigating: boolean;
  step: RouteStep | null;
  stepIndex: number;
  progressM: number;
}): Estimate {
  const { now, fix, navigating, step, progressM } = args;
  const age = fix ? Math.round((now - fix.at) / 1000) : 0;
  const ago = age < 120 ? `${age} s ago` : `${Math.round(age / 60)} min ago`;
  const how = (f: Fix) =>
    f.source === 'sign' ? `room sign read ${ago}`
    : f.source === 'user' ? `the user said so ${ago}`
    : f.source === 'photo' ? `room recognised from ETH photos ${ago}`
    : f.source === 'remembered' ? `remembered from an earlier session ${ago}; the user has probably moved, confirm before relying on it`
    : `end of the last route, ${ago}`;
  // A door sign puts the user in the corridor outside that room, not inside it; the room type lets the agent
  // notice when what the camera or the user describes does not fit.
  const kind = (f: Fix) => (f.place.kind === 'room' ? [f.place.label, useTypeLabel(f.place.useType)].filter(Boolean).join(', ') : '');
  const at = (f: Fix) => {
    const what = `${f.place.name}${kind(f) ? ` (${kind(f)})` : ''}`;
    if (f.distanceM && f.distanceM > 2) return `about ${Math.round(f.distanceM)} m from ${what}`;
    return f.source === 'sign' && f.place.kind === 'room' ? `in the corridor outside the door of ${what}` : `at ${what}`;
  };

  if (navigating && step && !(fix && now - fix.at < FIX_FRESH_MS)) {
    const vertical = step.bearingDeg == null || (step.toLevelId != null && step.toLevelId !== step.levelId);
    const p = vertical ? pointAlong(step.polyline, 0) : pointAlong(step.polyline, progressM);
    if (p) {
      const drift = Math.round(2 + 0.1 * progressM);
      const text = vertical
        ? `at the ${step.maneuver.replace(/_/g, ' ')} of step ${args.stepIndex + 1} (dead reckoning; changes floor, so confirm when they are off it)`
        : `about ${Math.round(progressM)} m into step ${args.stepIndex + 1} (dead reckoning from the step counter, ±${drift} m)`;
      const last = fix ? `; last fix: ${at(fix)}, ${how(fix)}` : '';
      return { request: { lat: p.lat, lon: p.lon, levelId: step.levelId }, text: `${text}${last}`, confidence: progressM < 25 ? 'medium' : 'low' };
    }
  }
  if (fix) {
    const confidence = fix.source === 'remembered' ? 'low' : fix.source === 'route' || age < 120 ? 'high' : age < 600 ? 'medium' : 'low';
    return { request: { placeId: fix.place.id }, text: `${at(fix)}, floor ${floorOf(fix.place.levelId)} (${how(fix)})`, confidence };
  }
  return { request: {}, text: 'UNKNOWN: no sign read and the user has not said where they are', confidence: 'none' };
}

const floorOf = (levelId: string) => levelId.split('.').at(-1) ?? levelId;

/* ───────────── The message ───────────── */

export interface LiveStateInput {
  now: number;
  screen: string;
  trip: { from?: string; to?: string; confirming: boolean; options?: string[] };
  navigation?: {
    stepIndex: number;
    stepCount: number;
    instruction: string;
    nextInstruction?: string;
    remainingStepM: number;
    remainingTotalM: number;
    /** Compass bearing from the user to the next node of the path; null on stairs / elevators. */
    bearingDeg: number | null;
    /** Metres to that node. */
    nextNodeM?: number | null;
    vertical: boolean;
  };
  estimate: Estimate;
  info: PositionInfo | null;
  heading: { deg: number | null; reliable: boolean };
  moving: boolean;
  gps: { lat: number; lon: number; accuracyM: number; ageS: number } | null;
  needs: string[];
  lastSeen?: { summary: string; ageS: number };
  /** The altimeter's line ("Floor sensor: floor G (sure, 91 %, from elevator)…"); a strong hint on the floor. */
  floorSensor?: string;
  /** Set while the how-it-works guide is open. */
  guide?: string;
}

export function formatLiveState(s: LiveStateInput): string {
  const h = s.heading.deg;
  const lines: string[] = ['[Live state] (sent by the app, not said by the user)'];

  const trip = s.trip.to ? `trip ${s.trip.from ? `from ${s.trip.from} ` : ''}to ${s.trip.to}${s.trip.confirming ? ', waiting for the user to confirm' : ''}` : 'no destination yet';
  lines.push(`Screen: ${s.screen}; ${trip}.${s.trip.options?.length ? ` Options read out: ${s.trip.options.map((o, i) => `${i + 1}. ${o}`).join('; ')}.` : ''}`);
  if (s.needs.length) lines.push(`Needs: ${s.needs.join(', ')}.`);

  const n = s.navigation;
  if (n) {
    lines.push(`Navigating: step ${n.stepIndex + 1} of ${n.stepCount}: "${n.instruction}". ${n.vertical ? '' : `${Math.round(n.remainingStepM)} m left on this step, `}${Math.round(n.remainingTotalM)} m to the destination.${n.nextInstruction ? ` Then: "${n.nextInstruction}".` : ''}`);
  }

  lines.push(`Position: ${s.estimate.text}. Confidence: ${s.estimate.confidence}.`);
  if (s.info?.ok && !s.info.fromGps) lines.push(`Floor ${s.info.floor}.`);
  if (s.guide) lines.push(s.guide);
  // The floor sensor is a measurement, but it can miss a ride: a sign read clearly or the user's word beats it.
  if (s.floorSensor) lines.push(`${s.floorSensor} A hint, not the last word: if you read a sign clearly or the user says their floor, believe that and call set_position.`);

  if (h == null) lines.push('Heading: unknown (no compass). Use landmarks and the camera, not degrees.');
  else {
    lines.push(`Phone points ${Math.round(h)}° (${compassName(h)})${s.heading.reliable ? '' : ', compass unreliable right now'}. User is ${s.moving ? 'moving' : 'standing still'}.`);
    if (n && n.bearingDeg != null) {
      const node = n.nextNodeM != null ? `Next node of the path: ${Math.round(n.nextNodeM)} m away; to face it` : 'To face the route';
      lines.push(`${node}: ${turnPhrase(turnTo(n.bearingDeg, h))}.`);
    }
  }

  if (s.info?.ok && s.info.fromGps) {
    lines.push(`GPS-only candidates (any floor, GPS ±${s.info.snapM} m; ask or look to pick one): ${s.info.nearby.map((p) => `${p.label && p.kind !== 'room' ? `${p.label} (${p.name})` : p.name} ~${p.distM} m ${compassName(p.bearingDeg)}`).join('; ')}.`);
  } else if (s.info?.ok) {
    const rel = (b: number) => (h == null ? `${compassName(b)}` : relDirection(b, h));
    if (s.info.nearby.length) {
      lines.push(`Nearby (nearest first; direction relative to where the phone points): ${s.info.nearby.map((p) => `${p.label && p.kind !== 'room' ? p.label : p.name}${p.label && p.kind === 'room' ? ` (${p.label})` : ''} ${Math.round(p.distM)} m ${rel(p.bearingDeg)}`).join('; ')}.`);
    }
    if (s.info.paths.length) {
      lines.push(`Walkable from here: ${s.info.paths.map((p) => `${p.kind === 'hallway' ? 'corridor' : p.kind} ${rel(p.bearingDeg)}`).join('; ')}.`);
    }
    if (s.info.gpsEntrance) lines.push(`GPS puts the user ${s.info.gpsEntrance.distM} m from ${s.info.gpsEntrance.name} (outdoors).`);
  }
  if (s.gps) lines.push(`GPS: ±${Math.round(s.gps.accuracyM)} m, ${s.gps.ageS} s old${s.gps.accuracyM > 25 ? ' (too coarse indoors; ignore for rooms)' : ''}.`);
  else lines.push('GPS: none.');
  if (s.lastSeen && s.lastSeen.ageS < 60) lines.push(`Camera ${s.lastSeen.ageS} s ago: ${s.lastSeen.summary}`);
  return lines.join('\n');
}
