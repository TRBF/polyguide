/**
 * Phone sensors for guidance (SPEC §5.2): compass heading, pedometer and a "moving" flag.
 * The filters are plain classes with no DOM access so they can be unit-tested; startSensors()
 * wires them to the browser events.
 */

import { RideDetector, type Ride } from './altimeter';

/* ───────────── Angle helpers ───────────── */

export const norm360 = (d: number) => ((d % 360) + 360) % 360;
const RAD = Math.PI / 180;

/** Circular mean in degrees [0, 360). null for no samples. */
export function circularMean(degs: number[]): number | null {
  if (!degs.length) return null;
  let s = 0;
  let c = 0;
  for (const d of degs) {
    s += Math.sin(d * RAD);
    c += Math.cos(d * RAD);
  }
  return norm360(Math.atan2(s, c) / RAD);
}

/** Absolute angular difference in [0, 180]. */
export const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Compass heading of the direction the rear camera points, from absolute deviceorientation
 * angles (W3C DeviceOrientation spec, "compass heading" example). Degenerates when the phone lies
 * flat, so fall back to (360 − alpha), which is where the top edge points.
 */
export function headingFromAngles(alpha: number, beta: number | null, gamma: number | null): number {
  const b = beta ?? 0;
  if (Math.abs(b) < 35 || Math.abs(b) > 145) return norm360(360 - alpha);
  const x = b * RAD;
  const y = (gamma ?? 0) * RAD;
  const z = alpha * RAD;
  const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
  const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
  return norm360(Math.atan2(vx, vy) / RAD);
}

/* ───────────── Heading filter ───────────── */

export const HEADING_SMOOTH_MS = 300;
const JITTER_WINDOW_MS = 1000;
export const JITTER_LIMIT_DEG = 25;
const STALE_MS = 1500;

/** Circular moving average over ~300 ms plus a jitter estimate for the "compass unreliable" state. */
export class HeadingFilter {
  private samples: { t: number; deg: number; resid: number }[] = [];
  private smoothed: number | null = null;
  private lastT = -Infinity;

  push(t: number, deg: number): number {
    this.samples.push({ t, deg: norm360(deg), resid: 0 });
    while (this.samples.length && this.samples[0].t < t - JITTER_WINDOW_MS) this.samples.shift();
    this.smoothed = circularMean(this.samples.filter((s) => s.t >= t - HEADING_SMOOTH_MS).map((s) => s.deg));
    this.samples[this.samples.length - 1].resid = angleDiff(deg, this.smoothed!);
    this.lastT = t;
    return this.smoothed!;
  }

  /** Mean deviation of raw samples from the smoothed heading over the last second. */
  jitter(): number {
    if (this.samples.length < 3) return 0;
    return this.samples.reduce((a, s) => a + s.resid, 0) / this.samples.length;
  }

  heading(now: number): number | null {
    return now - this.lastT > STALE_MS ? null : this.smoothed;
  }

  reliable(now: number): boolean {
    return this.heading(now) != null && this.jitter() < JITTER_LIMIT_DEG;
  }
}

/* ───────────── Pedometer ───────────── */

/**
 * Peak detector on |acceleration incl. gravity|: low-pass the magnitude, subtract a slow gravity
 * baseline, count local maxima above threshold with a 0.35 s refractory period.
 */
export class StepDetector {
  private lp: number | null = null;
  private base: number | null = null;
  private prev = 0;
  private prev2 = 0;
  private lastStepT = -Infinity;
  count = 0;

  constructor(
    private threshold = 1.0,
    private refractoryMs = 350,
  ) {}

  /** Returns true when a step is detected at this sample. */
  push(t: number, mag: number): boolean {
    this.lp = this.lp == null ? mag : this.lp + 0.35 * (mag - this.lp);
    this.base = this.base == null ? mag : this.base + 0.02 * (mag - this.base);
    const v = this.lp - this.base;
    const peak = this.prev > this.prev2 && this.prev >= v && this.prev > this.threshold && t - this.lastStepT >= this.refractoryMs;
    this.prev2 = this.prev;
    this.prev = v;
    if (!peak) return false;
    this.lastStepT = t;
    this.count++;
    return true;
  }
}

/* ───────────── Motion state ───────────── */

/**
 * "moving" = variance of the acceleration magnitude over the last second above a threshold.
 * Low enough to catch a wheelchair rolling; a 1.5 s hold stops it flickering between strides.
 */
export class MotionDetector {
  private samples: { t: number; m: number }[] = [];
  private lastActiveT = -Infinity;
  variance = 0;

  constructor(
    private threshold = 0.08,
    private holdMs = 1500,
  ) {}

  push(t: number, mag: number): boolean {
    this.samples.push({ t, m: mag });
    while (this.samples.length && this.samples[0].t < t - 1000) this.samples.shift();
    const n = this.samples.length;
    const mean = this.samples.reduce((a, s) => a + s.m, 0) / n;
    this.variance = this.samples.reduce((a, s) => a + (s.m - mean) ** 2, 0) / n;
    if (n >= 5 && this.variance > this.threshold) this.lastActiveT = t;
    return this.moving(t);
  }

  moving(now: number): boolean {
    return now - this.lastActiveT <= this.holdMs;
  }
}

/* ───────────── Permissions ───────────── */

type PermissionRequester = { requestPermission?: () => Promise<PermissionState> };

