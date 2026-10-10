import { describe, expect, it } from 'vitest';
import type { Place, PositionInfo, RouteStep } from '@polyguide/shared';
import { bearingAt, compassName, estimatePosition, formatLiveState, pointAlong, relDirection, turnPhrase, turnTo, type LiveStateInput } from './liveState';

const place: Place = { id: 'pl_f33', name: 'HG F 33.5', kind: 'room', levelId: 'ETH.HG.F', verticalOrder: 2, lat: 47.376, lon: 8.548, nodeId: 'n1', aliases: [] };

// 100 m due east, then 50 m due north (at ~47.376° N).
const kx = 111320 * Math.cos((47.376 * Math.PI) / 180);
const line: [number, number][] = [[8.548, 47.376], [8.548 + 100 / kx, 47.376], [8.548 + 100 / kx, 47.376 + 50 / 110540]];

const step = (over: Partial<RouteStep> = {}): RouteStep => ({
  index: 2, maneuver: 'left', text: 'Turn left, then go 150 m', speech: '', distanceM: 150, durationS: 120, bearingDeg: 90,
  levelId: 'ETH.HG.F', startNodeId: 'a', endNodeId: 'b', polyline: line, expectedLandmarks: [], edgeKinds: ['hallway'], ...over,
});

describe('geometry', () => {
  it('walks along a polyline and clamps at the ends', () => {
    const p = pointAlong(line, 50)!;
    expect((p.lon - 8.548) * kx).toBeCloseTo(50, 0);
    expect(p.lat).toBeCloseTo(47.376, 6);
    const q = pointAlong(line, 120)!;
    expect((q.lat - 47.376) * 110540).toBeCloseTo(20, 0);
    expect(pointAlong(line, 999)).toEqual({ lon: line[2][0], lat: line[2][1] });
    expect(pointAlong(line, -5)).toEqual({ lon: 8.548, lat: 47.376 });
  });

  it('gives the bearing of the segment ahead, switching just before a bend', () => {
    expect(bearingAt(line, 10)).toBeCloseTo(90, 0);
    expect(bearingAt(line, 99.5)).toBeCloseTo(0, 0);
    expect(bearingAt(line, 130)).toBeCloseTo(0, 0);
    expect(bearingAt(line, 999)).toBeCloseTo(0, 0);
    expect(bearingAt([[8.5, 47]], 0)).toBeNull();
  });

  it('turns and relative directions', () => {
    expect(turnTo(90, 0)).toBe(90);
    expect(turnTo(350, 10)).toBe(-20);
    expect(turnTo(180, 0)).toBe(180);
    expect(relDirection(5, 0)).toBe('ahead');
    expect(relDirection(30, 0)).toBe('slightly right (30°)');
    expect(relDirection(270, 0)).toBe('left (90°)');
    expect(relDirection(140, 0)).toBe('behind-right (140°)');
    expect(relDirection(185, 0)).toBe('behind');
    expect(compassName(93)).toBe('east');
    expect(compassName(350)).toBe('north');
    expect(turnPhrase(turnTo(28, 200))).toBe('turn around (172°)');
    expect(turnPhrase(-140)).toBe('turn around over your left shoulder (140° to the left)');
    expect(turnPhrase(8)).toBe('already facing it, go straight ahead');
  });
});

