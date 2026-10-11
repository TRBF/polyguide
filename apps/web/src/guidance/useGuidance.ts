/**
 * useGuidance — Track B's implementation of the UseGuidance seam (packages/shared types.ts).
 * Wires sensors → tracker → heading cue → vision → reroute. Speech goes out through
 * options.onSpeak only; Track C owns the TTS queue.
 *
 * Works without AI: with vision disabled or failing, the pedometer / motion estimate and manual
 * "Next" still drive the tracker (SPEC §5.1).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  API,
  type GuidanceActions,
  type GuidanceOptions,
  type GuidanceState,
  type LocalizeResult,
  type Profile,
  type RouteResult,
  type SpeechPriority,
  type UseGuidance,
  type VisionRequest,
  type VisionResponse,
  type VisionResult,
  type VisionTrigger,
} from '@polyguide/shared';
import { captureFrame, holdCamera, startCamera } from './camera';
import { nextNodeAhead, pointAlong, projectOntoRoute } from './geometry';
import { positionGate } from './jumpGate';
import { ALTIMETER_CONFIDENT, RISER_M, altimeter, type AltimeterState } from './altimeter';
import { AudioBeacon, HeadingSpeech, headingDelta } from './heading';
import { postJson } from './net';
import { startSensors, type SensorSnapshot } from './sensors';
import { initialTrackerState, isVerticalStep, reduceTracker, trackerProgress, type TrackerConfig, type TrackerEvent, type TrackerState } from './tracker';
import { VisionController, decideVision, type VisionRequestBody } from './vision';

type Route = Extract<RouteResult, { ok: true }>;

const TICK_MS = 500;
const OFF_HEADING_DEG = 60;
const OFF_HEADING_HOLD_MS = 3000;
const OFF_HEADING_COOLDOWN_MS = 10_000;
const PERIODIC_MS = 4000;
const PERIODIC_WITHIN_M = 20;
const VISION_CLIENT_TIMEOUT_MS = 8000;
/** A sign's probability after the HG sign model (number, letter, misreads, prior); big jumps also face the gate. */
const REROUTE_MIN_CONFIDENCE = 0.6;
/** Demo walk: a calm walking pace, and how long an elevator or stairs "ride" takes. */
const DEMO_SPEED_MPS = 1.1;
const DEMO_RIDE_MS = 6000;
/** On an elevator/stairs step, the floor the route expects counts as reached at this belief. */
const EXPECTED_FLOOR_MIN = 0.5;
/** A known position this close to the route moves the tracker; farther off, the caller reroutes. */
export const LOCATE_ON_ROUTE_M = 15;

const floorOf = (levelId: string) => levelId.split('.').at(-1) ?? levelId;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const speakDist = (m: number) => (m < 3 ? 'a few metres' : `about ${Math.max(5, Math.round(m / 5) * 5)} metres`);

interface Snapshot {
  tracker: TrackerState;
  headingDeg: number | null;
  compassReliable: boolean;
  moving: boolean;
  visionBusy: boolean;
  lastVision: VisionResult | null;
  lastAnnouncement: string;
  error: string | null;
}

/** All guidance logic, outside React. One instance per hook; reusable after stop(). */
export class GuidanceEngine {
  private snap: Snapshot = {
    tracker: initialTrackerState,
    headingDeg: null,
    compassReliable: false,
    moving: false,
    visionBusy: false,
    lastVision: null,
    lastAnnouncement: '',
    error: null,
  };
  private listeners = new Set<() => void>();

  private route: Route | null = null;
  private profile: Profile = { needs: [] };
  private options: GuidanceOptions = { onSpeak: () => undefined };

