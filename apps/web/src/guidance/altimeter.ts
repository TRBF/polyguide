/**
 * Altitude → floor. Phone browsers do not expose the barometer, so height changes are measured from what they
 * do give:
 *  - Elevator rides, from the accelerometer: a ride is a push (heavier), a glide, and the opposite push. The
 *    magnitude of acceleration-including-gravity is orientation-free, so its excess over the resting baseline is
 *    the vertical acceleration; integrated twice over a short ride (with the drift that makes the end velocity
 *    non-zero removed) it gives the metres risen or fallen. HG floors are 2.7–7.4 m apart, rides ~1 m/s.
 *  - Stairs: on a stairs step of the route each step climbs about one riser (~0.17 m).
 *  - GPS altitude, when the phone reports it accurately: calibrated against the last floor known for sure, so
 *    only its changes count. A weak witness indoors.
 * All of it updates one belief over HG's floors (by their real elevation), which the rest of the app uses as the
 * authority on the floor: sign reading, the two-witness gate, elevator steps and the voice agent.
 */

/* ───────────── Elevator rides from the accelerometer ───────────── */

export interface Ride {
  /** Metres, positive = up. */
  deltaM: number;
  durationS: number;
  peakAccel: number;
}

/** Vertical acceleration (m/s²) that starts a ride: elevators accelerate at ~0.5–1 m/s². */
const RIDE_START = 0.15;
const RIDE_OPPOSITE = 0.12;
const RIDE_QUIET = 0.06;
/** Quiet this long after the braking push ends the ride. */
const RIDE_SETTLE_MS = 1200;
const RIDE_MAX_MS = 60_000;
/** A "ride" with no braking push by now was the phone being moved, not an elevator. */
const RIDE_NO_BRAKE_MS = 15_000;
const MIN_RIDE_M = 1.2;

export class RideDetector {
  private base: number | null = null;
  private av = 0;
  private lastT: number | null = null;
  private ride: { start: number; v: number; z: number; sign: number; sawOpposite: boolean; quietSince: number | null; peak: number } | null = null;

  /** Current vertical acceleration estimate (for debugging displays). */
  get verticalAccel(): number {
    return this.av;
  }

  get riding(): boolean {
    return this.ride != null;
  }

  /**
   * One accelerometer sample: |acceleration incl. gravity| in m/s², and whether the user is stepping (walking
   * shakes the phone far more than an elevator accelerates it, so rides are only measured while standing).
   */
  push(t: number, mag: number, stepping: boolean): Ride | null {
    const dt = this.lastT == null ? 0 : Math.min(0.1, Math.max(0, (t - this.lastT) / 1000));
    this.lastT = t;
    if (this.base == null) {
      this.base = mag;
      return null;
    }
    this.av += (1 - Math.exp(-dt / 0.25)) * (mag - this.base - this.av);

    if (stepping) {
      // Walking out of the elevator: a ride that already braked is complete; anything else is noise.
      const done = this.ride?.sawOpposite ? this.finish(t) : null;
      this.ride = null;
      return done;
    }
    if (!this.ride) {
      // Resting: follow slow changes of the baseline (temperature, the phone settling in a pocket).
      if (Math.abs(mag - this.base) < 0.3) this.base += (1 - Math.exp(-dt / 8)) * (mag - this.base);
      if (Math.abs(this.av) > RIDE_START) {
        this.ride = { start: t, v: 0, z: 0, sign: Math.sign(this.av), sawOpposite: false, quietSince: null, peak: Math.abs(this.av) };
      }
      return null;
    }
    const r = this.ride;
    r.v += this.av * dt;
    r.z += r.v * dt;
    r.peak = Math.max(r.peak, Math.abs(this.av));
    if (Math.sign(this.av) === -r.sign && Math.abs(this.av) > RIDE_OPPOSITE) r.sawOpposite = true;
    r.quietSince = Math.abs(this.av) < RIDE_QUIET ? r.quietSince ?? t : null;
    const age = t - r.start;
    if (r.sawOpposite && r.quietSince != null && t - r.quietSince > RIDE_SETTLE_MS) return this.endRide(t);
    if (age > RIDE_MAX_MS || (!r.sawOpposite && age > RIDE_NO_BRAKE_MS)) {
      this.ride = null;
      return null;
    }
    return null;
  }

