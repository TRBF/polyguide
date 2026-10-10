/**
 * Heading cue (SPEC §5.4): rate-limited spoken phrases, a stereo audio beacon and Android haptics.
 * delta = normalize180(step bearing − phone heading); positive means the route is to the right.
 */

export const normalize180 = (d: number) => {
  const r = ((((d + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
};
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function headingDelta(bearingDeg: number | null | undefined, headingDeg: number | null | undefined): number | null {
  if (bearingDeg == null || headingDeg == null) return null;
  return normalize180(bearingDeg - headingDeg);
}

/* ───────────── Spoken heading phrases ───────────── */

const OFF_DEG = 45;
const OFF_HOLD_MS = 1500;
const ALIGNED_DEG = 20;
const MIN_GAP_MS = 4000;
const REMIND_MS = 8000;

export function turnPhrase(delta: number): string {
  if (Math.abs(delta) > 135) return 'Turn around';
  return delta > 0 ? 'Turn right' : 'Turn left';
}

/**
 * "Turn left/right" after |delta| > 45° for 1.5 s, "Straight ahead" once on re-alignment,
 * never more than one phrase per 4 s; reminds every 8 s while still off course.
 */
export class HeadingSpeech {
  private offSince: number | null = null;
  private lastSpokenAt = -Infinity;
  private lastPhrase = '';
  private warned = false;

  reset() {
    this.offSince = null;
    this.warned = false;
    this.lastPhrase = '';
  }

  update(delta: number | null, now: number): string | null {
    if (delta == null) {
      this.offSince = null;
      return null;
    }
    const sinceLast = now - this.lastSpokenAt;
    if (Math.abs(delta) > OFF_DEG) {
      this.offSince ??= now;
      if (now - this.offSince < OFF_HOLD_MS || sinceLast < MIN_GAP_MS) return null;
      const phrase = turnPhrase(delta);
      if (phrase === this.lastPhrase && sinceLast < REMIND_MS) return null;
      return this.say(phrase, now, true);
    }
    this.offSince = null;
    if (this.warned && Math.abs(delta) < ALIGNED_DEG && sinceLast >= MIN_GAP_MS) return this.say('Straight ahead', now, false);
    return null;
  }

  private say(phrase: string, now: number, warned: boolean) {
    this.lastSpokenAt = now;
    this.lastPhrase = phrase;
    this.warned = warned;
    return phrase;
  }
}

/* ───────────── Audio beacon ───────────── */

export const BEACON_INTERVAL_MS = 600;
export const ON_COURSE_DEG = 15;

/** Pan follows the route direction, pitch rises as you line up, double tick when on course. */
export function beaconParams(delta: number) {
  const a = Math.min(180, Math.abs(delta));
  return {
    pan: clamp(delta / 90, -1, 1),
    freq: Math.round(320 + 560 * (1 - a / 180) ** 2),
    double: a < ON_COURSE_DEG,
  };
}

const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) && 'vibrate' in navigator;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * WebAudio: oscillator → gain → StereoPannerNode, one tick every 600 ms. iOS only lets an
 * AudioContext start inside a user gesture, so the first tap/key anywhere resumes it.
 */
export class AudioBeacon {
  private ctx: AudioContext | null = null;
  private panner: StereoPannerNode | null = null;
  private timer: number | null = null;
  private enabled = true;
  private delta: number | null = null;
  private ticks = 0;
  private lastOnCourse: boolean | null = null;
  private unlockBound = () => void this.ctx?.resume().catch(() => undefined);

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on && isAndroid()) navigator.vibrate(0);
  }

  get isEnabled() {
    return this.enabled;
  }

  /** null = silent (no heading, or a vertical step). */
  setDelta(delta: number | null) {
    this.delta = delta;
  }

  start() {
    if (this.timer != null || typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (Ctor) {
        this.ctx = new Ctor();
        if (typeof this.ctx.createStereoPanner === 'function') {
          this.panner = this.ctx.createStereoPanner();
          this.panner.connect(this.ctx.destination);
        }
      }
    }
    void this.ctx?.resume().catch(() => undefined);
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, this.unlockBound, { passive: true });
    this.timer = window.setInterval(() => this.tick(), BEACON_INTERVAL_MS);
  }

  stop() {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    this.lastOnCourse = null;
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.removeEventListener(ev, this.unlockBound);
    void this.ctx?.suspend().catch(() => undefined);
  }

  dispose() {
    this.stop();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.panner = null;
  }

  /** One test blip, e.g. from the debug page. Call from a click so iOS allows audio. */
  test(delta = 0) {
    void this.ctx?.resume();
    const p = beaconParams(delta);
    this.blip(0, p.freq, p.pan);
    if (p.double) this.blip(0.12, p.freq, p.pan);
  }

  private tick() {
    if (!this.enabled || this.delta == null) return;
    const p = beaconParams(this.delta);
    this.ticks++;
    if (this.ctx?.state === 'running') {
      this.blip(0, p.freq, p.pan);
      if (p.double) this.blip(0.12, p.freq, p.pan);
    }
    this.haptic(p.double);
  }

  /** Android only (iOS has no web vibration): short buzz when you line up, long buzz every ~3 s while off. */
  private haptic(onCourse: boolean) {
    if (!isAndroid()) return;
    if (onCourse && this.lastOnCourse !== true) navigator.vibrate(40);
    else if (!onCourse && (this.lastOnCourse !== false || this.ticks % 5 === 0) && Math.abs(this.delta ?? 0) > 45) navigator.vibrate(220);
    this.lastOnCourse = onCourse;
  }

  private blip(offsetS: number, freq: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + offsetS;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.35, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
    osc.connect(gain);
    if (this.panner) {
      this.panner.pan.setValueAtTime(pan, t0);
      gain.connect(this.panner);
    } else {
      gain.connect(ctx.destination);
    }
    osc.start(t0);
    osc.stop(t0 + 0.07);
  }
}