  private sensor: SensorSnapshot | null = null;
  private stopSensors: (() => void) | null = null;
  private ticker: number | null = null;
  private lastTickAt = 0;
  private beacon = new AudioBeacon();
  private beaconWanted = true;
  private headingSpeech = new HeadingSpeech();
  private vision: VisionController | null = null;
  private visionUnavailable = false;
  private stopAltimeter: (() => void) | null = null;
  private lastWrongFloorRideAt = 0;
  private demoVertical: { key: string; since: number; done: boolean } | null = null;
  private lastVisionUtterance = '';
  private offHeadingSince: number | null = null;
  private lastOffHeadingVisionAt = -Infinity;
  private lastPeriodicAt = -Infinity;
  /** routeId we produced by rerouting, so the echo through props doesn't reset us. */
  private ownRouteId: string | null = null;

  /* ───── React plumbing ───── */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  setInputs(route: Route | null, profile: Profile, options: GuidanceOptions) {
    this.route = route;
    this.profile = profile;
    this.options = options;
  }

  /** Called when the route prop changes identity. */
  routeChanged(route: Route | null) {
    const t = this.snap.tracker;
    if (route && (route.routeId === t.route?.routeId || route.routeId === this.ownRouteId)) return;
    if (t === initialTrackerState && !this.snap.lastVision) return;
    if (t.phase !== 'idle') this.stopLive();
    this.set({ tracker: initialTrackerState, lastVision: null, error: null });
  }

  setBeaconWanted(on: boolean) {
    this.beaconWanted = on;
    this.beacon.setEnabled(on);
  }

  /* ───── Actions ───── */

  start = () => {
    const route = this.route;
    if (!route?.steps.length) {
      this.speak('Choose a route before starting navigation.', 'info');
      return;
    }
    this.ownRouteId = null;
    this.visionUnavailable = false;
    this.lastVisionUtterance = '';
    this.dispatch({ type: 'start', route });
    // The user confirmed where they start: that is the floor the altimeter measures height changes from.
    if (route.steps[0]?.levelId) altimeter.setKnown(route.steps[0].levelId, 'strong');
    if (this.snap.tracker.phase !== 'arrived') this.startLive();
  };

  stop = () => {
    this.dispatch({ type: 'stop' });
    this.stopLive();
  };

  next = () => this.dispatch({ type: 'user_next' });
  back = () => {
    const wasArrived = this.snap.tracker.phase === 'arrived';
    this.dispatch({ type: 'user_back' });
    if (wasArrived && this.snap.tracker.phase === 'navigating') this.startLive();
  };
  repeat = () => this.dispatch({ type: 'repeat' });

  whereAmI = () => {
    const t = this.snap.tracker;
    const { currentStep, remainingStepM, remainingTotalM } = trackerProgress(t);
    if (!t.route || !currentStep || t.phase === 'idle') {
      this.speak('Navigation has not started, so I do not know where you are yet.', 'info');
      return;
    }
    const n = t.route.steps.length;
    if (t.phase === 'arrived') {
      this.speak(currentStep.speech || currentStep.text, 'instruction');
      return;
    }
    const where = `Step ${t.stepIndex + 1} of ${n}, on floor ${floorOf(currentStep.levelId)}.`;
    const rest = isVerticalStep(currentStep)
      ? ` ${currentStep.speech || currentStep.text}`
      : ` ${capitalize(speakDist(remainingStepM))} left on this part, ${speakDist(remainingTotalM)} to the destination.`;
    this.speak(where + rest, 'instruction');
    this.requestVision('user_query', 'Where am I? Read the room sign on the nearest wall or door if any part of it is legible. If none is, say in a few words what is around me.');
  };

  /**
   * What the route says is around the user, for when the camera cannot tell: the next landmark on this
   * step (or the step's end). The person and the route are trusted over an unreadable photo.
   */
  private routeHint(): string {
    const t = this.snap.tracker;
    const { currentStep, remainingStepM } = trackerProgress(t);
    if (!currentStep) return '';
    const travelled = Math.max(0, currentStep.distanceM - remainingStepM);
    const next = currentStep.expectedLandmarks.find((l) => l.atDistanceM >= travelled - 3);
    if (!next) return `Keep following the step: ${currentStep.speech || currentStep.text}`;
    const side = next.side === 'left' ? ' on your left' : next.side === 'right' ? ' on your right' : next.side === 'ahead' ? ' ahead' : '';
    const inM = Math.round(next.atDistanceM - travelled);
    return inM > 3 ? `${next.label} should come${side} in about ${inM} metres.` : `You should be near ${next.label}${side}.`;
  }

