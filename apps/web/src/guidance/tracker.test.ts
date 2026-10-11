import { describe, expect, it } from 'vitest';
import { mockRouteWheelchair as route } from '@polyguide/shared/src/fixtures';
import { initialTrackerState, reduceTracker, trackerProgress, type TrackerConfig, type TrackerEffect, type TrackerEvent, type TrackerState } from './tracker';

const walk: TrackerConfig = { progressMode: 'steps', stepLengthM: 1, speedMps: 1.3 };
const wheel: TrackerConfig = { progressMode: 'motion', stepLengthM: 0.7, speedMps: 1 };

function run(events: TrackerEvent[], config = walk, from: TrackerState = initialTrackerState) {
  let state = from;
  const effects: TrackerEffect[] = [];
  for (const e of events) {
    const r = reduceTracker(state, e, config);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}
const steps = (n: number): TrackerEvent[] => Array.from({ length: n }, () => ({ type: 'step' }));
const spoken = (fx: TrackerEffect[]) => fx.filter((e) => e.type === 'speak').map((e) => (e as { text: string }).text);
const started = run([{ type: 'start', route }]).state;

describe('tracker', () => {
  it('start speaks the first step', () => {
    const { state, effects } = run([{ type: 'start', route }]);
    expect(state).toMatchObject({ phase: 'navigating', stepIndex: 0, progressM: 0 });
    expect(spoken(effects)).toEqual([route.steps[0].speech]);
  });

  it('enters approaching at 80 % and asks vision once', () => {
    // Step 0 is 30 m: 0.8 × 30 = 24 m; d − 4 = 26 m → approaching at 24 steps of 1 m.
    const before = run(steps(23), walk, started);
    expect(before.state.phase).toBe('navigating');
    const at = run(steps(1), walk, before.state);
    expect(at.state.phase).toBe('approaching');
    expect(at.effects).toEqual([{ type: 'requestVision', trigger: 'approaching_node' }]);
    expect(run(steps(5), walk, at.state).effects).toEqual([]);
  });

  it('auto-advances at 130 % with an undo hint', () => {
    const { state, effects } = run(steps(39), walk, started);
    expect(state).toMatchObject({ phase: 'navigating', stepIndex: 1, progressM: 0 });
    const last = spoken(effects).at(-1)!;
    expect(last).toContain("I think you've reached");
    expect(last).toContain(route.steps[1].speech);
    expect(last).toMatch(/Say back if not\.$/);
  });

  it('vision confirms when approaching but not at the very start of a long step', () => {
    const early = run([{ type: 'vision', advance: true, offRouteRoom: null, routeId: route.routeId, stepIndex: 0 }], walk, started);
    expect(early.state.stepIndex).toBe(0);
    const approaching = run(steps(24), walk, started).state;
    const ok = run([{ type: 'vision', advance: true, offRouteRoom: null, routeId: route.routeId, stepIndex: 0 }], walk, approaching);
    expect(ok.state).toMatchObject({ stepIndex: 1, phase: 'navigating' });
  });

  it('ignores stale vision for another step or route', () => {
    const approaching = run(steps(24), walk, started).state;
    expect(run([{ type: 'vision', advance: true, offRouteRoom: null, stepIndex: 3 }], walk, approaching).state.stepIndex).toBe(0);
    expect(run([{ type: 'vision', advance: true, offRouteRoom: null, routeId: 'other', stepIndex: 0 }], walk, approaching).state.stepIndex).toBe(0);
  });

  it('vertical steps ignore the pedometer and wait for next or vision', () => {
    const atElevator = run([{ type: 'user_next' }, { type: 'user_next' }], walk, started).state;
    expect(route.steps[atElevator.stepIndex].maneuver).toBe('take_elevator');
    expect(run(steps(50), walk, atElevator).state.stepIndex).toBe(2);
    expect(run([{ type: 'vision', advance: true, offRouteRoom: null, stepIndex: 2 }], walk, atElevator).state.stepIndex).toBe(3);
  });

  it('arrives when advancing into the arrive step', () => {
    const { state, effects } = run([{ type: 'user_next' }, { type: 'user_next' }, { type: 'user_next' }, { type: 'user_next' }], walk, started);
    expect(state).toMatchObject({ phase: 'arrived', stepIndex: 4 });
    expect(spoken(effects).at(-1)).toBe(route.steps[4].speech);
    // back from arrived returns to the last walking step
    expect(run([{ type: 'user_back' }], walk, state).state).toMatchObject({ phase: 'navigating', stepIndex: 3 });
  });

  it('off-route sign → rerouting → new route', () => {
    const r = run([{ type: 'vision', advance: false, offRouteRoom: 'HG G 5', stepIndex: 0 }], walk, started);
    expect(r.state.phase).toBe('rerouting');
    expect(r.effects).toContainEqual({ type: 'requestReroute', roomName: 'HG G 5' });
    expect(spoken(r.effects)).toEqual([]); // nothing said until the sign is checked and a route exists
    // further off-route results while rerouting do nothing
    expect(run([{ type: 'vision', advance: false, offRouteRoom: 'HG G 6' }], walk, r.state).effects).toEqual([]);
    const newRoute = { ...route, routeId: 'r_new', steps: route.steps.slice(3).map((s, i) => ({ ...s, index: i })) };
    const after = run([{ type: 'reroute', route: newRoute }], walk, r.state);
    expect(after.state).toMatchObject({ phase: 'navigating', stepIndex: 0, route: newRoute });
    expect(spoken(after.effects)[0]).toMatch(/^New route\. /);
  });

  it('reroute failure resumes the old route', () => {
    const r = run([{ type: 'vision', advance: false, offRouteRoom: 'HG G 5' }, { type: 'reroute_failed', message: 'No match.' }], walk, started);
    expect(r.state).toMatchObject({ phase: 'navigating', stepIndex: 0, route });
  });

  it('wheelchair progress comes from motion ticks, not steps', () => {
    expect(run(steps(40), wheel, started).state.progressM).toBe(0);
    const s = run(Array.from({ length: 10 }, () => ({ type: 'tick', dtS: 0.5, moving: true }) as TrackerEvent), wheel, started).state;
    expect(s.progressM).toBeCloseTo(5);
    expect(run([{ type: 'tick', dtS: 0.5, moving: false }], wheel, s).state.progressM).toBeCloseTo(5);
    // a long gap (backgrounded tab) is clamped to 2 s
    expect(run([{ type: 'tick', dtS: 60, moving: true }], wheel, s).state.progressM).toBeCloseTo(7);
  });

  it('a position fix on the current step moves progress there without talking', () => {
    const r = run([{ type: 'fix', routeId: route.routeId, stepIndex: 0, progressM: 12 }], walk, started);
    expect(r.state).toMatchObject({ phase: 'navigating', stepIndex: 0, progressM: 12 });
    expect(spoken(r.effects)).toEqual([]);
    // Near the end: approaching, so the camera confirms the step end.
    expect(run([{ type: 'fix', routeId: route.routeId, stepIndex: 0, progressM: 27 }], walk, started).state.phase).toBe('approaching');
  });

  it('a fix on a later step jumps there and says the new instruction', () => {
    const r = run([{ type: 'fix', routeId: route.routeId, stepIndex: 1, progressM: 5 }], walk, started);
    expect(r.state).toMatchObject({ phase: 'navigating', stepIndex: 1, progressM: 5 });
    expect(spoken(r.effects)).toEqual([route.steps[1].speech]);
  });

  it('a fix behind the tracker moves it back (the step counter ran ahead)', () => {
    const ahead = run(steps(20), walk, started).state;
    expect(run([{ type: 'fix', routeId: route.routeId, stepIndex: 0, progressM: 4 }], walk, ahead).state.progressM).toBe(4);
    const approaching = run(steps(25), walk, started).state;
    expect(run([{ type: 'fix', routeId: route.routeId, stepIndex: 0, progressM: 4 }], walk, approaching).state.phase).toBe('navigating');
  });

  it('ignores a fix for another route or when not navigating', () => {
    expect(run([{ type: 'fix', routeId: 'other', stepIndex: 1, progressM: 5 }], walk, started).state.stepIndex).toBe(0);
    expect(run([{ type: 'fix', routeId: route.routeId, stepIndex: 1, progressM: 5 }], walk, initialTrackerState).state).toEqual(initialTrackerState);
  });

  it('stop, repeat and progress numbers', () => {
    expect(spoken(run([{ type: 'repeat' }], walk, started).effects)).toEqual([route.steps[0].speech]);
    const s = run(steps(10), walk, started).state;
    const p = trackerProgress(s);
    expect(p.remainingStepM).toBe(20);
    expect(p.remainingTotalM).toBe(20 + 24 + 4 + 38);
    expect(run([{ type: 'stop' }], walk, s).state).toEqual(initialTrackerState);
  });

  it('altitude finishes an elevator step on the right floor, and only there', () => {
    const vi = route.steps.findIndex((st) => st.toLevelId && st.toLevelId !== st.levelId);
    expect(vi).toBeGreaterThanOrEqual(0);
    const target = route.steps[vi].toLevelId!;
    const onElevator: TrackerState = { ...started, stepIndex: vi, progressM: 0, phase: 'navigating' };
    // Wrong floor: nothing happens (the engine says so out loud instead).
    expect(run([{ type: 'floor_reached', levelId: 'ETH.HG.K' }], walk, onElevator).state.stepIndex).toBe(vi);
    const r = run([{ type: 'floor_reached', levelId: target }], walk, onElevator);
    expect(r.state.stepIndex).toBe(vi + 1);
    expect(spoken(r.effects)[0]).toMatch(new RegExp(`^You are on floor ${target.split('.').at(-1)}\. `));
  });

  it('a floor reading never moves a walking (horizontal) step', () => {
    const r = run([{ type: 'floor_reached', levelId: route.steps[0].levelId }], walk, started);
    expect(r.state.stepIndex).toBe(started.stepIndex);
  });
});