describe('estimatePosition', () => {
  it('is unknown without a fix or a route', () => {
    const e = estimatePosition({ now: 0, fix: null, navigating: false, step: null, stepIndex: 0, progressM: 0 });
    expect(e.confidence).toBe('none');
    expect(e.text).toMatch(/UNKNOWN/);
    expect(e.request).toEqual({});
  });

  it('uses a sign fix when not navigating', () => {
    const e = estimatePosition({ now: 10_000, fix: { place, source: 'sign', at: 0 }, navigating: false, step: null, stepIndex: 0, progressM: 0 });
    expect(e.request).toEqual({ placeId: 'pl_f33' });
    expect(e.text).toContain('at HG F 33.5, floor F (room sign read 10 s ago)');
    expect(e.confidence).toBe('high');
  });

  it('dead-reckons along the step while navigating, unless a fresh fix exists', () => {
    const e = estimatePosition({ now: 100_000, fix: { place, source: 'sign', at: 0 }, navigating: true, step: step(), stepIndex: 2, progressM: 50 });
    expect(e.request.levelId).toBe('ETH.HG.F');
    expect(((e.request.lon ?? 0) - 8.548) * kx).toBeCloseTo(50, 0);
    expect(e.text).toMatch(/about 50 m into step 3 .*±7 m.*last fix: at HG F 33\.5/);
    const fresh = estimatePosition({ now: 5_000, fix: { place, source: 'sign', at: 0 }, navigating: true, step: step(), stepIndex: 2, progressM: 50 });
    expect(fresh.request).toEqual({ placeId: 'pl_f33' });
  });

  it('puts a vertical step at its start', () => {
    const e = estimatePosition({ now: 0, fix: null, navigating: true, step: step({ maneuver: 'take_elevator', bearingDeg: null, toLevelId: 'ETH.HG.E' }), stepIndex: 0, progressM: 30 });
    expect(e.request.lon).toBe(8.548);
    expect(e.text).toMatch(/take elevator/);
  });
});

describe('formatLiveState', () => {
  const info: PositionInfo = {
    ok: true, levelId: 'ETH.HG.F', floor: 'F', nodeId: 'n1', snapM: 0.5,
    nearby: [
      { placeId: 'a', name: 'HG F 33.4', kind: 'room', distM: 5.5, bearingDeg: 343 },
      { placeId: 'b', name: 'Elevator near HG F 33.5', label: 'Elevator', kind: 'poi', distM: 11.5, bearingDeg: 71 },
      { placeId: 'c', name: 'HG F 30', label: 'Audimax', kind: 'room', distM: 20, bearingDeg: 180 },
    ],
    paths: [{ bearingDeg: 73, kind: 'hallway', lengthM: 7 }, { bearingDeg: 253, kind: 'hallway', lengthM: 7 }],
  };
  const base: LiveStateInput = {
    now: 0, screen: 'navigating', trip: { from: 'HG F 7', to: 'HG F 30', confirming: false },
    navigation: { stepIndex: 1, stepCount: 4, instruction: 'Go 20 m east', remainingStepM: 12.4, remainingTotalM: 60, bearingDeg: 90, vertical: false },
    estimate: { request: {}, text: 'about 8 m into step 2', confidence: 'medium' }, info, heading: { deg: 0, reliable: true }, moving: true,
    gps: { lat: 47, lon: 8, accuracyM: 38, ageS: 3 }, needs: ['blind'],
  };

  it('says where things are relative to the phone and how to turn', () => {
    const t = formatLiveState(base);
    expect(t).toMatch(/^\[Live state\]/);
    expect(t).toContain('step 2 of 4: "Go 20 m east". 12 m left on this step, 60 m to the destination.');
    expect(t).toContain('Phone points 0° (north). User is moving.');
    expect(t).toContain('To face the route: turn right (90° to the right).');
    expect(t).toContain('HG F 33.4 6 m slightly left (17°)');
    expect(t).toContain('Elevator 12 m right (71°)');
    expect(t).toContain('HG F 30 (Audimax) 20 m behind');
    expect(t).toContain('Walkable from here: corridor right (73°); corridor left (107°)');
    expect(t).toContain('GPS: ±38 m, 3 s old (too coarse indoors');
    expect(t).toContain('Needs: blind.');
  });

  it('falls back to compass names without a heading', () => {
    const t = formatLiveState({ ...base, heading: { deg: null, reliable: false } });
    expect(t).toContain('Heading: unknown');
    expect(t).toContain('Elevator 12 m east');
  });
});