  whatsAhead = () => {
    const t = this.snap.tracker;
    const { nextStep } = trackerProgress(t);
    if (t.phase === 'idle' || !t.route) {
      this.speak('Navigation has not started.', 'info');
      return;
    }
    this.speak(nextStep ? `Next: ${nextStep.speech || nextStep.text}` : `Your destination, ${t.route.to.name}, is ahead.`, 'instruction');
    this.requestVision('user_query', 'What is ahead of me?');
  };

  /** A camera check at the start of each step; goes through the same single-flight queue as every other check. */
  checkStep = () => {
    const t = this.snap.tracker;
    if (t.phase !== 'navigating' && t.phase !== 'approaching') return;
    this.requestVision('approaching_node');
  };

  locate = (at: { lat: number; lon: number; levelId: string }): { offM: number; stepIndex: number } | null => {
    const t = this.snap.tracker;
    if (!t.route || (t.phase !== 'navigating' && t.phase !== 'approaching')) return null;
    const p = projectOntoRoute(t.route.steps, at, t.stepIndex);
    if (!p) return null;
    if (p.offM <= LOCATE_ON_ROUTE_M) this.dispatch({ type: 'fix', routeId: t.route.routeId, stepIndex: p.stepIndex, progressM: p.alongM });
    // A settled position (already past the two-witness gate) also fixes the floor for the altimeter.
    altimeter.setKnown(at.levelId, 'strong');
    return { offM: p.offM, stepIndex: p.stepIndex };
  };

  setBeaconEnabled = (on: boolean) => {
    this.setBeaconWanted(on);
    this.speak(on ? 'Audio beacon on.' : 'Audio beacon off.', 'info');
  };

  /** Stop sensors, camera, beacon and timers. Safe to call repeatedly; start() revives everything. */
  stopLive() {
    this.stopSensors?.();
    this.stopSensors = null;
    this.stopAltimeter?.();
    this.stopAltimeter = null;
    if (this.ticker != null) window.clearInterval(this.ticker);
    this.ticker = null;
    this.beacon.stop();
    this.vision?.dispose();
    this.vision = null;
    // Let it idle out rather than closing: "Scan a room sign" right after stopping stays instant.
    holdCamera(false);
    this.sensor = null;
    this.set({ visionBusy: false, moving: false });
  }

  dispose() {
    this.stopLive();
    this.beacon.dispose();
    this.beacon = new AudioBeacon();
    this.beacon.setEnabled(this.beaconWanted);
  }

  /* ───── Internals ───── */

  private config(): TrackerConfig {
    const wheel = this.profile.needs.includes('wheelchair');
    if (this.options.simulateWalk) return { progressMode: 'motion', stepLengthM: 0.7, speedMps: DEMO_SPEED_MPS };
    return {
      progressMode: wheel ? 'motion' : 'steps',
      stepLengthM: this.profile.stepLengthM ?? 0.7,
      speedMps: this.profile.speedMps ?? (wheel ? 1.0 : 1.3),
    };
  }

  private speak(text: string, priority: SpeechPriority, automatic = false) {
    if (!text) return;
    this.set({ lastAnnouncement: text });
    this.options.onSpeak(text, priority, automatic);
  }

  private dispatch(event: TrackerEvent) {
    const prev = this.snap.tracker;
    const { state, effects } = reduceTracker(prev, event, this.config());
    if (state !== prev) {
      if (state.stepIndex !== prev.stepIndex || state.route !== prev.route) {
        this.headingSpeech.reset();
        this.offHeadingSince = null;
      }
      this.set({ tracker: state });
    }
    for (const fx of effects) {
      if (fx.type === 'speak') this.speak(fx.text, fx.priority);
      else if (fx.type === 'requestVision') this.requestVision(fx.trigger);
      else if (fx.type === 'requestReroute') void this.reroute(fx.roomName);
    }
    if (state.phase === 'arrived' && prev.phase !== 'arrived') this.stopLive();
  }

