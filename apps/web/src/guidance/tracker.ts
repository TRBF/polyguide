/**
 * Step tracker (SPEC §5.3) as a pure reducer: (state, event) → { state, effects }.
 * The hook feeds it sensor, vision and user events and executes the effects.
 *
 *   idle → navigating(step, progress) → approaching → (advance) → … → arrived
 *   any  → rerouting (off-route sign) → navigating on the new route
 */
import type { RouteResult, RouteStep, SpeechPriority, TrackerPhase, VisionTrigger } from '@polyguide/shared';

type Route = Extract<RouteResult, { ok: true }>;

export interface TrackerConfig {
  /** 'steps' = pedometer; 'motion' = elapsed time × speed while moving (wheelchair, SPEC §5.2). */
  progressMode: 'steps' | 'motion';
  stepLengthM: number;
  speedMps: number;
}

export interface TrackerState {
  phase: TrackerPhase;
  route: Route | null;
  stepIndex: number;
  /** Metres along the current step. */
  progressM: number;
  /** Hazards of this step already warned of (or passed), in order; reset with every step. */
  warned?: number;
}

export type TrackerEvent =
  | { type: 'start'; route: Route }
  | { type: 'stop' }
  | { type: 'step' }
  | { type: 'tick'; dtS: number; moving: boolean }
  | { type: 'vision'; advance: boolean; offRouteRoom: string | null; routeId?: string; stepIndex?: number }
  /** A known position (sign read, the user's word) projected onto the route: beats the step counter. */
  | { type: 'fix'; routeId: string; stepIndex: number; progressM: number }
  | { type: 'user_next' }
  | { type: 'user_back' }
  | { type: 'repeat' }
  | { type: 'reroute'; route: Route }
  | { type: 'reroute_failed'; message: string }
  /** The altimeter is confident the user is now on this floor (elevator ride, stairs or GPS altitude). */
  | { type: 'floor_reached'; levelId: string };

export type TrackerEffect =
  | { type: 'speak'; text: string; priority: SpeechPriority }
  | { type: 'requestVision'; trigger: VisionTrigger }
  | { type: 'requestReroute'; roomName: string };

export interface TrackerResult {
  state: TrackerState;
  effects: TrackerEffect[];
}

export const initialTrackerState: TrackerState = { phase: 'idle', route: null, stepIndex: 0, progressM: 0 };

const VERTICAL: ReadonlySet<RouteStep['maneuver']> = new Set(['take_elevator', 'take_stairs_up', 'take_stairs_down', 'take_ramp_up', 'take_ramp_down', 'take_escalator']);

/** Elevator / stairs / ramp between floors: progress is not measurable, only "done" or vision advances. */
export const isVerticalStep = (s: RouteStep) => VERTICAL.has(s.maneuver) || (s.toLevelId != null && s.toLevelId !== s.levelId);

const APPROACH_FRACTION = 0.8;
const APPROACH_MARGIN_M = 4;
const AUTO_ADVANCE_FRACTION = 1.3;
/** Vision may confirm a horizontal step early, but not right after it started. */
const VISION_MIN_FRACTION = 0.5;
const SHORT_STEP_M = 10;

const say = (text: string, priority: SpeechPriority = 'instruction'): TrackerEffect => ({ type: 'speak', text, priority });
const floorName = (levelId: string) => levelId.split('.').at(-1) ?? levelId;
const stepSpeech = (s: RouteStep) => s.speech || s.text;

/** What the user will be at when this step ends, phrased for speech. */
function endLabel(s: RouteStep): string {
  const end = [...s.expectedLandmarks].filter((l) => l.atDistanceM >= s.distanceM - 6).sort((a, b) => b.atDistanceM - a.atDistanceM);
  const k = end.find((l) => l.kind === 'elevator' || l.kind === 'stairs' || l.kind === 'entrance');
  if (k) return k.kind === 'entrance' ? 'the door' : `the ${k.kind}`;
  return 'the end of this part';
}

function enterStep(state: TrackerState, route: Route, index: number, prefix = ''): TrackerResult {
  const step = route.steps[index];
  if (!step) return { state: { ...state, route, phase: 'arrived', progressM: 0 }, effects: [] };
  if (step.maneuver === 'arrive' || (index >= route.steps.length - 1 && step.distanceM === 0)) {
    return { state: { phase: 'arrived', route, stepIndex: index, progressM: 0 }, effects: [say(`${prefix}${stepSpeech(step)}`)] };
  }
  return { state: { phase: 'navigating', route, stepIndex: index, progressM: 0 }, effects: [say(`${prefix}${stepSpeech(step)}`)] };
}

