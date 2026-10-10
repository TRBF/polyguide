import { useEffect, useState } from 'react';
import type {
  GuidanceActions,
  GuidanceOptions,
  GuidanceState,
  Profile,
  RouteResult,
  RouteStep,
  TrackerPhase,
  UseGuidance,
  VisionResult,
} from '@polyguide/shared';

type Route = Extract<RouteResult, { ok: true }>;

interface MockSnapshot {
  phase: TrackerPhase;
  stepIndex: number;
  progressM: number;
  headingDeg: number | null;
  compassReliable: boolean;
  moving: boolean;
  visionBusy: boolean;
  lastVision: VisionResult | null;
  lastAnnouncement: string;
  error: string | null;
}

const emptyState: MockSnapshot = {
  phase: 'idle',
  stepIndex: 0,
  progressM: 0,
  headingDeg: null,
  compassReliable: false,
  moving: false,
  visionBusy: false,
  lastVision: null,
  lastAnnouncement: '',
  error: null,
};

/** C-owned seam implementation; Track B can replace this import once its hook lands. */
export const useGuidanceMock: UseGuidance = (
  route: Route | null,
  profile: Profile,
  options: GuidanceOptions,
): GuidanceState & GuidanceActions => {
  void profile;
  const [state, setState] = useState<MockSnapshot>(emptyState);
  const routeId = route?.routeId ?? null;

  useEffect(() => {
    setState({ ...emptyState });
  }, [routeId]);

  const steps = route?.steps ?? [];
  const currentStep: RouteStep | null = steps[state.stepIndex] ?? null;
  const nextStep: RouteStep | null = steps[state.stepIndex + 1] ?? null;
  const remainingStepM = currentStep ? Math.max(0, currentStep.distanceM - state.progressM) : 0;
  const remainingTotalM = Math.max(0, (route?.totalDistanceM ?? 0) - state.progressM);
  const headingDeltaDeg = currentStep?.bearingDeg === null || currentStep?.bearingDeg === undefined
    ? null
    : currentStep.bearingDeg - (state.headingDeg ?? 0);

  function announce(text: string, priority: 'instruction' | 'vision' | 'heading' | 'info' = 'instruction'): void {
    setState((previous) => ({ ...previous, lastAnnouncement: text }));
    options.onSpeak(text, priority);
  }

  function start(): void {
    if (!route || !route.steps.length) {
      announce('Choose a route before starting navigation.');
      return;
    }
    setState((previous) => ({ ...previous, phase: 'navigating', stepIndex: 0, progressM: 0, error: null }));
    announce(route.steps[0].speech || route.steps[0].text);
  }

  function stop(): void {
    setState((previous) => ({ ...previous, phase: 'idle', progressM: 0 }));
    announce('Navigation stopped.');
  }

  function next(): void {
    if (!steps.length) return;
    const nextIndex = Math.min(state.stepIndex + 1, steps.length - 1);
    if (nextIndex >= steps.length - 1) {
      const arrival = steps[steps.length - 1];
      setState((previous) => ({ ...previous, phase: 'arrived', stepIndex: steps.length - 1, progressM: 0 }));
      announce(arrival?.speech || `You have arrived at ${route?.to.name ?? 'your destination'}.`);
      return;
    }
    const step = steps[nextIndex];
    setState((previous) => ({ ...previous, phase: 'navigating', stepIndex: nextIndex, progressM: 0 }));
    announce(step.speech || step.text);
  }

  function back(): void {
    if (!steps.length) return;
    const previousIndex = Math.max(0, state.stepIndex - 1);
    const step = steps[previousIndex];
    setState((previous) => ({ ...previous, phase: 'navigating', stepIndex: previousIndex, progressM: 0 }));
    announce(step.speech || step.text);
  }

  function repeat(): void {
    announce(currentStep?.speech || currentStep?.text || state.lastAnnouncement || 'There is no instruction to repeat yet.');
  }

  function whereAmI(): void {
    const instruction = currentStep?.text;
    announce(instruction ? `You are on this step: ${instruction}.` : 'Your current location is not confirmed yet.', 'vision');
  }

  function whatsAhead(): void {
    announce(nextStep?.speech || nextStep?.text || `You are heading to ${route?.to.name ?? 'your destination'}.`, 'vision');
  }

  function setBeaconEnabled(on: boolean): void {
    announce(on ? 'Audio beacon enabled.' : 'Audio beacon disabled.', 'info');
  }

  return {
    ...state,
    route,
    currentStep,
    nextStep,
    remainingStepM,
    remainingTotalM,
    headingDeltaDeg,
    start,
    stop,
    next,
    back,
    repeat,
    whereAmI,
    whatsAhead,
    setBeaconEnabled,
  };
};
