import { describe, expect, it } from 'vitest';
import { HeadingSpeech, beaconParams, headingDelta, normalize180 } from './heading';

describe('heading math', () => {
  it('normalize180 wraps into (-180, 180]', () => {
    expect(normalize180(190)).toBe(-170);
    expect(normalize180(-190)).toBe(170);
    expect(normalize180(180)).toBe(180);
    expect(normalize180(-180)).toBe(180);
    expect(normalize180(720)).toBe(0);
  });

  it('delta is positive when the route is to the right', () => {
    expect(headingDelta(90, 0)).toBe(90);
    expect(headingDelta(10, 350)).toBe(20);
    expect(headingDelta(350, 10)).toBe(-20);
    expect(headingDelta(null, 10)).toBeNull();
  });

  it('beacon pans with delta, rises in pitch and double-ticks on course', () => {
    expect(beaconParams(45).pan).toBeCloseTo(0.5);
    expect(beaconParams(-180).pan).toBe(-1);
    expect(beaconParams(0).freq).toBeGreaterThan(beaconParams(90).freq);
    expect(beaconParams(10).double).toBe(true);
    expect(beaconParams(20).double).toBe(false);
  });
});

describe('HeadingSpeech', () => {
  it('waits 1.5 s off course, then says turn; then straight ahead once', () => {
    const h = new HeadingSpeech();
    expect(h.update(-90, 0)).toBeNull();
    expect(h.update(-90, 1000)).toBeNull();
    expect(h.update(-90, 1600)).toBe('Turn left');
    expect(h.update(-90, 3000)).toBeNull(); // rate limit
    expect(h.update(5, 3500)).toBeNull(); // aligned, but < 4 s since last phrase
    expect(h.update(5, 5700)).toBe('Straight ahead');
    expect(h.update(5, 12000)).toBeNull(); // only once
  });

  it('says turn around when facing backwards and reminds after 8 s', () => {
    const h = new HeadingSpeech();
    h.update(170, 0);
    expect(h.update(170, 1600)).toBe('Turn around');
    expect(h.update(170, 6000)).toBeNull();
    expect(h.update(170, 9700)).toBe('Turn around');
  });

  it('is silent with no heading', () => {
    const h = new HeadingSpeech();
    expect(h.update(null, 0)).toBeNull();
    expect(h.update(null, 10000)).toBeNull();
  });
});
