import { describe, expect, it } from 'vitest';
import { Altimeter, FloorBelief, RideDetector, type LevelHeight, type Ride } from './altimeter';

// HG elevations from the graph (median node z per level).
const HG: LevelHeight[] = [
  { id: 'ETH.HG.D', elevationM: 450.41 }, { id: 'ETH.HG.E', elevationM: 453.41 }, { id: 'ETH.HG.EO', elevationM: 457.1 },
  { id: 'ETH.HG.F', elevationM: 460.78 }, { id: 'ETH.HG.FO', elevationM: 463.49 }, { id: 'ETH.HG.G', elevationM: 466.19 },
  { id: 'ETH.HG.H', elevationM: 471.59 },
];

/** An elevator ride as the accelerometer sees it: rest, push, glide at 1 m/s, opposite push, rest. */
function simulateRide(deltaM: number, opts: { bias?: number; noise?: number; accel?: number } = {}): Ride | null {
  const { bias = 0.03, noise = 0.03, accel = 0.6 } = opts;
  const g = 9.81 + bias;
  const sign = Math.sign(deltaM);
  const vMax = 1.0;
  const tAcc = vMax / accel;
  const cruise = Math.max(0, (Math.abs(deltaM) - vMax * tAcc) / vMax);
  const phases: [number, number][] = [[2, 0], [tAcc, sign * accel], [cruise, 0], [tAcc, -sign * accel], [4, 0]];
  const d = new RideDetector();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  let t = 0;
  let result: Ride | null = null;
  for (const [dur, a] of phases) {
    for (let s = 0; s < dur * 60; s++) {
      t += 1000 / 60;
      result = d.push(t, g + a + noise * rnd(), false) ?? result;
    }
  }
  return result;
}

describe('RideDetector', () => {
  it.each([
    ['F → G (one floor up, 5.4 m)', 5.41],
    ['E → F (7.4 m, past the mezzanine)', 7.37],
    ['G → E (two floors down, 12.8 m)', -12.78],
    ['F → FO (half floor, 2.7 m)', 2.71],
  ])('measures %s within a floor gap', (_name, deltaM) => {
    const ride = simulateRide(deltaM);
    expect(ride).not.toBeNull();
    expect(Math.sign(ride!.deltaM)).toBe(Math.sign(deltaM));
    expect(Math.abs(ride!.deltaM - deltaM)).toBeLessThan(1.1);
  });

  it('copes with a larger sensor bias (the drift is removed)', () => {
    const ride = simulateRide(5.41, { bias: 0.12 });
    expect(Math.abs(ride!.deltaM - 5.41)).toBeLessThan(1.3);
  });

  it('ignores a phone that was only moved (no braking push)', () => {
    const d = new RideDetector();
    let t = 0;
    let r: Ride | null = null;
    for (let s = 0; s < 120; s++) { t += 16.7; r = d.push(t, 9.81, false) ?? r; }
    for (let s = 0; s < 30; s++) { t += 16.7; r = d.push(t, 10.4, false) ?? r; } // lifted once
    for (let s = 0; s < 1200; s++) { t += 16.7; r = d.push(t, 9.81, false) ?? r; }
    expect(r).toBeNull();
  });

  it('measures nothing while the user is walking', () => {
    const d = new RideDetector();
    let t = 0;
    let r: Ride | null = null;
    for (let s = 0; s < 600; s++) { t += 16.7; r = d.push(t, 9.81 + 2 * Math.sin(s / 3), true) ?? r; }
    expect(r).toBeNull();
  });
});

describe('FloorBelief', () => {
  it('a ride of +5.4 m from F lands on G', () => {
    const b = new FloorBelief();
    b.setLevels(HG);
    b.known('ETH.HG.F', 'strong');
    b.shift(5.2, 1.4);
    expect(b.best()?.levelId).toBe('ETH.HG.G');
  });

  it('a ride of +2.7 m from F lands on the mezzanine FO, not G', () => {
    const b = new FloorBelief();
    b.setLevels(HG);
    b.known('ETH.HG.F', 'strong');
    b.shift(2.8, 1.0);
    expect(b.best()?.levelId).toBe('ETH.HG.FO');
  });

  it('stairs: 43 risers up from E reach F', () => {
    const a = new Altimeter();
    a.setLevels(HG);
    a.setKnown('ETH.HG.E');
    for (let i = 0; i < 43; i++) a.onStairStep(1);
    expect(a.current.levelId).toBe('ETH.HG.F');
  });
});

describe('Altimeter', () => {
  it('becomes confident on the new floor after an elevator ride', () => {
    const a = new Altimeter();
    a.setLevels(HG);
    a.setKnown('ETH.HG.F');
    a.onRide({ deltaM: 5.6, durationS: 9, peakAccel: 0.6 });
    expect(a.confidentLevel()).toBe('ETH.HG.G');
    expect(a.describe()).toMatch(/floor G .*elevator ride up 6 m/);
  });

  it('GPS altitude is only used once calibrated on a known floor', () => {
    const a = new Altimeter();
    a.setLevels(HG);
    a.onGpsAltitude(520, 5, 1000); // uncalibrated: ignored
    expect(a.current.basis).toBe('none');
    a.setKnown('ETH.HG.E', 'strong', 2000); // learns offset 520 - 453.41
    // ~7.4 m higher → F, consistently for a few seconds (one reading alone is not enough)
    for (let i = 0; i < 5; i++) a.onGpsAltitude(527.4 + (i % 2) * 0.3, 4, 3000 + i * 1000);
    expect(a.current.levelId).toBe('ETH.HG.F');
  });

  it('one accurate GPS reading alone does not override a known floor', () => {
    const a = new Altimeter();
    a.setLevels(HG);
    a.onGpsAltitude(520, 5, 1000);
    a.setKnown('ETH.HG.E', 'strong', 2000);
    a.onGpsAltitude(527.5, 4, 3000);
    expect(a.current.levelId).toBe('ETH.HG.E');
  });

  it('inaccurate GPS altitude does not move the floor', () => {
    const a = new Altimeter();
    a.setLevels(HG);
    a.onGpsAltitude(520, 5, 1000);
    a.setKnown('ETH.HG.E', 'strong', 2000);
    a.onGpsAltitude(540, 30, 3000);
    expect(a.current.levelId).toBe('ETH.HG.E');
  });

  it('tells listeners when the floor changes', () => {
    const a = new Altimeter();
    a.setLevels(HG);
    a.setKnown('ETH.HG.F');
    const seen: string[] = [];
    a.subscribe((s) => s.levelId && seen.push(s.levelId));
    a.onRide({ deltaM: -7.3, durationS: 11, peakAccel: 0.6 });
    expect(seen.at(-1)).toBe('ETH.HG.E');
  });
});