  private endRide(t: number): Ride | null {
    const done = this.finish(t);
    this.ride = null;
    return done;
  }

  private finish(t: number): Ride | null {
    const r = this.ride!;
    const T = (t - r.start) / 1000;
    // A constant bias in the acceleration makes velocity grow linearly; the ride must end at rest, so the end
    // velocity is that drift, and it inflated the distance by v·T/2.
    const deltaM = r.z - (r.v * T) / 2;
    if (T < 2.5 || Math.abs(deltaM) < MIN_RIDE_M || Math.abs(deltaM) > 40) return null;
    return { deltaM: +deltaM.toFixed(2), durationS: +T.toFixed(1), peakAccel: +r.peak.toFixed(2) };
  }
}

/* ───────────── Belief over floors ───────────── */

export interface LevelHeight {
  id: string;
  elevationM: number;
}

const gauss = (x: number, sigma: number) => Math.exp(-0.5 * (x / sigma) ** 2);

/**
 * Belief over floors, kept as a snapshot plus the height risen since it (with its uncertainty). Small changes
 * (0.17 m per stair) add up continuously and are applied to the whole floors only when read: a belief that only
 * knew whole floors could never be moved by a single riser.
 */
export class FloorBelief {
  private levels: LevelHeight[] = [];
  private p: number[] = [];
  private offsetM = 0;
  private varM2 = 0;

  setLevels(levels: LevelHeight[]): void {
    const known = this.best();
    this.levels = [...levels].sort((a, b) => a.elevationM - b.elevationM);
    this.p = this.levels.map(() => 1 / Math.max(1, this.levels.length));
    this.offsetM = 0;
    this.varM2 = 0;
    if (known) this.known(known.levelId, 'weak');
  }

  get ready(): boolean {
    return this.levels.length > 0;
  }

  /** The floor is known (a sign, the user's word, a route start): most of the belief goes there. */
  known(levelId: string, strength: 'strong' | 'weak'): void {
    const i = this.levels.findIndex((l) => l.id === levelId);
    if (i < 0) return;
    const keep = strength === 'strong' ? 0.92 : 0.7;
    const rest = (1 - keep) / Math.max(1, this.levels.length - 1);
    this.p = this.levels.map((_, k) => (k === i ? keep : rest));
    this.offsetM = 0;
    this.varM2 = 0;
  }

  /** The user rose or fell `deltaM` (±sigma). */
  shift(deltaM: number, sigmaM: number): void {
    this.offsetM += deltaM;
    this.varM2 += sigmaM * sigmaM;
  }

  /** An absolute height estimate (already calibrated to HG's elevations). */
  observe(elevationM: number, sigmaM: number): void {
    if (!this.levels.length) return;
    const now = this.distribution();
    this.p = normalise(this.levels.map((l, k) => now[k] * (0.05 + gauss(l.elevationM - elevationM, sigmaM))));
    this.offsetM = 0;
    this.varM2 = 0;
  }

  best(): { levelId: string; probability: number; elevationM: number } | null {
    if (!this.levels.length) return null;
    const d = this.distribution();
    let i = 0;
    for (let k = 1; k < d.length; k++) if (d[k] > d[i]) i = k;
    return { levelId: this.levels[i].id, probability: +d[i].toFixed(3), elevationM: this.levels[i].elevationM };
  }

  elevationOf(levelId: string): number | null {
    return this.levels.find((l) => l.id === levelId)?.elevationM ?? null;
  }

  /** The snapshot moved by the height risen since: each floor's belief flows to the floor that far above/below. */
  private distribution(): number[] {
    if (this.offsetM === 0 && this.varM2 === 0) return this.p;
    // 0.3 m: floors are not perfectly flat, and people stand on landings.
    const sigma = Math.sqrt(this.varM2 + 0.09);
    return normalise(this.levels.map((target) =>
      this.levels.reduce((sum, from, k) => sum + this.p[k] * gauss(target.elevationM - from.elevationM - this.offsetM, sigma), 0),
    ));
  }
}

function normalise(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  return total > 0 && Number.isFinite(total) ? values.map((v) => v / total) : values;
}

/* ───────────── The app's altimeter ───────────── */