function advance(state: TrackerState, how: 'user' | 'vision' | 'auto'): TrackerResult {
  const route = state.route!;
  const cur = route.steps[state.stepIndex];
  if (how === 'auto') {
    const r = enterStep(state, route, state.stepIndex + 1, `I think you've reached ${endLabel(cur)}. `);
    // Tell the user how to undo a guess, unless we just announced arrival.
    if (r.state.phase !== 'arrived') r.effects = [say(`${(r.effects[0] as { text: string }).text} Say back if not.`)];
    return r;
  }
  return enterStep(state, route, state.stepIndex + 1);
}

/* ───── Hazards: stairs and doors are announced a few metres ahead, as an instruction (it cuts into speech) ───── */

/** Stairs need time to slow down and find the handrail; a door only a few steps. */
const STAIRS_WARN_M = 8;
const DOOR_WARN_M = 5;
const HAZARD_AHEAD: Partial<Record<RouteStep['maneuver'], string>> = {
  take_stairs_down: 'Stairs going down',
  take_stairs_up: 'Stairs going up',
  take_escalator: 'Escalator',
  take_ramp_down: 'Ramp going down',
  take_ramp_up: 'Ramp going up',
  enter_building: 'Door',
  exit_building: 'Door',
};

interface Hazard { atM: number; warnM: number; what: string }

/** What the user walks into on this step: doors along it, and stairs or a door where the next step starts. */
function hazardsOf(route: Route, index: number): Hazard[] {
  const step = route.steps[index];
  const out: Hazard[] = step.expectedLandmarks
    .filter((l) => l.kind === 'entrance')
    .map((l) => ({ atM: l.atDistanceM, warnM: DOOR_WARN_M, what: 'Door' }));
  const next = route.steps[index + 1];
  const what = next && HAZARD_AHEAD[next.maneuver];
  if (what) {
    const door = what === 'Door';
    // The step's own door landmark at its end is the same door.
    if (!(door && out.some((h) => Math.abs(h.atM - step.distanceM) <= 2))) out.push({ atM: step.distanceM, warnM: door ? DOOR_WARN_M : STAIRS_WARN_M, what });
  }
  // One right at the start is already in the step's own instruction.
  return out.filter((h) => h.atM > h.warnM + 2).sort((a, b) => a.atM - b.atM);
}

const metresPhrase = (m: number) => (m < 3 ? 'a few metres' : `about ${Math.max(5, Math.round(m / 5) * 5)} metres`);

/** The next hazard within its warning distance, said once; ones already walked past are skipped silently. */
function checkHazards(state: TrackerState): TrackerResult {
  const hazards = hazardsOf(state.route!, state.stepIndex);
  let warned = state.warned ?? 0;
  let text: string | null = null;
  while (warned < hazards.length && hazards[warned].atM - state.progressM <= hazards[warned].warnM) {
    const h = hazards[warned++];
    const left = h.atM - state.progressM;
    text = left < -1 ? null : `${h.what} ahead, ${metresPhrase(left)}.`;
  }
  if (warned === (state.warned ?? 0)) return { state, effects: [] };
  return { state: { ...state, warned }, effects: text ? [say(text, 'instruction')] : [] };
}

/** After progress changed: hazard warnings, then navigating → approaching → auto-advance. */
function checkProgress(state: TrackerState): TrackerResult {
  const step = state.route?.steps[state.stepIndex];
  if (!step || isVerticalStep(step)) return { state, effects: [] };
  const warn = checkHazards(state);
  state = warn.state;
  const d = step.distanceM;
  if (state.phase === 'navigating' && (state.progressM >= APPROACH_FRACTION * d || state.progressM >= d - APPROACH_MARGIN_M)) {
    return { state: { ...state, phase: 'approaching' }, effects: [...warn.effects, { type: 'requestVision', trigger: 'approaching_node' }] };
  }
  if (state.phase === 'approaching' && state.progressM >= AUTO_ADVANCE_FRACTION * d) {
    const r = advance(state, 'auto');
    return { state: r.state, effects: [...warn.effects, ...r.effects] };
  }
  return warn;
}

const active = (s: TrackerState) => (s.phase === 'navigating' || s.phase === 'approaching') && !!s.route;