  /** A footstep: progress along the step, and on stairs one riser up or down for the altimeter. */
  private onStep() {
    if (this.options.simulateWalk) return; // the demo walker moves, not the presenter's feet
    const step = trackerProgress(this.snap.tracker).currentStep;
    if (step?.maneuver === 'take_stairs_up') altimeter.onStairStep(1);
    else if (step?.maneuver === 'take_stairs_down') altimeter.onStairStep(-1);
    this.dispatch({ type: 'step' });
  }

  /**
   * The altimeter changed its mind about the floor. On an elevator or stairs step, reaching the target floor
   * finishes the step by itself; an elevator ride that ended on another floor is said out loud at once.
   */
  private onFloor(s: AltimeterState) {
    const t = this.snap.tracker;
    const step = trackerProgress(t).currentStep;
    if (!step || !s.levelId || (t.phase !== 'navigating' && t.phase !== 'approaching')) return;
    if (!isVerticalStep(step)) return;
    // The route expects this floor: the most likely floor being it is enough (half floors nearby keep the
    // belief from looking certain). Claiming a different floor needs real confidence.
    if (s.levelId === step.toLevelId && s.probability >= EXPECTED_FLOOR_MIN) {
      this.dispatch({ type: 'floor_reached', levelId: s.levelId });
      return;
    }
    if (s.probability < ALTIMETER_CONFIDENT) return;
    const ride = s.lastRide;
    if (s.basis === 'elevator' && ride && Date.now() - ride.at < 3000 && ride.at !== this.lastWrongFloorRideAt && s.levelId !== step.levelId && step.toLevelId) {
      this.lastWrongFloorRideAt = ride.at;
      const floor = (id: string) => id.split('.').at(-1);
      this.speak(`This seems to be floor ${floor(s.levelId)}, but the route goes to floor ${floor(step.toLevelId)}. Stay in the elevator and choose floor ${floor(step.toLevelId)}.`, 'instruction');
    }
  }

  /**
   * Demo walk: on an elevator or stairs step, after a short "ride" the height change is fed to the real altimeter
   * (risers for stairs, a ride for elevators), which then finishes the step exactly as it would on site.
   */
  private simulateFloorChange(now: number) {
    const t = this.snap.tracker;
    const step = trackerProgress(t).currentStep;
    const key = `${t.route?.routeId}:${t.stepIndex}`;
    if (!step || !isVerticalStep(step) || !step.toLevelId) {
      this.demoVertical = null;
      return;
    }
    if (this.demoVertical?.key !== key) {
      this.demoVertical = { key, since: now, done: false };
      return;
    }
    // Safety net for presentations: a vertical step never stalls the demo.
    if (this.demoVertical.done) {
      if (now - this.demoVertical.since > DEMO_RIDE_MS + 4000) this.dispatch({ type: 'user_next' });
      return;
    }
    if (now - this.demoVertical.since < DEMO_RIDE_MS) return;
    this.demoVertical.done = true;
    const from = altimeter.belief.elevationOf(step.levelId);
    const to = altimeter.belief.elevationOf(step.toLevelId);
    if (from == null || to == null) {
      this.dispatch({ type: 'user_next' });
      return;
    }
    const deltaM = to - from;
    if (/stairs/.test(step.maneuver)) {
      for (let i = 0; i < Math.round(Math.abs(deltaM) / RISER_M); i++) altimeter.onStairStep(deltaM > 0 ? 1 : -1);
    } else {
      altimeter.onRide({ deltaM: +(deltaM * 0.97).toFixed(2), durationS: 8, peakAccel: 0.6 });
    }
  }

