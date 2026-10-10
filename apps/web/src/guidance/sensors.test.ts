import { describe, expect, it } from 'vitest';
import { HeadingFilter, MotionDetector, StepDetector, circularMean, headingFromAngles } from './sensors';

describe('circularMean', () => {
  it('averages across north', () => {
    expect(circularMean([350, 10])).toBeCloseTo(0, 5);
    expect(circularMean([80, 100])).toBeCloseTo(90, 5);
    expect(circularMean([])).toBeNull();
  });
});

describe('headingFromAngles', () => {
  it('flat phone uses 360 − alpha', () => {
    expect(headingFromAngles(0, 0, 0)).toBe(0);
    expect(headingFromAngles(90, 5, 0)).toBe(270);
  });
  it('upright phone gives the rear-camera direction', () => {
    expect(headingFromAngles(0, 90, 0)).toBeCloseTo(0, 5);
    expect(headingFromAngles(90, 90, 0)).toBeCloseTo(270, 5);
    expect(headingFromAngles(270, 80, 0)).toBeCloseTo(90, 5);
  });
});

describe('HeadingFilter', () => {
  it('is reliable for a steady signal and unreliable for a wild one', () => {
    const steady = new HeadingFilter();
    for (let t = 0; t < 1000; t += 20) steady.push(t, 358 + (t % 40 === 0 ? 3 : 0));
    expect(steady.reliable(1000)).toBe(true);
    expect(steady.heading(1000)!).toBeGreaterThan(355);

    const wild = new HeadingFilter();
    for (let t = 0; t < 1000; t += 20) wild.push(t, (t / 20) % 2 ? 20 : 300);
    expect(wild.reliable(1000)).toBe(false);
  });
  it('goes stale without samples', () => {
    const f = new HeadingFilter();
    f.push(0, 90);
    expect(f.heading(100)).toBe(90);
    expect(f.heading(5000)).toBeNull();
  });
});

/** Synthetic walk: gravity + 2 Hz sinusoid (≈ 2 steps/s), 60 Hz sampling. */
function walkSignal(seconds: number, amp = 2.5, hz = 2) {
  const out: [number, number][] = [];
  for (let t = 0; t < seconds * 1000; t += 1000 / 60) out.push([t, 9.81 + amp * Math.sin(2 * Math.PI * hz * (t / 1000))]);
  return out;
}

describe('StepDetector', () => {
  it('counts ~2 steps per second while walking', () => {
    const d = new StepDetector();
    for (const [t, m] of walkSignal(10)) d.push(t, m);
    expect(d.count).toBeGreaterThanOrEqual(17);
    expect(d.count).toBeLessThanOrEqual(21);
  });
  it('ignores a phone at rest with noise', () => {
    const d = new StepDetector();
    for (let t = 0; t < 10000; t += 16) d.push(t, 9.81 + (Math.sin(t * 13.37) * 0.15));
    expect(d.count).toBe(0);
  });
  it('enforces the 0.35 s refractory period', () => {
    const d = new StepDetector();
    for (const [t, m] of walkSignal(10, 3, 5)) d.push(t, m); // 5 Hz is faster than the refractory allows
    expect(d.count).toBeLessThanOrEqual(10 / 0.35 + 1);
  });
});

describe('MotionDetector', () => {
  it('flags walking as moving and stillness as not, with a hold', () => {
    const m = new MotionDetector();
    let t = 0;
    for (const [dt, v] of walkSignal(2)) m.push((t = dt), v);
    expect(m.moving(t)).toBe(true);
    for (let i = 0; i < 200; i++) m.push((t += 16), 9.81);
    expect(m.moving(t)).toBe(false);
  });
});