/**
 * iOS gates motion + orientation behind a user gesture. Call this directly inside a click handler.
 * Both prompts are started before awaiting so the gesture is still valid for the second one.
 */
export async function requestSensorPermissions(): Promise<string[]> {
  const granted: string[] = [];
  const ask = async (name: string, ctor: unknown, present: boolean) => {
    const req = (ctor as PermissionRequester | undefined)?.requestPermission;
    try {
      if (req) {
        if ((await req.call(ctor)) === 'granted') granted.push(name);
      } else if (present) {
        granted.push(name);
      }
    } catch {
      // Optional: guidance still works with manual "Next" and the step list.
    }
  };
  const hasWindow = typeof window !== 'undefined';
  await Promise.all([
    ask('orientation', hasWindow ? window.DeviceOrientationEvent : undefined, hasWindow && 'DeviceOrientationEvent' in window),
    ask('motion', hasWindow ? window.DeviceMotionEvent : undefined, hasWindow && 'DeviceMotionEvent' in window),
  ]);
  return granted;
}

/* ───────────── Browser wiring ───────────── */

export interface SensorSnapshot {
  headingDeg: number | null;
  headingReliable: boolean;
  headingJitterDeg: number;
  /** Which event stream produced the heading. */
  headingSource: 'ios' | 'absolute' | 'none';
  /** iOS only: webkitCompassAccuracy in degrees (negative = invalid). */
  compassAccuracyDeg: number | null;
  steps: number;
  moving: boolean;
  accelMag: number | null;
  accelVariance: number;
}

export interface SensorListener {
  onStep?: (count: number) => void;
  /** An elevator ride just ended (height measured from the accelerometer). Only measured when asked for. */
  onRide?: (ride: Ride) => void;
  /** Throttled to ~10 Hz. */
  onChange?: (s: SensorSnapshot) => void;
}

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };

const screenAngle = () => {
  const so = typeof screen !== 'undefined' ? screen.orientation?.angle : undefined;
  return typeof so === 'number' ? so : Number((window as unknown as { orientation?: number }).orientation ?? 0) || 0;
};

/** Subscribe to heading, steps and motion. Returns an unsubscribe function. */
export function startSensors(listener: SensorListener): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const heading = new HeadingFilter();
  const steps = new StepDetector();
  const motion = new MotionDetector();
  const rides = listener.onRide ? new RideDetector() : null;
  let lastStepAt = -Infinity;
  const snap: SensorSnapshot = {
    headingDeg: null,
    headingReliable: false,
    headingJitterDeg: 0,
    headingSource: 'none',
    compassAccuracyDeg: null,
    steps: 0,
    moving: false,
    accelMag: null,
    accelVariance: 0,
  };
  let lastEmit = 0;
  let gotAbsolute = false;

  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    snap.headingDeg = heading.heading(now);
    snap.headingJitterDeg = heading.jitter();
    const accOk = snap.compassAccuracyDeg == null || (snap.compassAccuracyDeg >= 0 && snap.compassAccuracyDeg <= JITTER_LIMIT_DEG);
    snap.headingReliable = heading.reliable(now) && accOk;
    snap.moving = motion.moving(now);
    listener.onChange?.({ ...snap });
  };

  const onOrientation = (e: Event, absoluteStream: boolean) => {
    const ev = e as IOSOrientationEvent;
    const now = performance.now();
    if (typeof ev.webkitCompassHeading === 'number' && ev.webkitCompassHeading >= 0) {
      snap.headingSource = 'ios';
      snap.compassAccuracyDeg = typeof ev.webkitCompassAccuracy === 'number' ? ev.webkitCompassAccuracy : null;
      heading.push(now, norm360(ev.webkitCompassHeading + screenAngle()));
    } else if (ev.alpha != null && (absoluteStream || ev.absolute)) {
      if (absoluteStream) gotAbsolute = true;
      else if (gotAbsolute) return; // prefer the dedicated absolute stream when both fire
      snap.headingSource = 'absolute';
      heading.push(now, norm360(headingFromAngles(ev.alpha, ev.beta, ev.gamma) + screenAngle()));
    } else {
      return;
    }
    emit();
  };

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const now = performance.now();
    const mag = Math.hypot(a.x, a.y, a.z);
    snap.accelMag = mag;
    motion.push(now, mag);
    snap.accelVariance = motion.variance;
    const stepped = steps.push(now, mag);
    if (stepped) lastStepAt = now;
    if (rides) {
      // Walking shakes the phone far more than an elevator accelerates it: rides are measured standing still.
      const ride = rides.push(now, mag, now - lastStepAt < 1500);
      if (ride) listener.onRide?.(ride);
    }
    if (stepped) {
      snap.steps = steps.count;
      listener.onStep?.(steps.count);
      emit(true);
    } else {
      emit();
    }
  };

  const onAbs = (e: Event) => onOrientation(e, true);
  const onRel = (e: Event) => onOrientation(e, false);
  window.addEventListener('deviceorientationabsolute', onAbs);
  window.addEventListener('deviceorientation', onRel);
  window.addEventListener('devicemotion', onMotion);
  // Keep "stale" / "moving" fresh even when no events arrive (sensors denied or phone still).
  const timer = window.setInterval(() => emit(true), 500);

  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbs);
    window.removeEventListener('deviceorientation', onRel);
    window.removeEventListener('devicemotion', onMotion);
    window.clearInterval(timer);
  };
}