  private startLive() {
    if (!this.stopSensors) {
      this.stopSensors = startSensors({
        onStep: () => this.onStep(),
        onChange: (s) => this.onSensor(s),
      });
    }
    this.stopAltimeter ??= altimeter.subscribe((s) => this.onFloor(s));
    if (this.ticker == null) {
      this.lastTickAt = performance.now();
      this.ticker = window.setInterval(() => this.tick(), TICK_MS);
    }
    this.beacon.setEnabled(this.beaconWanted);
    this.beacon.start();
    if (this.visionOn()) {
      this.ensureVision();
      holdCamera(true);
      // Warm the camera so the first check doesn't pay the startup cost. Denied → vision just fails quietly.
      startCamera().catch(() => undefined);
    }
  }

  private onSensor(s: SensorSnapshot) {
    this.sensor = s;
    const h = s.headingDeg;
    const prev = this.snap;
    const headingMoved = h == null || prev.headingDeg == null ? h !== prev.headingDeg : Math.abs(((h - prev.headingDeg + 540) % 360) - 180) >= 2;
    if (headingMoved || s.headingReliable !== prev.compassReliable || s.moving !== prev.moving) {
      this.set({ headingDeg: h == null ? null : Math.round(h), compassReliable: s.headingReliable, moving: s.moving });
    }
  }

  private currentDelta(): number | null {
    return headingDelta(targetOf(this.snap.tracker)?.bearingDeg, this.sensor?.headingDeg ?? null);
  }

  private tick() {
    const now = performance.now();
    const dtS = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    const demo = Boolean(this.options.simulateWalk);
    const moving = demo || (this.sensor?.moving ?? false);
    this.dispatch({ type: 'tick', dtS, moving });

    const t = this.snap.tracker;
    const active = t.phase === 'navigating' || t.phase === 'approaching';
    if (demo) {
      // The presenter stands still: no compass cues, no camera hunting; floors change through the altimeter.
      this.beacon.setDelta(null);
      if (active) this.simulateFloorChange(now);
      return;
    }
    const reliable = this.sensor?.headingReliable ?? false;
    const delta = active && reliable ? this.currentDelta() : null;

    // An unreliable compass would steer people wrong; go quiet and let vision / the step text lead.
    this.beacon.setDelta(delta);
    const phrase = this.headingSpeech.update(delta, now);
    if (phrase) this.speak(phrase, 'heading');

    if (!active) return;
    if (delta != null && Math.abs(delta) > OFF_HEADING_DEG && moving) {
      this.offHeadingSince ??= now;
      if (now - this.offHeadingSince > OFF_HEADING_HOLD_MS && now - this.lastOffHeadingVisionAt > OFF_HEADING_COOLDOWN_MS) {
        if (this.requestVision('off_heading')) this.lastOffHeadingVisionAt = now;
      }
    } else {
      this.offHeadingSince = null;
    }
    const { currentStep, remainingStepM } = trackerProgress(t);
    if (moving && currentStep && !isVerticalStep(currentStep) && remainingStepM < PERIODIC_WITHIN_M && now - this.lastPeriodicAt >= PERIODIC_MS) {
      if (this.requestVision('periodic')) this.lastPeriodicAt = now;
    }
  }

  /* ───── Vision ───── */

  private visionOn() {
    return this.options.visionEnabled ?? true;
  }

  private ensureVision(): VisionController {
    this.vision ??= new VisionController({
      capture: (px) => captureFrame(px, 0.6),
      send: (req: VisionRequest) => postJson<VisionResponse>(API.vision, req, VISION_CLIENT_TIMEOUT_MS),
      context: (trigger, question) => this.visionContext(trigger, question),
      onBusy: (busy) => this.set({ visionBusy: busy }),
      onResult: (res, req) => this.onVision(res, req),
    });
    return this.vision;
  }

  /** Returns true if a request was started or queued. */
  private requestVision(trigger: VisionTrigger, question?: string): boolean {
    if (!this.visionOn()) return false;
    // Automatic triggers stop once the server said AI is off; explicit questions still get an answer.
    if (this.visionUnavailable && trigger !== 'user_query') return false;
    return this.ensureVision().trigger(trigger, question);
  }