export function reduceTracker(state: TrackerState, event: TrackerEvent, config: TrackerConfig): TrackerResult {
  const none: TrackerResult = { state, effects: [] };
  switch (event.type) {
    case 'start': {
      if (!event.route.steps.length) return { state: initialTrackerState, effects: [say('This route has no steps.', 'info')] };
      return enterStep(initialTrackerState, event.route, 0);
    }

    case 'stop':
      return { state: { ...initialTrackerState }, effects: state.phase === 'idle' ? [] : [say('Navigation stopped.', 'info')] };

    case 'step': {
      if (!active(state) || config.progressMode !== 'steps') return none;
      const step = state.route!.steps[state.stepIndex];
      if (isVerticalStep(step)) return none;
      return checkProgress({ ...state, progressM: state.progressM + config.stepLengthM });
    }

    case 'tick': {
      if (!active(state) || config.progressMode !== 'motion' || !event.moving || event.dtS <= 0) return none;
      const step = state.route!.steps[state.stepIndex];
      if (isVerticalStep(step)) return none;
      // Clamp dt so a backgrounded tab doesn't teleport the user.
      return checkProgress({ ...state, progressM: state.progressM + config.speedMps * Math.min(event.dtS, 2) });
    }

    case 'vision': {
      if (!active(state)) return none;
      if (event.routeId && event.routeId !== state.route!.routeId) return none;
      if (event.stepIndex != null && event.stepIndex !== state.stepIndex) return none;
      if (event.offRouteRoom) {
        return {
          state: { ...state, phase: 'rerouting' },
          // Silent until it is real: the sign is checked first (two witnesses for a big jump), and "New route."
          // is said when there is one. Announcing now would cry wolf on every misread sign.
          effects: [{ type: 'requestReroute', roomName: event.offRouteRoom }],
        };
      }
      if (!event.advance) return none;
      const step = state.route!.steps[state.stepIndex];
      const earlyOk = state.phase === 'approaching' || isVerticalStep(step) || step.distanceM <= SHORT_STEP_M || state.progressM >= VISION_MIN_FRACTION * step.distanceM;
      return earlyOk ? advance(state, 'vision') : none;
    }

    case 'fix': {
      if (!active(state) || event.routeId !== state.route!.routeId) return none;
      const route = state.route!;
      if (!route.steps[event.stepIndex]) return none;
      const progressM = Math.max(0, event.progressM);
      if (event.stepIndex === state.stepIndex) return checkProgress({ ...state, phase: 'navigating', progressM });
      // Another step: say its instruction (a step behind, too: the counter had run ahead of the user).
      const entered = enterStep(state, route, event.stepIndex);
      if (entered.state.phase !== 'navigating') return entered;
      const r = checkProgress({ ...entered.state, progressM });
      return { state: r.state, effects: [...entered.effects, ...r.effects] };
    }

    case 'user_next': {
      if (state.phase === 'rerouting') return { state, effects: [say('Rerouting, one moment.', 'info')] };
      if (!active(state)) return state.phase === 'arrived' ? { state, effects: [say(stepSpeech(state.route!.steps[state.stepIndex]))] } : { state, effects: [say('Navigation has not started.', 'info')] };
      return advance(state, 'user');
    }

    case 'user_back': {
      if (!state.route || state.phase === 'idle' || state.phase === 'rerouting') return none;
      const steps = state.route.steps;
      let i = state.stepIndex - 1;
      if (state.phase === 'arrived') {
        i = steps.length - 1;
        while (i > 0 && steps[i].maneuver === 'arrive') i--;
      }
      return enterStep(state, state.route, Math.max(0, i));
    }

    case 'repeat': {
      const step = state.route?.steps[state.stepIndex];
      if (!step || state.phase === 'idle') return { state, effects: [say('There is no instruction to repeat yet.', 'info')] };
      return { state, effects: [say(stepSpeech(step))] };
    }

    case 'reroute': {
      if (!event.route.steps.length) return { state: { ...state, phase: 'navigating' }, effects: [say('I could not build a new route.', 'info')] };
      return enterStep(state, event.route, 0, 'New route. ');
    }

    case 'floor_reached': {
      // Altitude finishes an elevator or stairs step by itself: no "done" needed, no camera needed.
      if (!active(state)) return none;
      const step = state.route!.steps[state.stepIndex];
      if (!isVerticalStep(step) || step.toLevelId !== event.levelId) return none;
      return enterStep(state, state.route!, state.stepIndex + 1, `You are on floor ${floorName(event.levelId)}. `);
    }

    case 'reroute_failed':
      if (state.phase !== 'rerouting') return none;
      return { state: { ...state, phase: 'navigating' }, effects: [say(`${event.message} Continuing with the current route.`, 'info')] };
  }
}

/** Derived numbers for GuidanceState. */
export function trackerProgress(state: TrackerState) {
  const steps = state.route?.steps ?? [];
  const currentStep = steps[state.stepIndex] ?? null;
  const nextStep = steps[state.stepIndex + 1] ?? null;
  if (!currentStep || state.phase === 'idle') {
    return { currentStep, nextStep, remainingStepM: currentStep?.distanceM ?? 0, remainingTotalM: state.route?.totalDistanceM ?? 0 };
  }
  if (state.phase === 'arrived') return { currentStep, nextStep, remainingStepM: 0, remainingTotalM: 0 };
  const remainingStepM = Math.max(0, currentStep.distanceM - state.progressM);
  const after = steps.slice(state.stepIndex + 1).reduce((t, s) => t + s.distanceM, 0);
  return { currentStep, nextStep, remainingStepM, remainingTotalM: remainingStepM + after };
}