/** One stair riser. */
export const RISER_M = 0.17;
/** The floor is "known from altitude" above this belief. */
export const ALTIMETER_CONFIDENT = 0.7;
const GPS_MAX_ACCURACY_M = 12;
const GPS_FRESH_MS = 30_000;

export interface AltimeterState {
  levelId: string | null;
  probability: number;
  lastRide: (Ride & { at: number }) | null;
  /** How the floor is known, for the voice agent and the debug screen. */
  basis: 'none' | 'known' | 'elevator' | 'stairs' | 'gps';
}

export class Altimeter {
  readonly belief = new FloorBelief();
  private state: AltimeterState = { levelId: null, probability: 0, lastRide: null, basis: 'none' };
  private gps: { altitudeM: number; accuracyM: number; at: number } | null = null;
  /** GPS altitude minus HG elevation, learned whenever the floor is known for sure. */
  private gpsOffset: number | null = null;
  private listeners = new Set<(s: AltimeterState) => void>();

  setLevels(levels: LevelHeight[]): void {
    this.belief.setLevels(levels);
    this.update(this.state.basis);
  }

  /** The floor is known. With a fresh, accurate GPS altitude, this also calibrates GPS heights to HG's. */
  setKnown(levelId: string, strength: 'strong' | 'weak' = 'strong', now = Date.now()): void {
    this.belief.known(levelId, strength);
    const z = this.belief.elevationOf(levelId);
    if (strength === 'strong' && z != null && this.gps && now - this.gps.at < GPS_FRESH_MS && this.gps.accuracyM <= GPS_MAX_ACCURACY_M) {
      const offset = this.gps.altitudeM - z;
      this.gpsOffset = this.gpsOffset == null ? offset : 0.7 * this.gpsOffset + 0.3 * offset;
    }
    this.update('known');
  }

  onRide(ride: Ride, now = Date.now()): void {
    // Longer rides drift more: ~0.5 m plus 10 % of the distance (simulated rides measured within ~1 m).
    this.belief.shift(ride.deltaM, 0.5 + 0.1 * Math.abs(ride.deltaM));
    this.state.lastRide = { ...ride, at: now };
    this.update('elevator');
  }

  /** One step on a stairs step of the route: +1 up, −1 down. */
  onStairStep(direction: 1 | -1): void {
    this.belief.shift(direction * RISER_M, 0.05);
    this.update('stairs');
  }

  onGpsAltitude(altitudeM: number, accuracyM: number, now = Date.now()): void {
    this.gps = { altitudeM, accuracyM, at: now };
    if (this.gpsOffset == null || accuracyM > GPS_MAX_ACCURACY_M) return;
    this.belief.observe(altitudeM - this.gpsOffset, Math.max(3, accuracyM));
    this.update('gps');
  }

  get current(): AltimeterState {
    return this.state;
  }

  /** The floor if altitude is sure enough to act on, else null. */
  confidentLevel(): string | null {
    return this.state.levelId && this.state.probability >= ALTIMETER_CONFIDENT ? this.state.levelId : null;
  }

  subscribe(fn: (s: AltimeterState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** One line for the voice agent. */
  describe(now = Date.now()): string {
    const s = this.state;
    if (!s.levelId) return 'Floor sensor: not calibrated yet.';
    const floor = s.levelId.split('.').at(-1);
    const sure = s.probability >= 0.85 ? 'sure' : s.probability >= ALTIMETER_CONFIDENT ? 'fairly sure' : 'unsure';
    const ride = s.lastRide && now - s.lastRide.at < 120_000
      ? `; last elevator ride ${s.lastRide.deltaM > 0 ? 'up' : 'down'} ${Math.abs(Math.round(s.lastRide.deltaM))} m, ${Math.round((now - s.lastRide.at) / 1000)} s ago`
      : '';
    return `Floor sensor: floor ${floor} (${sure}, ${Math.round(s.probability * 100)} %, from ${s.basis})${ride}.`;
  }

  private update(basis: AltimeterState['basis']): void {
    const best = this.belief.best();
    this.state = { ...this.state, levelId: best?.levelId ?? null, probability: best?.probability ?? 0, basis: best ? basis : 'none' };
    for (const fn of this.listeners) fn(this.state);
  }
}

/** One altimeter for the whole session: sensors feed it, guidance and the voice agent read it. */
export const altimeter = new Altimeter();