  private visionContext(trigger: VisionTrigger, question?: string): VisionRequestBody | null {
    const t = this.snap.tracker;
    if (trigger !== 'user_query' && t.phase !== 'navigating' && t.phase !== 'approaching') return null;
    const { currentStep, nextStep } = trackerProgress(t);
    return {
      trigger,
      routeId: t.route?.routeId,
      stepIndex: t.stepIndex,
      step: currentStep
        ? {
            text: currentStep.text,
            maneuver: currentStep.maneuver,
            levelId: currentStep.levelId,
            toLevelId: currentStep.toLevelId,
            expectedLandmarks: currentStep.expectedLandmarks,
            distanceM: currentStep.distanceM,
          }
        : undefined,
      nextStepText: nextStep?.text,
      headingDeltaDeg: this.currentDelta(),
      needs: this.profile.needs,
      userQuestion: question,
      language: this.profile.language,
    };
  }

  private onVision(res: VisionResponse, req: VisionRequestBody) {
    if (!res.ok) {
      if (res.reason === 'disabled') this.visionUnavailable = true;
      if (req.trigger === 'user_query') this.speak(`The camera check is not available, so I am going by your steps. ${this.routeHint()}`, 'vision');
      return;
    }
    const { ok: _ok, ...result } = res;
    this.set({ lastVision: result });
    const decision = decideVision(result, { route: this.snap.tracker.route, lastUtterance: this.lastVisionUtterance, trigger: req.trigger });
    const before = this.snap.tracker;
    this.dispatch({ type: 'vision', advance: decision.advance, offRouteRoom: decision.offRouteRoom, routeId: req.routeId, stepIndex: req.stepIndex });
    const moved = this.snap.tracker.stepIndex !== before.stepIndex || this.snap.tracker.phase !== before.phase;
    // The new instruction already covers it; don't talk over it with the camera's sentence.
    if (moved) return;
    if (decision.speak) {
      this.lastVisionUtterance = decision.speak;
      this.speak(decision.speak, 'vision', req.trigger !== 'user_query');
    } else if (req.trigger === 'user_query') {
      // No confident answer: say what could be read, otherwise fall back on the route, never on "try again".
      this.speak(result.detectedRoomNames.length
        ? `I can read ${result.detectedRoomNames.join(', ')}.`
        : `I cannot read a sign from here, so I am going by your steps. ${this.routeHint()}`, 'vision');
    }
  }

  /* ───── Reroute ───── */

  private async reroute(roomName: string) {
    const t = this.snap.tracker;
    const route = t.route;
    if (!route) return;
    const step = route.steps[t.stepIndex];
    const levelHint = step?.levelId;
    // Where the tracker thinks the user is: the sign's number is checked against this spot, its letter against
    // this floor (an "E 33" read on floor F is F 33), and a big jump needs a second witness.
    const here = step ? pointAlong(step.polyline, t.progressM) : null;
    try {
      const near = here && levelHint ? { lat: here.lat, lon: here.lon, levelId: levelHint } : undefined;
      const loc = await postJson<LocalizeResult>(API.localize, { roomText: roomName, levelHint, near }, 5000);
      if (!loc.ok) throw new Error(`I read ${roomName} but could not find it on the map.`);
      // One camera frame can misread a digit; only reroute from a sign matched as a room with good confidence.
      if (loc.confidence < REROUTE_MIN_CONFIDENCE || (loc.place && loc.place.kind !== 'room')) {
        throw new Error(`I may have read ${roomName}, but I am not sure. Say I am at, then the room, to reroute.`);
      }
      if (loc.place && here && levelHint) {
        const levels = [step.levelId, step.toLevelId, route.steps[t.stepIndex + 1]?.levelId].filter((l): l is string => Boolean(l));
        const gate = positionGate.decide({ lat: loc.place.lat, lon: loc.place.lon, levelId: loc.place.levelId, label: loc.place.name, placeId: loc.place.id, nodeId: loc.nodeId }, 'sign', { ...here, levelId: altimeter.confidentLevel() ?? levelHint, confidence: 'medium' }, levels, Date.now(), altimeter.confidentLevel());
        // One reading may not move the user far or to another floor: ask, and keep the current route meanwhile.
        if (gate.action === 'hold') throw new Error(gate.question);
      }
      const to = route.to.id.startsWith('node:') ? { type: 'node' as const, nodeId: route.to.nodeId } : { type: 'place' as const, placeId: route.to.id };
      const next = await postJson<RouteResult>(API.route, { from: { type: 'node', nodeId: loc.nodeId }, to, profile: this.profile }, 8000);
      if (!next.ok) throw new Error(next.message || 'No new route was found.');
      if (this.snap.tracker.phase !== 'rerouting') return; // stopped or moved on meanwhile
      this.ownRouteId = next.routeId;
      this.set({ error: null });
      this.dispatch({ type: 'reroute', route: next });
      this.options.onRouteChange?.(next);
    } catch (err) {
      const message = err instanceof Error && err.name !== 'AbortError' ? err.message : 'Rerouting timed out.';
      this.set({ error: message });
      this.dispatch({ type: 'reroute_failed', message });
    }
  }
}

