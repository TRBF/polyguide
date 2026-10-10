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
const REROUTE_MIN_CONFIDENCE = 0.9;

const floorOf = (levelId: string) => levelId.split('.').at(-1) ?? levelId;
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
      : ` ${speakDist(remainingStepM)} left on this part, ${speakDist(remainingTotalM)} to the destination.`;
    this.speak(where + rest, 'instruction');
    this.requestVision('user_query', 'Where am I? Read any room sign you can see.');
  };

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

  setBeaconEnabled = (on: boolean) => {
    this.setBeaconWanted(on);
    this.speak(on ? 'Audio beacon on.' : 'Audio beacon off.', 'info');
  };

  /** Stop sensors, camera, beacon and timers. Safe to call repeatedly; start() revives everything. */
  stopLive() {
    this.stopSensors?.();
    this.stopSensors = null;
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
    return {
      progressMode: wheel ? 'motion' : 'steps',
      stepLengthM: this.profile.stepLengthM ?? 0.7,
      speedMps: this.profile.speedMps ?? (wheel ? 1.0 : 1.3),
    };
  }

  private speak(text: string, priority: SpeechPriority) {
    if (!text) return;
    this.set({ lastAnnouncement: text });
    this.options.onSpeak(text, priority);
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

  private startLive() {
    if (!this.stopSensors) {
      this.stopSensors = startSensors({
        onStep: () => this.dispatch({ type: 'step' }),
        onChange: (s) => this.onSensor(s),
      });
    }
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
    const step = trackerProgress(this.snap.tracker).currentStep;
    if (!step || isVerticalStep(step)) return null;
    return headingDelta(step.bearingDeg, this.sensor?.headingDeg ?? null);
  }

  private tick() {
    const now = performance.now();
    const dtS = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    const moving = this.sensor?.moving ?? false;
    this.dispatch({ type: 'tick', dtS, moving });

    const t = this.snap.tracker;
    const active = t.phase === 'navigating' || t.phase === 'approaching';
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
      if (req.trigger === 'user_query') this.speak('The camera check is not available right now.', 'vision');
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
      this.speak(decision.speak, 'vision');
    } else if (req.trigger === 'user_query') {
      this.speak(result.detectedRoomNames.length ? `I can read ${result.detectedRoomNames.join(', ')}.` : 'I cannot make out anything useful in the camera view.', 'vision');
    }
  }

  /* ───── Reroute ───── */

  private async reroute(roomName: string) {
    const t = this.snap.tracker;
    const route = t.route;
    if (!route) return;
    const levelHint = route.steps[t.stepIndex]?.levelId;
    try {
      const loc = await postJson<LocalizeResult>(API.localize, { roomText: roomName, levelHint }, 5000);
      if (!loc.ok) throw new Error(`I read ${roomName} but could not find it on the map.`);
      // One camera frame can misread a digit; only reroute from a sign matched as a room with high confidence.
      if (loc.confidence < REROUTE_MIN_CONFIDENCE || (loc.place && loc.place.kind !== 'room')) {
        throw new Error(`I may have read ${roomName}, but I am not sure. Say I am at, then the room, to reroute.`);
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

export const useGuidance: UseGuidance = (route, profile, options): GuidanceState & GuidanceActions => {
  const [engine] = useState(() => new GuidanceEngine());
  engine.setInputs(route, profile, options);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  useEffect(() => engine.routeChanged(route), [engine, route?.routeId]);
  useEffect(() => engine.setBeaconWanted(options.beaconEnabled ?? true), [engine, options.beaconEnabled]);
  useEffect(() => () => engine.dispose(), [engine]);

  const t = snap.tracker;
  const { currentStep, nextStep, remainingStepM, remainingTotalM } = trackerProgress(t);
  const headingDeltaDeg =
    currentStep && !isVerticalStep(currentStep) && t.phase !== 'idle' && t.phase !== 'arrived' ? headingDelta(currentStep.bearingDeg, snap.headingDeg) : null;

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
    setBeaconEnabled: engine.setBeaconEnabled,
  };
};
