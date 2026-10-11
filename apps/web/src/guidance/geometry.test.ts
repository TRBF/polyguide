import { describe, expect, it } from 'vitest';
import type { RouteStep } from '@polyguide/shared';
import { nextNodeAhead, projectOntoRoute } from './geometry';

// Metres → [lon, lat] around HG.
const LAT0 = 47.376;
const LON0 = 8.548;
const kx = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const at = (eastM: number, northM: number): [number, number] => [LON0 + eastM / kx, LAT0 + northM / 110540];
const pt = (eastM: number, northM: number, levelId = 'ETH.HG.F') => ({ lon: at(eastM, northM)[0], lat: at(eastM, northM)[1], levelId });

const step = (index: number, polyline: [number, number][], over: Partial<RouteStep> = {}): RouteStep => ({
  index, maneuver: 'straight', text: '', speech: '', distanceM: 0, durationS: 0, bearingDeg: 0, levelId: 'ETH.HG.F',
  startNodeId: `s${index}`, endNodeId: `e${index}`, polyline, expectedLandmarks: [], edgeKinds: ['hallway'], ...over,
});

// Step 0: 40 m east, then 20 m north (one bend). Step 1: 30 m west. Step 2: elevator. Step 3 on floor E.
const steps: RouteStep[] = [
  step(0, [at(0, 0), at(40, 0), at(40, 20)], { distanceM: 60, bearingDeg: 90 }),
  step(1, [at(40, 20), at(10, 20)], { distanceM: 30, bearingDeg: 270, maneuver: 'left' }),
  step(2, [at(10, 20)], { distanceM: 0, bearingDeg: null, maneuver: 'take_elevator', toLevelId: 'ETH.HG.E' }),
  step(3, [at(10, 20), at(10, 0)], { distanceM: 20, bearingDeg: 180, levelId: 'ETH.HG.E' }),
];

describe('nextNodeAhead', () => {
  it('points from where the user is to the next node of the path', () => {
    const n = nextNodeAhead(steps[0].polyline, 10)!;
    expect(n.distM).toBeCloseTo(30, 0);
    expect(n.bearingDeg).toBeCloseTo(90, 0);
  });

  it('switches to the node after a bend once the bend is close', () => {
    const n = nextNodeAhead(steps[0].polyline, 39)!;
    expect(n.distM).toBeCloseTo(21, 0);
    // From (39, 0) to (40, 20): almost due north.
    expect(n.bearingDeg).toBeGreaterThan(0);
    expect(n.bearingDeg).toBeLessThan(5);
  });

  it('is null at the end of the step', () => {
    expect(nextNodeAhead(steps[0].polyline, 60)).toBeNull();
  });
});

describe('projectOntoRoute', () => {
  it('finds the step and the distance along it', () => {
    expect(projectOntoRoute(steps, pt(25, 1))).toMatchObject({ stepIndex: 0, alongM: expect.closeTo(25, 0), offM: expect.closeTo(1, 0) });
    // After the bend: 40 m east + 12 m north.
    expect(projectOntoRoute(steps, pt(41, 12))).toMatchObject({ stepIndex: 0, alongM: expect.closeTo(52, 0) });
    expect(projectOntoRoute(steps, pt(20, 21))).toMatchObject({ stepIndex: 1, alongM: expect.closeTo(20, 0) });
  });

  it('puts the shared node between two steps at the start of the later one', () => {
    expect(projectOntoRoute(steps, pt(40, 20))).toMatchObject({ stepIndex: 1, alongM: expect.closeTo(0, 0) });
  });

  it('only matches steps on the same floor, never stairs or elevators', () => {
    expect(projectOntoRoute(steps, pt(10, 5, 'ETH.HG.E'))).toMatchObject({ stepIndex: 3, alongM: expect.closeTo(15, 0) });
    expect(projectOntoRoute(steps, pt(10, 5, 'ETH.HG.D'))).toBeNull();
  });

  it('does not look more than one step back', () => {
    expect(projectOntoRoute(steps, pt(5, 0), 2)).toMatchObject({ stepIndex: 1 });
  });

  it('reports how far off the route the point is', () => {
    expect(projectOntoRoute(steps, pt(20, -30))!.offM).toBeCloseTo(30, 0);
  });
});