/** The next node of the path from where the tracker thinks the user is: what to face right now. */
function targetOf(t: TrackerState): { bearingDeg: number; distM: number } | null {
  const step = trackerProgress(t).currentStep;
  if (!step || isVerticalStep(step) || (t.phase !== 'navigating' && t.phase !== 'approaching')) return null;
  return nextNodeAhead(step.polyline, t.progressM) ?? (step.bearingDeg == null ? null : { bearingDeg: step.bearingDeg, distM: 0 });
}

export const useGuidance: UseGuidance = (route, profile, options): GuidanceState & GuidanceActions => {
  const [engine] = useState(() => new GuidanceEngine());
  engine.setInputs(route, profile, options);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  useEffect(() => engine.routeChanged(route), [engine, route?.routeId]);
  useEffect(() => engine.setBeaconWanted(options.beaconEnabled ?? true), [engine, options.beaconEnabled]);
  useEffect(() => () => engine.dispose(), [engine]);

  const t = snap.tracker;
  const { currentStep, nextStep, remainingStepM, remainingTotalM } = trackerProgress(t);
  const target = targetOf(t);
  const headingDeltaDeg = headingDelta(target?.bearingDeg, snap.headingDeg);

  return {
    phase: t.phase,
    // Before start, mirror the prop so the preview/navigate screen can render it.
    route: t.route ?? route,
    stepIndex: t.stepIndex,
    currentStep: currentStep ?? route?.steps[0] ?? null,
    nextStep: t.route ? nextStep : (route?.steps[1] ?? null),
    progressM: t.progressM,
    remainingStepM: t.route ? remainingStepM : (route?.steps[0]?.distanceM ?? 0),
    remainingTotalM: t.route ? remainingTotalM : (route?.totalDistanceM ?? 0),
    headingDeg: snap.headingDeg,
    targetBearingDeg: target ? Math.round(target.bearingDeg) : null,
    nextNodeM: target ? Math.round(target.distM) : null,
    headingDeltaDeg: headingDeltaDeg == null ? null : Math.round(headingDeltaDeg),
    compassReliable: snap.compassReliable,
    moving: snap.moving,
    visionBusy: snap.visionBusy,
    lastVision: snap.lastVision,
    lastAnnouncement: snap.lastAnnouncement,
    error: snap.error,
    start: engine.start,
    stop: engine.stop,
    next: engine.next,
    back: engine.back,
    repeat: engine.repeat,
    whereAmI: engine.whereAmI,
    whatsAhead: engine.whatsAhead,
    checkStep: engine.checkStep,
    locate: engine.locate,
    setBeaconEnabled: engine.setBeaconEnabled,
  };
};
