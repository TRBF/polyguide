import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  API,
  type AgentResponse,
  type Intent,
  type IntentRequest,
  type Need,
  type Place,
  type PositionInfo,
  type ResolveTripResponse,
  type RouteResult,
  type VisionTrigger,
  useTypeFromText,
  useTypeLabel,
} from '@polyguide/shared';
import { api } from './api';
import { captureRoomSignFrame, releaseScreenWakeLock, requestAppPermissions, requestScreenWakeLock } from './camera';
import { CameraBackdrop, RouteSheet } from './views';
import { VoiceBar, type VoiceBarHandle } from './VoiceBar';
import { configureSpeech, isSpeaking, onSpeakingChange, speak, stopSpeech } from './voice/tts';
import { VoicePicker } from './voice/VoicePicker';
import { answerForScreen, parseAppCommand, parseCommand } from './voice/commands';
import { clearRecents, hasSavedPreferences, loadPreferences, recentPlaces, rememberPlace, savePreferences, type Preferences } from './storage';
import { useGuidance } from './guidance';
import { captureFrame } from './guidance/camera';
import { buzz } from './guidance/heading';
import { isVerticalStep } from './guidance/tracker';
import { requestSensorPermissions } from './sensorPermissions';
import { RealtimeAgent, type AgentStatus, type ToolResult } from './realtime/RealtimeAgent';
import { RealtimeDock } from './realtime/RealtimeDock';
import { LiveSensors } from './realtime/liveSensors';
import { bearingAt, compassName, estimatePosition, formatLiveState, type Fix } from './realtime/liveState';
import './styles.css';

type Route = Extract<RouteResult, { ok: true }>;
type Screen = 'needs' | 'permissions' | 'where' | 'destination' | 'preview' | 'navigate' | 'arrived' | 'settings';
const safetyNotice = 'This app supplements your cane or guide dog. It does not detect obstacles.';
const entrySpeech: Record<Screen, string> = {
  needs: `Welcome to PolyGuide. ${safetyNotice} I am listening. If you are blind, say: I am blind. Then say next. Say help for options.`,
  permissions: 'Device permissions. Say enable to allow camera, motion and microphone, or say next to skip.',
  where: 'Where are you? Say I am at, and a room, for example: I am at H G E 41. Or say scan sign. Say help for options.',
  destination: 'Where to? Say take me to, and a room, for example: take me to H G F 30, or the nearest toilet. Say help for options.',
  preview: 'Say start to begin navigation, repeat to hear the route again, or back to choose another destination.',
  navigate: 'Navigation started. Say next, back, repeat, where am I, what is ahead, stop, or help.',
  arrived: 'You have arrived. Say new destination, or take me to another room.',
  settings: 'Settings. Adjust speech, voice mode, beacon and step length. Say back to return.',
};
/** What a voice-only user can say on each screen ("help"). */
const screenHelp: Record<Screen, string> = {
  needs: 'Say I am blind, I use a wheelchair, turn on low vision, or turn on avoid stairs. Say turn off and the same name to undo. Say next to continue.',
  permissions: 'Say enable to allow camera, motion and microphone. Say next to continue without them.',
  where: 'Say I am at, and a room, for example: I am at H G E 41. Say scan sign to read a room sign with the camera, or use GPS outdoors. If I list options, say a number.',
  destination: 'Say take me to, and a room or place, for example: take me to H G F 30, or take me to the nearest toilet. If I list options, say a number.',
  preview: 'Say start to begin, repeat to hear the route again, or back to choose another destination.',
  navigate: 'Say next when you have done a step, back for the previous step, repeat, where am I, what is ahead, or stop. If an elevator is not working, say: the elevator is not working.',
  arrived: 'Say new destination, or take me to, and a room.',
  settings: 'Say faster, slower, turn on or turn off audio beacon, or back.',
};
const voiceOnlyHint = 'You can also say settings, slower, start over, or change my needs at any time. In an emergency, say emergency.';
/** The one question the trip screen asks, in the user's own words back. */
const ASK_TRIP = 'Where are you, and where do you want to go? For example: I am in F 7, take me to F 30.';
const WELCOME = `Welcome to PolyGuide. ${safetyNotice} ${ASK_TRIP} If you are blind or use a wheelchair, tell me.`;
const LOOK_HINT = 'If you do not know where you are, hold the phone up in front of you and I will look around.';

/** "79 metres, about 2 minutes. No stairs. Uses 1 elevator." */
function shortSummary(route: Route): string {
  const minutes = Math.max(1, Math.round(route.totalDurationS / 60));
  const unverified = route.warnings.some((w) => w.includes('routing data')) ? ' One elevator is not confirmed by ETH; check it works.' : '';
  return `${Math.round(route.totalDistanceM)} metres, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. ${route.profileSummary.join('. ')}.${unverified}`;
}

function routeSummary(route: Route): string {
  const minutes = Math.max(1, Math.round(route.totalDurationS / 60));
  return [`Route to ${route.to.kind === 'entrance' && route.to.label ? route.to.label : route.to.name}: ${Math.round(route.totalDistanceM)} metres, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, ...route.profileSummary.map((s) => `${s}.`), ...route.warnings].join(' ');
}

/** "I am blind", "wheelchair", … as a need, for the first screen. */
function spokenNeed(command: string): Need | 'avoidStairs' | null {
  const text = command.replace(/^(?:i am|i'm|i use|i need)\s+(?:a\s+)?/, '');
  if (/^(blind|visually impaired)$/.test(text)) return 'blind';
  if (/^(wheelchair|wheelchair user|in a wheelchair)$/.test(text)) return 'wheelchair';
  if (/^(low vision|partially sighted)$/.test(text)) return 'lowVision';
  if (/^(avoid stairs|no stairs)$/.test(text)) return 'avoidStairs';
  return null;
}

/** "wheelchair, avoid stairs" for welcome-back and settings. */
function describeNeeds(preferences: Preferences): string {
  const names: Record<string, string> = { wheelchair: 'wheelchair', blind: 'blind', lowVision: 'low vision', lowStamina: 'low stamina', avoidCrowds: 'avoid crowds' };
  const parts = preferences.profile.needs.map((need) => names[need] ?? need);
  if (preferences.profile.avoidStairs) parts.push('avoid stairs');
  return parts.join(', ');
}

function placeLabel(place: Place): string {
  // Entrances: the English label leads; the German ETH name follows for matching the signs.
  if (place.kind === 'entrance' && place.label) return `${place.label} — ${place.name}`;
  return place.label ? `${place.name} — ${place.label}` : place.name;
}

/** Name to speak or show in a sentence: English for entrances, the room code otherwise. */
function displayName(place: Place): string {
  return place.kind === 'entrance' && place.label ? place.label : place.name;
}

const compact = (value: string) => value.toUpperCase().replace(/[\s.\-_,]+/g, '');

/** "hg f 30" / "F30" / "Audimax" name this place exactly (not HG F 30.1). */
function sameName(place: Place, query: string): boolean {
  // "the main entrance" names the same place as "main entrance".
  const q = compact(query.trim().replace(/^the\s+/i, ''));
  if (!q) return false;
  return [place.name, place.label ?? '', ...place.aliases].some((name) => {
    const n = compact(name);
    return n === q || (n.startsWith('HG') && n.slice(2) === q);
  });
}

/** For a spoken room code ("k30"), only rooms whose code starts with it (HG K 30.1, HG K 30.5), not fuzzy look-alikes. */
function narrowToCode(places: Place[], query: string): Place[] {
  const q = compact(query);
  if (!/\d/.test(q)) return places;
  const byCode = places.filter((place) => [place.name, ...place.aliases].some((name) => {
    const n = compact(name);
    return n.startsWith(q) || n.startsWith(`HG${q}`);
  }));
  return byCode.length ? byCode : places;
}

/** A turn arrow for when no compass heading is available (the arrow then shows the maneuver, not the bearing). */
function maneuverGlyph(maneuver: string | undefined): string {
  switch (maneuver) {
    case 'left': case 'sharp_left': return '←';
    case 'right': case 'sharp_right': return '→';
    case 'slight_left': return '↖';
    case 'slight_right': return '↗';
    case 'u_turn': return '↶';
    case 'take_elevator': case 'take_stairs_up': case 'take_stairs_down': case 'take_ramp_up': case 'take_ramp_down': case 'take_escalator': return '↕';
    case 'arrive': return '●';
    default: return '↑';
  }
}

function listPlaceNames(places: Place[]): string {
  return places.map((place, index) => `${index + 1}, ${place.kind === 'entrance' && place.label ? place.label : place.label ? `${place.name}, ${place.label}` : place.name}`).join('; ');
}

export function App() {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [started, setStarted] = useState(false);
  const [screen, setScreen] = useState<Screen>('where');
  const [screenBeforeSettings, setScreenBeforeSettings] = useState<Screen>('where');
  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [originMatches, setOriginMatches] = useState<Place[]>([]);
  const [destinationMatches, setDestinationMatches] = useState<Place[]>([]);
  const [message, setMessage] = useState('');
  const [cameraMessage, setCameraMessage] = useState('');
  const [cameraFramePreview, setCameraFramePreview] = useState('');
  const [permissionMessage, setPermissionMessage] = useState('');
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraGranted, setCameraGranted] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState('');
  const [startAfterRoute, setStartAfterRoute] = useState(false);
  const [guidanceVision, setGuidanceVision] = useState('');
  const [liveGuidanceAnnouncement, setLiveGuidanceAnnouncement] = useState('');
  const guidanceAnnouncementTimer = useRef<number | null>(null);
  const voiceBarRef = useRef<VoiceBarHandle>(null);
  /** Returning users (saved needs on this device) skip straight to "Where are you?". */
  const [returning] = useState(() => hasSavedPreferences());
  /** Elevators the user reported as out of service this session; every new route avoids them. */
  const [avoidElevators, setAvoidElevators] = useState<string[]>([]);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  /** Two misunderstandings in a row: offer help instead of repeating "I did not understand". */
  const misunderstood = useRef(0);
  /** What the user last said or typed, shown back so they can see what was understood. */
  const [heard, setHeard] = useState('');
  /** A trip the agent understood and is asking about ("From F 7 to F 30. Is that right?"). */
  const [pending, setPending] = useState<{ from?: Place; to?: Place } | null>(null);
  /** Places the agent read out as numbered options. */
  const [agentOptions, setAgentOptions] = useState<{ places: Place[]; for: 'from' | 'to' } | null>(null);
  const [thinking, setThinking] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Inline edit of From/To by touch. */
  const [editing, setEditing] = useState<'from' | 'to' | null>(null);
  const [editQuery, setEditQuery] = useState('');
  /** Touch users get push-to-talk once they touch the screen; until then (and always in voice-first) the mic listens. */
  const [touched, setTouched] = useState(false);
  const lastVisionStep = useRef('');
  const hapticsRef = useRef(preferences.settings.haptics);
  hapticsRef.current = preferences.settings.haptics;
  /** Where the user really is, from a sign, their word, or the end of a route. Drives the agent's live state. */
  const [fix, setFix] = useState<Fix | null>(null);
  /** The realtime voice agent (speech to speech); null = the older recognizer + /api/agent pipeline. */
  const rtRef = useRef<RealtimeAgent | null>(null);
  const [rtStatus, setRtStatus] = useState<AgentStatus>('off');
  const [rtMuted, setRtMuted] = useState(false);
  const [sensors] = useState(() => new LiveSensors());
  /** While a tool runs, announcements go back to the model (it says them) instead of being spoken over it. */
  const toolSink = useRef<string[] | null>(null);
  const positionCache = useRef<{ key: string; info: PositionInfo } | null>(null);
  const rtActive = rtStatus !== 'off' && rtStatus !== 'error';
  const rtConnecting = useRef(false);
  const rtFailedAt = useRef(0);

  const profile = useMemo(() => ({
    ...preferences.profile,
    needs: [...preferences.profile.needs],
    stepLengthM: preferences.settings.stepLengthM,
    ...(avoidElevators.length ? { avoidElevatorAt: avoidElevators } : {}),
  }), [preferences, avoidElevators]);

  /** One voice: the realtime agent reads app announcements when it is connected, the browser voice otherwise. */
  const say = useCallback((text: string, priority: 'instruction' | 'vision' | 'heading' | 'info') => {
    if (toolSink.current) toolSink.current.push(text);
    else if (rtRef.current?.connected) rtRef.current.announce(text);
    else speak(text, priority);
  }, []);

  const announce = useCallback((text: string, priority: 'instruction' | 'vision' | 'heading' | 'info' = 'info') => {
    setMessage(text);
    say(text, priority);
  }, [say]);

  const onGuidanceSpeak = useCallback((text: string, priority: 'instruction' | 'vision' | 'heading' | 'info') => {
    setLiveGuidanceAnnouncement('');
    if (guidanceAnnouncementTimer.current !== null) window.clearTimeout(guidanceAnnouncementTimer.current);
    guidanceAnnouncementTimer.current = window.setTimeout(() => setLiveGuidanceAnnouncement(text), 60);
    say(text, priority);
    // Deaf and hard-of-hearing users feel each new instruction (Android; iOS has no web vibration).
    if (priority === 'instruction' && hapticsRef.current) buzz([70, 50, 70]);
  }, []);

  const onGuidanceRouteChange = useCallback((nextRoute: Route) => setRoute(nextRoute), []);
  const guidance = useGuidance(route, profile, {
    onSpeak: onGuidanceSpeak,
    onRouteChange: onGuidanceRouteChange,
    beaconEnabled: preferences.settings.beaconEnabled,
    visionEnabled: cameraGranted,
  });

  useEffect(() => {
    savePreferences(preferences);
    configureSpeech({ enabled: preferences.settings.speakWithAppVoice, rate: preferences.settings.speechRate, language: preferences.profile.language === 'de' ? 'de' : 'en', voiceName: preferences.settings.voiceName });
  }, [preferences]);


  // Browser/Android Back steps through the app's screens instead of leaving it mid-route.
  const moveBackRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (screen !== 'needs') window.history.pushState({ screen }, '');
  }, [screen]);
  useEffect(() => {
    const onPop = () => moveBackRef.current();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** The one tap a blind user makes: browsers allow speech, mic and iOS motion only after a gesture. */
  function beginApp(): void {
    // One tap does everything a browser only allows inside a gesture: mic, motion (iOS), camera, speech.
    void requestSensorPermissions().catch(() => undefined).then(() => sensors.start());
    setStarted(true);
    setScreen('where');
    const realtime = preferences.settings.realtimeVoice;
    if (!realtime) voiceBarRef.current?.startContinuous();
    void enableDevicePermissions(true);
    const needs = describeNeeds(preferences);
    const text = returning
      ? `Welcome back${needs ? `. Using your needs: ${needs}` : ''}. ${ASK_TRIP}`
      : WELCOME;
    setMessage(returning ? text : ASK_TRIP);
    const greeting = returning ? `${text} ${safetyNotice}` : text;
    if (!realtime) {
      speak(greeting, 'info');
      return;
    }
    // Same tap: the mic prompt and audio playback need the gesture. The greeting waits for the voice.
    void connectRealtime().then((ok) => {
      if (ok) rtRef.current?.announce(`${greeting} ${LOOK_HINT}`);
      else speak(greeting, 'info');
    });
  }

  /** Opens the realtime voice; on failure the browser recognizer and /api/agent take over. */
  async function connectRealtime(): Promise<boolean> {
    if (rtConnecting.current) return false;
    rtConnecting.current = true;
    rtRef.current?.close();
    const agent = new RealtimeAgent({
      language: profile.language === 'de' ? 'de' : 'en',
      liveState: () => liveStateRef.current(),
      runTool: (name, args) => runToolRef.current(name, args),
      onStatus: (status) => {
        setRtStatus(status);
        setThinking(status === 'thinking');
      },
      onUserTranscript: (text) => setHeard(text),
      onAssistantTranscript: (text) => setMessage(text),
      onError: (error) => {
        rtRef.current = null;
        rtFailedAt.current = Date.now();
        voiceBarRef.current?.startContinuous();
        announce(`${error} Switching to the basic voice. Tap the screen to try the conversational voice again.`);
      },
    });
    rtRef.current = agent;
    try {
      await agent.connect();
      agent.setMuted(rtMuted);
      return true;
    } catch (error) {
      if (rtRef.current === agent) rtRef.current = null;
      rtFailedAt.current = Date.now();
      console.warn('realtime voice unavailable', error);
      setRtStatus('error');
      voiceBarRef.current?.startContinuous();
      return false;
    } finally {
      rtConnecting.current = false;
    }
  }

  // The conversational voice runs whenever the app is started and it is switched on, from trip planning on,
  // not only when it was opened by the Start tap (a reload, a hot update, or turning the setting on later).
  useEffect(() => {
    if (started && preferences.settings.realtimeVoice && rtStatus === 'off' && !rtRef.current) void connectRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, preferences.settings.realtimeVoice, rtStatus]);

  /** After a failure, the next tap tries again (a tap also lets phones start the mic and audio). */
  function retryRealtimeOnTap(): void {
    if (!started || !preferences.settings.realtimeVoice || rtRef.current || rtConnecting.current) return;
    if (Date.now() - rtFailedAt.current < 4000) return;
    void connectRealtime();
  }

  useEffect(() => () => {
    rtRef.current?.close();
    sensors.stop();
  }, [sensors]);

  // Hands-free listening: always on the first screen (a blind user can't tap "Blind" first), and on every
  // screen in voice-first mode. Touch users fall back to push-to-talk once they move on.
  // The realtime voice listens on its own; the recognizer must not hold the mic at the same time.
  useEffect(() => {
    if (!started) return;
    if (rtActive) voiceBarRef.current?.stopContinuous();
    else if (preferences.settings.voiceFirst || !touched) voiceBarRef.current?.startContinuous();
    else if (screen !== 'navigate') voiceBarRef.current?.stopContinuous();
  }, [started, preferences.settings.voiceFirst, screen, touched, rtActive]);

  useEffect(() => {
    if (!(startAfterRoute && screen === 'navigate' && route)) return;
    const go = () => {
      guidance.start();
      setStartAfterRoute(false);
    };
    if (!isSpeaking()) {
      go();
      return;
    }
    const off = onSpeakingChange((speaking) => {
      if (speaking) return;
      off();
      go();
    });
    return off;
  }, [guidance.start, route?.routeId, screen, startAfterRoute]);

  // The camera checks every new step automatically (and whenever the user asks).
  useEffect(() => {
    if (screen !== 'navigate' || !cameraGranted || !route || guidance.phase === 'idle') return;
    const key = `${route.routeId}:${guidance.stepIndex}`;
    if (lastVisionStep.current === key) return;
    lastVisionStep.current = key;
    const timer = window.setTimeout(() => { void checkCamera('approaching_node', true); }, 1200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, cameraGranted, route?.routeId, guidance.stepIndex, guidance.phase]);

  useEffect(() => {
    if (screen === 'navigate' && guidance.phase === 'arrived') {
      releaseScreenWakeLock();
      setScreen('arrived');
      if (route) setFix({ place: route.to, source: 'route', at: Date.now() });
    }
  }, [guidance.phase, screen]);

  // A room sign the guidance camera read is the best position there is (a misread digit is filtered by the
  // confidence check). The agent hears it in the next live state.
  const lastVisionAt = useRef(0);
  useEffect(() => {
    if (guidance.lastVision) lastVisionAt.current = Date.now();
    const sign = guidance.lastVision?.detectedRoomNames[0];
    if (!sign || (guidance.lastVision?.confidence ?? 0) < 0.6) return;
    let cancelled = false;
    void api.localize({ roomText: sign, levelHint: guidance.currentStep?.levelId }).then((loc) => {
      if (!cancelled && loc.ok && loc.place && loc.confidence >= 0.9) setFix({ place: loc.place, source: 'sign', at: Date.now() });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidance.lastVision]);

  useEffect(() => () => {
    stopSpeech();
    releaseScreenWakeLock();
    if (guidanceAnnouncementTimer.current !== null) window.clearTimeout(guidanceAnnouncementTimer.current);
  }, []);

  function updatePreferences(updater: (current: Preferences) => Preferences): void {
    setPreferences(updater);
  }

  function setNeedState(need: Need, enabled: boolean): void {
    updatePreferences((current) => {
      const nextNeeds = enabled
        ? current.profile.needs.includes(need) ? current.profile.needs : [...current.profile.needs, need]
        : current.profile.needs.filter((item) => item !== need);
      return {
        ...current,
        profile: { ...current.profile, needs: nextNeeds },
        settings: { ...current.settings, voiceFirst: need === 'blind' && nextNeeds.includes('blind') ? true : current.settings.voiceFirst },
      };
    });
  }

  function updateNeed(need: Need): void {
    setNeedState(need, !profile.needs.includes(need));
  }

  async function createRoute(target: Place, fromPlace: Place | null = origin): Promise<Route | null> {
    if (!fromPlace) {
      setDestination(target);
      setDestinationQuery(target.name);
      setScreen('where');
      announce(`Destination selected: ${displayName(target)}. First, choose where you are.`);
      return null;
    }
    setBusy(true);
    setMessage('Finding a route…');
    const result = await api.route({
      from: { type: 'place', placeId: fromPlace.id },
      to: { type: 'place', placeId: target.id },
      profile,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      announce(result.message);
      return null;
    }
    setMessage(`Route ready: ${shortSummary(result)}`);
    rememberPlace('destination', target);
    setDestination(target);
    setRoute(result);
    setSelectedLevel(result.levels[0] ?? target.levelId);
    setDestinationMatches([]);
    setScreen('preview');
    return result;
  }

  /** Server errors are announced, never replaced by stale or fake results. */
  async function fetchPlaces(query: string, near?: Place | null): Promise<Place[] | null> {
    try {
      return await api.places(query, undefined, near?.id);
    } catch {
      announce('The PolyGuide server is unavailable. Please try again.');
      return null;
    }
  }

  async function findOrigins(query: string): Promise<Place[]> {
    setBusy(true);
    const found = await fetchPlaces(query);
    setBusy(false);
    if (!found) return [];
    const matches = found;
    const filtered = narrowToCode(matches.filter((place) => place.kind === 'room' || place.kind === 'entrance' || place.kind === 'poi'), query);
    setOriginMatches(filtered.slice(0, 5));
    return filtered.slice(0, 5);
  }

  /** Of several candidate places, the one with the quickest route for this profile (or null). */
  async function quickestOf(candidates: Place[], from: Place): Promise<Place | null> {
    const results = await Promise.all(candidates.map(async (place) => ({
      place,
      result: await api.route({ from: { type: 'place', placeId: from.id }, to: { type: 'place', placeId: place.id }, profile }),
    })));
    const reachable = results.filter((r) => r.result.ok) as { place: Place; result: Route }[];
    reachable.sort((a, b) => a.result.totalDurationS - b.result.totalDurationS);
    return reachable[0]?.place ?? null;
  }

  async function findDestinations(query: string, byVoice = false): Promise<Place[]> {
    // "nearest accessible toilet" → search "accessible toilet", then pick the quickest reachable one.
    const nearest = query.trim().match(/^(?:the\s+)?(?:nearest|closest)\s+(.+)$/i);
    let searchText = nearest ? nearest[1] : query;
    // A wheelchair user asking for a toilet means one they can use.
    if (profile.needs.includes('wheelchair') && /\b(toilet|toilets|bathroom|restroom|wc|loo)\b/i.test(searchText) && !/accessible|barrier/i.test(searchText)) {
      searchText = 'accessible toilet';
    }
    // "exit" / "way out" / "entrance": the building's entrances (also exits), nearest first.
    const wantsExit = /^(?:exit|exits|way out|main exit|entrance|entrances|building exit)$/i.test(searchText.trim());
    setBusy(true);
    // A room type ("seminar room") means the nearest one, like "nearest toilet".
    const byType = Boolean(useTypeFromText(searchText));
    let found: Place[] | null;
    if (wantsExit) {
      try {
        found = await api.places('', 'entrance');
      } catch {
        announce('The PolyGuide server is unavailable. Please try again.');
        found = null;
      }
    } else {
      found = await fetchPlaces(searchText, nearest || byType ? origin : null);
    }
    setBusy(false);
    if (!found) return [];
    // Never offer the place the user is already at ("nearest exit" from the main entrance is not the main entrance).
    const filtered = narrowToCode(found.filter((place) => (place.kind === 'room' || place.kind === 'poi' || place.kind === 'entrance') && place.id !== origin?.id && place.nodeId !== origin?.nodeId), searchText);
    const shown = filtered.slice(0, 5);
    setDestinationMatches(shown);
    // A spoken room code that names a room exactly ("HG F 30", "F 30") needs no disambiguation.
    // Only a unique exact name counts: "accessible toilet" names several places, so the nearest wins instead.
    const sameNamed = filtered.filter((place) => sameName(place, searchText));
    const exact = sameNamed.length === 1 ? sameNamed[0] : undefined;
    // Several places with the same name (toilets, elevators) can't be told apart by voice; choose by distance.
    const indistinct = sameNamed.length > 1 || (shown.length > 1 && new Set(shown.map(placeLabel)).size === 1);
    if (filtered.length && origin && !exact && (nearest || byType || indistinct || wantsExit)) {
      setBusy(true);
      const best = await quickestOf(filtered.slice(0, wantsExit ? 14 : 8), origin);
      setBusy(false);
      if (best) {
        await createRoute(best);
        return shown;
      }
      announce(`I found ${searchText}, but none can be reached from ${origin.name} with your route settings.`);
      return shown;
    }
    if (!filtered.length) {
      announce(`I couldn't find ${query}. Try another room number or point of interest.`);
    } else if (byVoice && (shown.length === 1 || exact)) {
      await createRoute(exact ?? shown[0]);
    } else if (byVoice) {
      announce(`I found ${shown.length} matches: ${listPlaceNames(shown)}. Say the number, or choose a result on screen.`);
    }
    return filtered.slice(0, 5);
  }

  async function chooseOrigin(place: Place): Promise<void> {
    rememberPlace('origin', place);
    setOrigin(place);
    setFix({ place, source: 'user', at: Date.now() });
    setOriginQuery(place.name);
    setOriginMatches([]);
    announce(`Starting point set to ${displayName(place)}.`);
    if (destination) await createRoute(destination, place);
    else setScreen('destination');
  }

  async function scanForLocation(): Promise<void> {
    if (!cameraGranted) {
      setScreen('permissions');
      setCameraMessage('Enable camera, motion and microphone before scanning a room sign.');
      announce('Enable camera, motion and microphone before scanning a room sign.');
      return;
    }
    if (screen !== 'navigate') setScreen('where');
    setCameraBusy(true);
    setCameraMessage('Camera is checking for a room sign…');
    try {
      const imageJpegBase64 = await captureRoomSignFrame(1024);
      setCameraFramePreview(`data:image/jpeg;base64,${imageJpegBase64}`);
      const vision = await api.vision({
        imageJpegBase64,
        trigger: 'localize',
        needs: profile.needs,
        language: profile.language,
      });
      if (!vision.ok) throw new Error(vision.message);
      const roomText = vision.detectedRoomNames[0];
      if (!roomText) {
        const seen = vision.readText.length ? ` I could read: ${vision.readText.join(', ')}.` : '';
        throw new Error(`I couldn't read a room name from that image.${seen}`);
      }
      const localized = await api.localize({ roomText });
      if (!localized.ok) throw new Error(localized.message);
      let matchedPlace = localized.place;
      if (!matchedPlace) matchedPlace = (await fetchPlaces(roomText))?.[0];
      if (matchedPlace) {
        setOrigin(matchedPlace);
        setFix({ place: matchedPlace, source: 'sign', at: Date.now() });
        setOriginQuery(matchedPlace.name);
      }
      setOriginMatches([]);
      setCameraMessage(`Room sign read as ${roomText}. Confidence ${Math.round(localized.confidence * 100)} percent.`);
      announce(`I read ${roomText}. Your starting point is ${matchedPlace?.name ?? roomText}.`, 'vision');
      if (screen === 'navigate' && route) await rerouteFromNode(localized.nodeId, roomText);
      else if (destination && matchedPlace) await createRoute(destination, matchedPlace);
      else setScreen('destination');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The room sign could not be checked.';
      setCameraMessage(text);
      announce(text, 'vision');
    } finally {
      setCameraBusy(false);
    }
  }

  async function rerouteFromNode(nodeId: string, roomText: string): Promise<void> {
    if (!route) return;
    setBusy(true);
    const result = await api.route({
      from: { type: 'node', nodeId },
      to: { type: 'place', placeId: route.to.id },
      profile,
    });
    setBusy(false);
    if (!result.ok) {
      announce(`I found ${roomText}, but could not build a new route from there. ${result.message}`);
      return;
    }
    setRoute(result);
    setStartAfterRoute(true);
    setScreen('navigate');
    announce(`Rerouting from ${roomText}.`);
  }

  async function checkCamera(trigger: VisionTrigger = 'user_query', quiet = false): Promise<void> {
    setCameraBusy(true);
    setCameraMessage('Camera is checking…');
    try {
      const imageJpegBase64 = await captureRoomSignFrame(640);
      setCameraFramePreview(`data:image/jpeg;base64,${imageJpegBase64}`);
      const vision = await api.vision({
        imageJpegBase64,
        trigger,
        routeId: route?.routeId,
        stepIndex: guidance.stepIndex,
        step: guidance.currentStep ?? undefined,
        nextStepText: guidance.nextStep?.text,
        headingDeltaDeg: guidance.headingDeltaDeg,
        needs: profile.needs,
        userQuestion: trigger === 'user_query' ? 'Where am I? What is ahead?' : undefined,
        language: profile.language,
      });
      if (!vision.ok) throw new Error(vision.message);
      const summary = vision.utterance && vision.confidence >= 0.6
        ? vision.utterance
        : vision.sceneSummary;
      setGuidanceVision(summary);
      setCameraMessage(`${vision.sceneSummary} Confidence ${Math.round(vision.confidence * 100)} percent.`);
      if (vision.utterance && vision.confidence >= 0.6) {
        setMessage(vision.utterance);
        say(vision.utterance, 'vision');
      }
      if (vision.offRouteSuspected && vision.detectedRoomNames[0]) {
        const sign = vision.detectedRoomNames[0];
        const localized = await api.localize({ roomText: sign });
        if (localized.ok && localized.confidence >= 0.9) await rerouteFromNode(localized.nodeId, sign);
        else if (localized.ok) {
          // A fuzzy match could be a misread sign; ask instead of rerouting from the wrong room.
          announce(`I may have read ${sign}, but I am not sure. Say "I am at ${localized.place?.name ?? sign}" to reroute from there.`, 'vision');
        }
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The camera check did not finish.';
      setCameraMessage(text);
      if (!quiet) announce(text, 'vision');
    } finally {
      setCameraBusy(false);
    }
  }

  async function useOutdoorGps(): Promise<void> {
    if (!navigator.geolocation) {
      announce('Location is unavailable in this browser. Choose a room or scan a sign.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(async (position) => {
      const result = await api.localize({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracyM: position.coords.accuracy,
      });
      setBusy(false);
      if (!result.ok) {
        setMessage(result.message);
        announce(result.message);
        return;
      }
      // An outdoor GPS fix has no room; never guess an entrance. The user picks a room or entrance.
      if (result.place) await chooseOrigin(result.place);
      else announce('GPS found you outdoors. Say or search for the entrance or room you are heading into to set your starting point.');
    }, () => {
      setBusy(false);
      announce('GPS could not find an accurate outdoor location. Choose a room or scan a sign.');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  }

  async function enableDevicePermissions(quiet = false): Promise<void> {
    setPermissionBusy(true);
    setPermissionMessage('Requesting device permissions…');
    const permissions = await requestAppPermissions();
    setPermissionBusy(false);
    setCameraGranted(permissions.includes('camera'));
    const granted = permissions.includes('camera') || permissions.includes('microphone');
    if (granted !== preferences.settings.permissionsGranted) {
      updatePreferences((current) => ({ ...current, settings: { ...current.settings, permissionsGranted: granted } }));
    }
    if (quiet) {
      setPermissionMessage('');
      return;
    }
    const text = permissions.length
      ? `Enabled: ${permissions.join(', ')}. You can change these permissions in your browser settings.`
      : 'No permissions were granted. You can still use touch and typed commands; scanning and sensors may be unavailable.';
    setPermissionMessage(text);
    announce(text, 'info');
  }

  function moveBack(): void {
    if (screen === 'settings') {
      setScreen(screenBeforeSettings);
      return;
    }
    const previous: Partial<Record<Screen, Screen>> = {
      permissions: 'needs',
      where: 'permissions',
      destination: 'where',
      preview: 'destination',
      navigate: 'preview',
      arrived: 'destination',
    };
    if (screen === 'navigate') {
      guidance.stop();
      releaseScreenWakeLock();
    }
    const target = previous[screen];
    if (target) setScreen(target);
  }

  moveBackRef.current = moveBack;

  function openSettings(): void {
    setScreenBeforeSettings(screen);
    setScreen('settings');
  }

  /** Local parsing, used when the voice agent is unavailable (no key, offline, timeout). */
  async function legacyCommand(transcript: string): Promise<void> {
    const normalizedCommand = transcript.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,]+$/g, '');
    const appCommand = parseAppCommand(transcript);
    if (emergencyOpen && (appCommand?.type === 'no' || /^(close|cancel|back|stop|i'm ok|i am ok|i'm okay|i am okay)$/.test(normalizedCommand))) {
      setEmergencyOpen(false);
      announce('Emergency panel closed.');
      return;
    }
    if (appCommand) {
      misunderstood.current = 0;
      await runAppCommand(appCommand.type);
      return;
    }
    if (/^(open )?settings$/.test(normalizedCommand)) {
      openSettings();
      return;
    }
    const need = screen === 'needs' ? spokenNeed(normalizedCommand) : null;
    if (need) {
      if (need === 'avoidStairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: true } }));
      else setNeedState(need, true);
      const name = need === 'avoidStairs' ? 'Avoid stairs' : need === 'lowVision' ? 'Low vision' : need === 'blind' ? 'Blind, with voice-first mode,' : 'Wheelchair';
      announce(`${name} enabled. Add another need, or say next to continue.`);
      return;
    }
    if (screen === 'permissions' && /^(enable|enable (them|all|permissions)|allow|yes|ok|okay|grant permissions)$/.test(normalizedCommand)) {
      await enableDevicePermissions();
      setScreen('where');
      return;
    }
    const toggle = normalizedCommand.match(/^(?:turn on|enable|activate|switch on|turn off|disable|deactivate|switch off)\s+(wheelchair|blind|low vision|avoid stairs|voice-first mode|voice first mode|speak with app voice|app voice|audio beacon|low stamina|avoid crowds)$/);
    if (toggle) {
      const turnOn = /^(turn on|enable|activate|switch on)/.test(normalizedCommand);
      const target = toggle[1];
      if (target === 'wheelchair') setNeedState('wheelchair', turnOn);
      else if (target === 'blind') setNeedState('blind', turnOn);
      else if (target === 'low vision') setNeedState('lowVision', turnOn);
      else if (target === 'avoid stairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: turnOn } }));
      else if (target === 'voice-first mode' || target === 'voice first mode') updatePreferences((current) => ({ ...current, settings: { ...current.settings, voiceFirst: turnOn } }));
      else if (target === 'speak with app voice' || target === 'app voice') updatePreferences((current) => ({ ...current, settings: { ...current.settings, speakWithAppVoice: turnOn } }));
      else if (target === 'audio beacon') {
        updatePreferences((current) => ({ ...current, settings: { ...current.settings, beaconEnabled: turnOn } }));
        guidance.setBeaconEnabled(turnOn);
      } else {
        announce(`${target === 'low stamina' ? 'Low stamina' : 'Avoid crowds'} routing is coming soon.`);
        return;
      }
      announce(`${target} ${turnOn ? 'enabled' : 'disabled'}.`);
      return;
    }
    if (/^(faster|speak faster|speech rate up)$/.test(normalizedCommand)) {
      updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: Math.min(1.5, current.settings.speechRate + 0.1) } }));
      announce('Speech rate increased.');
      return;
    }
    if (/^(slower|speak slower|speech rate down)$/.test(normalizedCommand)) {
      updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: Math.max(0.6, current.settings.speechRate - 0.1) } }));
      announce('Speech rate decreased.');
      return;
    }
    const rateMatch = normalizedCommand.match(/^set speech rate to (\d(?:\.\d)?)$/);
    if (rateMatch) {
      const rate = Number(rateMatch[1]);
      if (rate >= 0.6 && rate <= 1.5) {
        updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: rate } }));
        announce(`Speech rate set to ${rate}.`);
      } else announce('Choose a speech rate between 0.6 and 1.5.');
      return;
    }
    const floorMatch = normalizedCommand.match(/^(?:show|switch to|go to) floor ([a-z])$/);
    if (floorMatch && screen === 'preview' && route) {
      const level = route.levels.find((item) => item.toLowerCase().endsWith(`.${floorMatch[1]}`));
      if (level) {
        setSelectedLevel(level);
        announce(`Showing floor ${floorMatch[1].toUpperCase()}.`);
      } else announce(`Floor ${floorMatch[1].toUpperCase()} is not on this route.`);
      return;
    }

    // Read the reply as an answer to this screen's question ("k30" on "Where are you?" is where the user is).
    const parsed = answerForScreen(screen, transcript, parseCommand(transcript));
    const screenKey: IntentRequest['screen'] = screen === 'where' ? 'start' : screen === 'permissions' ? 'needs' : screen;
    const intent: Intent = parsed
      ?? answerForScreen(screen, transcript, await api.intent({ utterance: transcript, screen: screenKey, language: profile.language }))
      ?? { type: 'unknown', source: 'regex' };
    await runIntent(intent);
  }

  async function runIntent(intent: Intent): Promise<void> {
    if (intent.type !== 'unknown') misunderstood.current = 0;
    switch (intent.type) {
      case 'help':
        announce(`${screenHelp[screen]} ${voiceOnlyHint}`);
        return;
      case 'next':
        if (screen === 'needs') setScreen('permissions');
        else if (screen === 'permissions') setScreen('where');
        else if (screen === 'where') setScreen('destination');
        else if (screen === 'destination') {
          if (destinationMatches.length === 1) await createRoute(destinationMatches[0]);
          else announce('Search for a destination, then choose a result.');
        } else if (screen === 'preview') beginNavigation();
        else if (screen === 'navigate') guidance.next();
        else if (screen === 'arrived') startNewDestination();
        else if (screen === 'settings') moveBack();
        return;
      case 'back':
        if (screen === 'navigate') guidance.back();
        else moveBack();
        return;
      case 'repeat':
        if (screen === 'navigate') guidance.repeat();
        else if (screen === 'preview' && route) announce(`${routeSummary(route)} ${entrySpeech.preview}`);
        else announce(message || entrySpeech[screen]);
        return;
      case 'stop':
        if (screen === 'navigate') {
          guidance.stop();
          releaseScreenWakeLock();
          setScreen('preview');
        } else if (screen === 'settings') moveBack();
        else announce('There is nothing to stop right now.');
        return;
      case 'where_am_i':
        if (screen === 'navigate') {
          if (cameraGranted) {
            guidance.whereAmI();
            void checkCamera('user_query');
          } else if (route) {
            // The engine's own answer is spoken only; mirror it on screen so the HUD shows the same thing.
            const step = route.steps[Math.min(guidance.stepIndex, route.steps.length - 1)];
            setMessage(`Step ${guidance.stepIndex + 1} of ${route.steps.length}, floor ${step.levelId.split('.').at(-1)}, ${Math.round(guidance.remainingTotalM)} m to go.`);
            guidance.whereAmI();
          }
        } else if (screen === 'where') announce(origin ? `Your starting point is ${origin.name}.` : 'Choose or scan a room to set your starting point.');
        else announce(origin ? `You started from ${origin.name}.` : 'Your starting point has not been selected.');
        return;
      case 'whats_ahead':
        if (screen === 'navigate') {
          guidance.whatsAhead();
          if (!cameraGranted) announce('Enable camera access to ask the camera what is ahead.', 'vision');
        } else announce(destination ? `Your destination is ${destination.name}.` : 'Choose a destination first.');
        return;
      case 'navigate_to':
        if (!intent.target) return;
        setDestinationQuery(intent.target);
        setScreen('destination');
        await findDestinations(intent.target, true);
        return;
      case 'set_location':
        if (!intent.target) return;
        if (intent.target === 'use gps') {
          setScreen('where');
          await useOutdoorGps();
          return;
        }
        if (intent.target === 'scan sign') {
          if (cameraGranted) await scanForLocation();
          else {
            setScreen('where');
            announce('Enable camera access before scanning a room sign.');
          }
          return;
        }
        setOriginQuery(intent.target);
        setScreen('where');
        {
          const matches = await findOrigins(intent.target);
          const exact = matches.find((place) => sameName(place, intent.target ?? ''));
          if (matches.length === 1 || exact) await chooseOrigin(exact ?? matches[0]);
          else if (matches.length > 1) announce(`I found ${matches.length} starting points: ${listPlaceNames(matches.slice(0, 3))}. Say a number.`);
          else announce(`I couldn't find ${intent.target}. Try a room number.`);
        }
        return;
      case 'choose_option': {
        const index = (intent.option ?? 0) - 1;
        const places = screen === 'where' ? originMatches : destinationMatches;
        const selected = places[index];
        if (!selected) {
          announce('That option is not available. Say help or choose a result on screen.');
        } else if (screen === 'where') await chooseOrigin(selected);
        else await createRoute(selected);
        return;
      }
      default:
        // Continuous listening hears room chatter; stay quiet instead of nagging while walking.
        if (screen === 'navigate') return;
        misunderstood.current += 1;
        if (misunderstood.current >= 2) {
          misunderstood.current = 0;
          announce(`I still did not understand. ${screenHelp[screen]} You can also type into the field at the bottom.`);
        } else announce('I did not understand that. Say help for examples, or type the command.');
        return;
    }
  }

  /** Everything said or typed lands here: instant local commands first, everything else goes to the agent. */
  async function dispatchCommand(transcript: string): Promise<void> {
    const said = transcript.trim();
    if (!said) return;
    setHeard(said);
    if (rtRef.current?.connected) {
      rtRef.current.sendText(said);
      return;
    }
    const normalized = said.toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,]+$/g, '');
    const appCommand = parseAppCommand(said);
    if (emergencyOpen && (appCommand?.type === 'no' || /^(close|cancel|back|stop|i'm ok|i am ok|i'm okay|i am okay)$/.test(normalized))) {
      setEmergencyOpen(false);
      announce('Emergency panel closed.');
      return;
    }
    // Instant, no network: emergencies, a broken elevator, yes or no to a proposal, speech speed.
    if (appCommand) {
      misunderstood.current = 0;
      await runAppCommand(appCommand.type);
      return;
    }
    if (/^(open )?settings$/.test(normalized)) {
      openSettings();
      return;
    }
    // Walking: step commands never wait for the network.
    if (screen === 'navigate' || screen === 'arrived') {
      const quick = parseCommand(said);
      if (quick && ['next', 'back', 'repeat', 'stop', 'where_am_i', 'whats_ahead', 'help'].includes(quick.type)) {
        await runIntent(quick);
        return;
      }
    }
    setThinking(true);
    const result = await api.agent({ utterance: said, context: agentContext(), language: profile.language });
    setThinking(false);
    if (result.ok) await handleAgent(result);
    else await legacyCommand(said);
  }

  function agentContext() {
    // Once arrived, the user stands at the old destination: that is where any new trip starts.
    const arrivedAt = screen === 'arrived' && route ? route.to : undefined;
    const from = pending?.from ?? arrivedAt ?? origin ?? undefined;
    const to = pending?.to ?? (arrivedAt ? undefined : destination ?? undefined);
    const phase = pending?.from && pending.to ? 'confirm' as const
      : screen === 'navigate' ? 'navigate' as const
      : screen === 'arrived' ? 'arrived' as const
      : route && screen === 'preview' ? 'ready' as const
      : 'trip' as const;
    const options = agentOptions?.places ?? (screen === 'where' ? originMatches : destinationMatches);
    return {
      phase,
      ...(from ? { from: { id: from.id, name: from.name } } : {}),
      ...(to ? { to: { id: to.id, name: to.name } } : {}),
      ...(options.length ? { options: options.slice(0, 5).map((p) => ({ id: p.id, name: p.name })) } : {}),
      needs: profile.needs,
      avoidStairs: Boolean(profile.avoidStairs),
      ...(screen === 'navigate' && guidance.currentStep ? { step: guidance.currentStep.text } : {}),
    };
  }

  async function handleAgent(r: Extract<AgentResponse, { ok: true }>): Promise<void> {
    misunderstood.current = 0;
    switch (r.action) {
      case 'set_trip': {
        const next = { from: r.from ?? pending?.from ?? origin ?? undefined, to: r.to ?? pending?.to ?? undefined };
        setPending(next);
        setAgentOptions(r.options?.length ? { places: r.options, for: r.optionsFor ?? 'to' } : null);
        if (screen === 'navigate' || screen === 'arrived') {
          guidance.stop();
          releaseScreenWakeLock();
          setScreen('where');
        }
        announce(r.reply);
        return;
      }
      case 'confirm':
      case 'start':
        if (pending?.from && pending.to) await confirmPending();
        else if (route && screen === 'preview') beginNavigation();
        else announce(r.reply || ASK_TRIP);
        return;
      case 'reject':
        rejectPending(r.reply);
        return;
      case 'choose_option':
        await chooseOptionNumber(r.option ?? 0);
        return;
      case 'set_needs': {
        for (const need of r.needs?.add ?? []) {
          if (need === 'avoidStairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: true } }));
          else setNeedState(need, true);
        }
        for (const need of r.needs?.remove ?? []) {
          if (need === 'avoidStairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: false } }));
          else setNeedState(need, false);
        }
        announce(`${r.reply || 'Got it.'}${origin || pending ? '' : ` ${ASK_TRIP}`}`);
        return;
      }
      case 'emergency':
        await runAppCommand('emergency');
        return;
      case 'elevator_broken':
        await runAppCommand('elevator_broken');
        return;
      case 'slower':
      case 'faster': {
        const step = r.action === 'slower' ? -0.1 : 0.1;
        updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: Math.min(1.5, Math.max(0.6, +(current.settings.speechRate + step).toFixed(2))) } }));
        announce(r.action === 'slower' ? 'Speaking slower.' : 'Speaking faster.');
        return;
      }
      case 'settings':
        openSettings();
        return;
      case 'none':
        announce(r.reply || `Sorry, I did not get that. ${ASK_TRIP}`);
        return;
      default:
        await runIntent({ type: r.action === 'where_am_i' ? 'where_am_i' : r.action === 'whats_ahead' ? 'whats_ahead' : r.action, source: 'llm' } as Intent);
    }
  }

  /** "Yes": the trip the agent proposed becomes the route, and navigation starts right away. */
  async function confirmPending(): Promise<void> {
    const trip = pending;
    if (!trip?.from || !trip.to) return;
    setPending(null);
    setAgentOptions(null);
    rememberPlace('origin', trip.from);
    setOrigin(trip.from);
    if (fix?.place.id !== trip.from.id) setFix({ place: trip.from, source: 'user', at: Date.now() });
    setOriginQuery(trip.from.name);
    const next = await createRoute(trip.to, trip.from);
    if (!next) return;
    beginNavigation(next);
    announce(`Starting. ${shortSummary(next)}`);
  }

  function rejectPending(reply?: string): void {
    setPending(null);
    setAgentOptions(null);
    announce(reply || `Okay. ${ASK_TRIP}`);
  }

  /** "The second one": fill the side the options were for, then ask to confirm the whole trip. */
  async function chooseOptionNumber(option: number): Promise<void> {
    if (!agentOptions) {
      await runIntent({ type: 'choose_option', option, source: 'llm' });
      return;
    }
    const place = agentOptions.places[option - 1];
    if (!place) {
      announce(`Say a number from 1 to ${agentOptions.places.length}.`);
      return;
    }
    const next = { ...pending, [agentOptions.for]: place } as { from?: Place; to?: Place };
    setPending(next);
    setAgentOptions(null);
    if (next.from && next.to) announce(`From ${displayName(next.from)} to ${displayName(next.to)}. Is that right?`);
    else if (next.to) announce(`Going to ${displayName(next.to)}. Where are you now?`);
    else announce(`You are at ${displayName(place)}. Where do you want to go?`);
  }

  /** Touch: edit From or To directly. */
  async function submitEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const query = editQuery.trim();
    if (!query || !editing) return;
    setAgentOptions(null);
    setPending(null);
    if (editing === 'from') {
      setScreen('where');
      const matches = await findOrigins(query);
      const exact = matches.find((place) => sameName(place, query));
      if (matches.length === 1 || exact) {
        setEditing(null);
        await chooseOrigin(exact ?? matches[0]);
      } else if (!matches.length) announce(`I could not find ${query}. Try a room number like HG E 41.`);
      else setMessage('Choose your starting point:');
    } else {
      setScreen('destination');
      const shown = await findDestinations(query, true);
      if (shown.length > 1) setMessage('Choose your destination:');
      setEditing(null);
    }
  }

  /** Spoken + shown description of where the user probably is, for emergencies. */
  function locationDescription(): string {
    const step = screen === 'navigate' ? guidance.currentStep : null;
    if (step) {
      const near = step.expectedLandmarks.find((l) => l.kind === 'room_sign')?.label;
      return `ETH main building, H G, floor ${step.levelId.split('.').at(-1)}${near ? `, near room ${near}` : ''}, on the way to ${route?.to.name ?? 'your destination'}.`;
    }
    if (screen === 'arrived' && route) return `ETH main building, H G, at ${route.to.name}.`;
    if (origin) return `ETH main building, H G, near ${origin.name}.`;
    return 'ETH main building, H G, Rämistrasse 101, Zürich.';
  }

  async function runAppCommand(type: NonNullable<ReturnType<typeof parseAppCommand>>['type']): Promise<void> {
    switch (type) {
      case 'emergency':
        setEmergencyOpen(true);
        announce(`Emergency. For immediate danger, call 1 1 2. For an ambulance, call 1 4 4. The call buttons are on screen. Your location: ${locationDescription()} Say close to go back.`, 'instruction');
        return;
      case 'elevator_broken':
        await reportElevatorOutOfService();
        return;
      case 'change_needs':
        openSettings();
        announce('Your needs are in settings. Or just tell me, for example: I use a wheelchair.');
        return;
      case 'start_over':
        startOver();
        return;
      case 'yes':
        if (pending?.from && pending.to) await confirmPending();
        else if (screen === 'preview') beginNavigation();
        else if (screen === 'needs') setScreen('permissions');
        else if (screen === 'permissions') { await enableDevicePermissions(); setScreen('where'); }
        else if (screen === 'arrived') startNewDestination();
        else if (screen === 'destination' && destinationMatches.length === 1) await createRoute(destinationMatches[0]);
        else if (screen === 'where' && originMatches.length === 1) await chooseOrigin(originMatches[0]);
        else announce('Okay.');
        return;
      case 'no':
        if (pending) rejectPending();
        else if (screen === 'preview') { setScreen('destination'); announce('Okay. Say take me to, and another room.'); }
        else if (screen === 'permissions') setScreen('where');
        else announce('Okay.');
        return;
      case 'repeat_slower': {
        const slower = Math.max(0.6, +(preferences.settings.speechRate - 0.15).toFixed(2));
        updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: slower } }));
        // Let the new rate apply before repeating.
        window.setTimeout(() => { void dispatchCommand('repeat'); }, 80);
        return;
      }
      case 'louder':
        announce('I cannot change the volume. Use your phone volume buttons. Say slower if I speak too fast.');
        return;
    }
  }

  /** "The elevator is not working": avoid that elevator's whole shaft and route again from here. */
  async function reportElevatorOutOfService(): Promise<void> {
    if (!route) {
      announce('There is no route yet. Choose a destination first, and I will avoid elevators you report.');
      return;
    }
    const fromIndex = screen === 'navigate' ? guidance.stepIndex : 0;
    const ride = route.steps.slice(fromIndex).find((step) => step.maneuver === 'take_elevator');
    if (!ride) {
      announce('This route does not use an elevator.');
      return;
    }
    const avoid = [...new Set([...avoidElevators, ride.startNodeId])];
    setAvoidElevators(avoid);
    // Navigating: start from where the user is now (the current step's start, or the elevator itself).
    const fromNode = screen === 'navigate' ? (guidance.currentStep?.startNodeId ?? ride.startNodeId) : null;
    const from = fromNode ? { type: 'node' as const, nodeId: fromNode } : 'id' in route.from ? { type: 'place' as const, placeId: route.from.id } : { type: 'node' as const, nodeId: route.from.nodeId };
    setBusy(true);
    const result = await api.route({ from, to: { type: 'place', placeId: route.to.id }, profile: { ...profile, avoidElevatorAt: avoid } });
    setBusy(false);
    if (!result.ok) {
      announce(`I will avoid that elevator, but ${result.message}`, 'instruction');
      return;
    }
    setRoute(result);
    setSelectedLevel(result.levels[0] ?? route.to.levelId);
    if (screen === 'navigate') {
      setStartAfterRoute(true);
      announce(`Okay, avoiding that elevator. New route: ${Math.round(result.totalDistanceM)} metres.`, 'instruction');
    } else announce(`Okay, avoiding that elevator. ${routeSummary(result)}`);
  }

  function startOver(): void {
    guidance.stop();
    releaseScreenWakeLock();
    setRoute(null);
    setDestination(null);
    setDestinationQuery('');
    setDestinationMatches([]);
    setOrigin(null);
    setOriginQuery('');
    setOriginMatches([]);
    setAvoidElevators([]);
    setPending(null);
    setAgentOptions(null);
    setHeard('');
    setScreen('where');
    announce(`Starting over. ${ASK_TRIP}`);
  }

  function beginNavigation(next: Route | null = route): void {
    if (!next) return;
    // The trip-screen reply would otherwise linger in the HUD; the first instruction speaks for itself.
    setMessage('');
    void requestScreenWakeLock();
    if (preferences.settings.voiceFirst) voiceBarRef.current?.startContinuous();
    setStartAfterRoute(true);
    setScreen('navigate');
  }

  function startNewDestination(): void {
    releaseScreenWakeLock();
    // The user is now at the old destination, so the next route starts there.
    if (route) {
      setOrigin(route.to);
      setOriginQuery(route.to.name);
    }
    setRoute(null);
    setDestination(null);
    setDestinationQuery('');
    setDestinationMatches([]);
    setScreen('destination');
  }

  function submitOrigin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void findOrigins(originQuery).then((matches) => {
      if (!matches.length) announce(`I couldn't find ${originQuery}. Try a room name like HG E 41.`);
    });
  }

  function submitDestination(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void findDestinations(destinationQuery);
  }

  function preferenceToggle(need: Need, label: string, description?: string) {
    const checked = profile.needs.includes(need);
    return (
      <label className="need-option" key={need}>
        <input type="checkbox" checked={checked} onChange={() => updateNeed(need)} />
        <span className="need-copy"><strong>{label}</strong>{description && <small>{description}</small>}</span>
      </label>
    );
  }

  /* ───────── Realtime agent: live state and tools ───────── */

  const navigating = screen === 'navigate' && (guidance.phase === 'navigating' || guidance.phase === 'approaching' || guidance.phase === 'rerouting');

  function currentEstimate() {
    return estimatePosition({ now: Date.now(), fix, navigating, step: navigating ? guidance.currentStep : null, stepIndex: guidance.stepIndex, progressM: guidance.progressM });
  }

  /** /api/position for the estimate, cached until the estimate moves ~2 m or changes floor. */
  async function positionInfo(request: ReturnType<typeof currentEstimate>['request']): Promise<PositionInfo | null> {
    if (!request.placeId && request.lat == null) return null;
    const gps = sensors.freshGps();
    const key = request.placeId ?? `${request.levelId}:${request.lat!.toFixed(5)}:${request.lon!.toFixed(5)}`;
    const cached = positionCache.current;
    if (cached?.key === key) return cached.info;
    try {
      const ctl = new AbortController();
      const timer = window.setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(API.position, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, ...(gps ? { gps: { lat: gps.lat, lon: gps.lon, accuracyM: gps.accuracyM } } : {}) }), signal: ctl.signal });
      window.clearTimeout(timer);
      const info = (await res.json()) as PositionInfo;
      positionCache.current = { key, info };
      return info;
    } catch {
      return cached?.info ?? null;
    }
  }

  async function buildLiveState(): Promise<string> {
    const now = Date.now();
    const estimate = currentEstimate();
    const info = await positionInfo(estimate.request);
    const step = guidance.currentStep;
    const gps = sensors.freshGps(now);
    const vision = guidance.lastVision ?? null;
    return formatLiveState({
      now,
      screen: screen === 'navigate' ? `navigating (${guidance.phase})` : screen === 'arrived' ? 'arrived' : screen === 'settings' ? 'settings' : 'trip planning',
      trip: {
        from: (pending?.from ?? origin ?? undefined)?.name,
        to: (pending?.to ?? destination ?? route?.to ?? undefined)?.name,
        confirming: Boolean(pending?.from && pending?.to),
        options: agentOptions?.places.map((p) => placeLabel(p)),
      },
      navigation: navigating && route && step ? {
        stepIndex: guidance.stepIndex,
        stepCount: route.steps.length,
        instruction: step.text,
        nextInstruction: guidance.nextStep?.text,
        remainingStepM: guidance.remainingStepM,
        remainingTotalM: guidance.remainingTotalM,
        bearingDeg: isVerticalStep(step) ? null : bearingAt(step.polyline, guidance.progressM) ?? step.bearingDeg,
        vertical: isVerticalStep(step),
      } : undefined,
      estimate,
      info,
      heading: sensors.heading(),
      moving: sensors.sensor?.moving ?? guidance.moving,
      gps: gps ? { lat: gps.lat, lon: gps.lon, accuracyM: gps.accuracyM, ageS: Math.round((now - gps.at) / 1000) } : null,
      needs: [...profile.needs, ...(profile.avoidStairs ? ['avoidStairs'] : [])],
      ...(vision?.sceneSummary ? { lastSeen: { summary: vision.sceneSummary, ageS: Math.round((now - lastVisionAt.current) / 1000) } } : {}),
    });
  }

  /** Runs one model tool call. Anything the app announces meanwhile is handed back for the model to say. */
  async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    toolSink.current = [];
    try {
      const result = await toolBody(name, args);
      const said = toolSink.current ?? [];
      if (!said.length) return result;
      return { ...result, output: { ...(result.output as object), app_said: said.join(' '), note_app_said: 'Not spoken yet: say it (step instructions word for word).' } };
    } finally {
      toolSink.current = null;
    }
  }

  async function toolBody(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'get_position':
        return { output: { state: await buildLiveState() } };

      case 'look': {
        try {
          const jpegBase64 = await captureFrame(1024, 0.7);
          const h = sensors.heading();
          setCameraFramePreview(`data:image/jpeg;base64,${jpegBase64}`);
          const facing = h.deg == null ? 'unknown direction (no compass)' : `${Math.round(h.deg)}° (${compassName(h.deg)})${h.reliable ? '' : ', compass unreliable'}`;
          return {
            output: { ok: true, facing, note: 'The photo follows. If it shows a room sign or landmark that tells where the user is, call set_position.' },
            image: { jpegBase64, caption: `Camera photo just taken; the phone points ${facing}. Looking for: ${String(args.purpose ?? '')}` },
          };
        } catch (error) {
          return { output: { ok: false, error: `Camera unavailable: ${error instanceof Error ? error.message : 'unknown error'}. Ask the user instead.` } };
        }
      }

      case 'set_position': {
        const text = String(args.place ?? '').trim();
        const evidence = args.evidence === 'user' ? 'user' : 'sign';
        const distanceM = Number(args.distance_m) || 0;
        const levelHint = currentEstimate().request.levelId ?? fix?.place.levelId;
        const loc = await api.localize({ roomText: text, levelHint });
        if (!loc.ok) return { output: { ok: false, error: loc.message, hint: 'Look again, or ask the user for a room number.' } };
        const place = loc.place ?? (await fetchPlaces(text))?.[0];
        if (!place) return { output: { ok: false, error: `No place matches ${text}.` } };
        const next: Fix = { place, source: evidence, at: Date.now(), distanceM };
        setFix(next);
        let rerouted = false;
        if (navigating && route) {
          // Far from where the route says they are (or another floor): plan again from the real position.
          const est = currentEstimate().request;
          const far = est.lat != null && est.lon != null && (est.levelId !== place.levelId || Math.hypot((est.lat - place.lat) * 110540, (est.lon - place.lon) * 75000) > 15);
          if (far) {
            await rerouteFromNode(place.nodeId, place.name);
            rerouted = true;
          }
        } else {
          setOrigin(place);
          setOriginQuery(place.name);
          if (pending) setPending({ ...pending, from: place });
        }
        positionCache.current = null;
        const info = await positionInfo({ placeId: place.id });
        return {
          output: {
            ok: true,
            matched: place.name,
            confidence: loc.confidence,
            ...(loc.confidence < 0.9 ? { note: `Approximate: "${text}" is not an exact room name; the closest is ${place.name}. Say so, and check with another sign if it matters.` } : {}),
            alternatives: loc.alternatives.slice(0, 3).map((p) => p.name),
            rerouted,
            floor: info?.ok ? info.floor : undefined,
            nearby: info?.ok ? info.nearby.slice(0, 6).map((p) => `${p.label && p.kind !== 'room' ? p.label : p.name} ${Math.round(p.distM)} m`) : undefined,
          },
        };
      }

      case 'plan_trip': {
        const est = currentEstimate();
        const info = await positionInfo(est.request);
        const near = fix?.place.id ?? (info?.ok ? info.nearby.find((p) => p.kind === 'room')?.placeId : undefined);
        const res = await fetch(API.realtimeResolve, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fromText: args.from ?? null, toText: args.to ?? null, nearPlaceId: near, needs: profile.needs }),
        }).then((r) => r.json() as Promise<ResolveTripResponse>);
        const from = res.from ?? pending?.from ?? (fix?.place) ?? origin ?? undefined;
        const to = res.to ?? (args.to ? undefined : pending?.to ?? destination ?? undefined);
        if (res.to && (screen === 'navigate' || screen === 'arrived')) {
          guidance.stop();
          releaseScreenWakeLock();
          setScreen('where');
        }
        setPending({ from, to });
        setAgentOptions(res.options?.length ? { places: res.options, for: res.optionsFor ?? 'to' } : null);
        setMessage(res.say);
        return {
          output: {
            say: res.say,
            from: from?.name ?? null,
            to: to?.name ?? null,
            ...(res.options?.length ? { options: res.options.map((p) => placeLabel(p)), options_for: res.optionsFor } : {}),
            ...(res.notFound ? { not_found: res.notFound } : {}),
            ...(!from ? { start_unknown: 'Localize first (look, or ask where they are).' } : {}),
          },
        };
      }

      case 'start_navigation': {
        if (pending?.from && pending.to) {
          await confirmPending();
          return { output: { ok: true, note: 'Guidance started; the app reads the first instruction right after you. Say at most a few words.' } };
        }
        if (route && screen === 'preview') {
          beginNavigation();
          return { output: { ok: true } };
        }
        return { output: { ok: false, error: pending?.to ? 'The start is unknown: localize the user first.' : 'No trip yet: call plan_trip first.' } };
      }

      case 'navigation': {
        const action = String(args.action);
        if (screen !== 'navigate') return { output: { ok: false, error: 'Not navigating.' } };
        if (action === 'next') guidance.next();
        else if (action === 'back') guidance.back();
        else if (action === 'repeat') guidance.repeat();
        else if (action === 'stop') {
          guidance.stop();
          releaseScreenWakeLock();
          setScreen('preview');
        }
        return { output: { ok: true } };
      }

      case 'set_needs': {
        const add = (Array.isArray(args.add) ? args.add : []) as (Need | 'avoidStairs')[];
        const remove = (Array.isArray(args.remove) ? args.remove : []) as (Need | 'avoidStairs')[];
        for (const need of add) {
          if (need === 'avoidStairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: true } }));
          else setNeedState(need, true);
        }
        for (const need of remove) {
          if (need === 'avoidStairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: false } }));
          else setNeedState(need, false);
        }
        return { output: { ok: true, note: 'Routes planned from now on use these needs.' } };
      }

      case 'report_elevator_broken':
        await reportElevatorOutOfService();
        return { output: { ok: true } };

      case 'emergency':
        await runAppCommand('emergency');
        return { output: { ok: true, location: locationDescription() } };

      default:
        return { output: { ok: false, error: `Unknown tool ${name}.` } };
    }
  }

  const liveStateRef = useRef(buildLiveState);
  liveStateRef.current = buildLiveState;
  const runToolRef = useRef(runTool);
  runToolRef.current = runTool;

  const voiceFirst = preferences.settings.voiceFirst;
  const tripFrom = pending?.from ?? origin ?? null;
  const tripTo = pending?.to ?? destination ?? (route ? route.to : null);
  const confirming = Boolean(pending?.from && pending?.to);
  const ready = !confirming && Boolean(route) && screen === 'preview';
  const optionList = agentOptions?.places
    ?? (editing === 'from' || screen === 'where' ? originMatches : destinationMatches);
  const prompt = thinking ? 'Thinking…' : message || (!tripFrom ? ASK_TRIP : !tripTo ? 'Where do you want to go?' : '');
  const elevatorAhead = Boolean(route?.steps.slice(guidance.stepIndex).some((step) => step.maneuver === 'take_elevator'));
  const visionLine = cameraBusy || guidance.visionBusy ? 'Camera is checking…' : guidanceVision || guidance.lastVision?.sceneSummary || '';
  const chooseFromList = (place: Place, index: number) => {
    if (agentOptions) void chooseOptionNumber(index + 1);
    else if (editing === 'from' || screen === 'where') { setEditing(null); void chooseOrigin(place); }
    else void createRoute(place);
  };
  const needChips: [Need | 'avoidStairs', string][] = [['wheelchair', 'Wheelchair'], ['blind', 'Blind'], ['lowVision', 'Low vision'], ['avoidStairs', 'No stairs']];
  const needOn = (need: Need | 'avoidStairs') => need === 'avoidStairs' ? Boolean(profile.avoidStairs) : profile.needs.includes(need);
  const toggleNeed = (need: Need | 'avoidStairs') => {
    if (need === 'avoidStairs') updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: !current.profile.avoidStairs } }));
    else updateNeed(need);
  };
  const tripRow = (side: 'from' | 'to', label: string, place: Place | null, placeholder: string) => (
    <div className={`trip-row${place ? ' is-set' : ''}`}>
      <span className={`trip-dot trip-dot-${side}`} aria-hidden="true" />
      {editing === side && !voiceFirst ? (
        <form className="trip-edit" onSubmit={(event) => void submitEdit(event)}>
          <label className="sr-only" htmlFor={`edit-${side}`}>{label}</label>
          <input id={`edit-${side}`} value={editQuery} autoFocus autoComplete="off" placeholder={side === 'from' ? 'Room, e.g. HG F 7' : 'Room or place, e.g. F 30, toilet'} onChange={(event) => setEditQuery(event.target.value)} />
          <button className="button button-accent" type="submit" disabled={!editQuery.trim() || busy}>Find</button>
          <button className="button button-ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : (
        <button className="trip-value" type="button" disabled={voiceFirst} onClick={() => { setEditing(side); setEditQuery(''); }}>
          <small>{label}</small>
          <strong>{place ? displayName(place) : placeholder}</strong>
          {place?.label && place.kind === 'room' && <em>{place.label}</em>}
        </button>
      )}
    </div>
  );

  return (
    <div
      className={`app-shell${voiceFirst ? ' app-voice-first' : ''}${profile.needs.includes('lowVision') ? ' app-low-vision' : ''}${screen === 'navigate' ? ' is-travelling' : ''}`}
      style={preferences.settings.textScale !== 1 ? { zoom: preferences.settings.textScale } : undefined}
      onPointerDown={() => {
        if (started && !touched) setTouched(true);
        retryRealtimeOnTap();
      }}
    >
      {!started && (
        <main className="start-screen">
          {/* The whole screen starts the app, so a blind user can tap anywhere; everything after is voice. */}
          <section className="start-tap-area" onClick={beginApp}>
            <span className="brand-mark brand-mark-large" aria-hidden="true">P</span>
            <h1>PolyGuide</h1>
            <p className="start-lead">Indoor directions for the ETH main building. Tap anywhere, then just say where you are and where you want to go.</p>
            <button type="button" className="button button-accent start-gate" autoFocus>Start</button>
            <p className="start-note">{safetyNotice}</p>
          </section>
        </main>
      )}

      {started && screen !== 'navigate' && screen !== 'settings' && (
        <header className="top-bar">
          <p className="brand"><span className="brand-mark" aria-hidden="true">P</span><strong>PolyGuide</strong></p>
          <div className="top-actions">
            <button type="button" className="button button-ghost" onClick={openSettings}>Settings</button>
            <button type="button" className="button button-ghost button-danger-text" onClick={() => void runAppCommand('emergency')}>Emergency</button>
          </div>
        </header>
      )}

      {/* ───────── Trip: one screen, no scrolling ───────── */}
      {started && screen !== 'navigate' && screen !== 'settings' && screen !== 'arrived' && (
        <main className="trip" aria-labelledby="trip-title">
          <h1 id="trip-title" className="sr-only">Plan your trip</h1>
          <section className="trip-card" aria-label="Your trip">
            {tripRow('from', 'From', tripFrom, 'Where are you?')}
            {tripRow('to', 'To', tripTo, 'Where to?')}
          </section>

          {!voiceFirst && (
            <div className="need-chips" role="group" aria-label="Access needs">
              {needChips.map(([need, label]) => (
                <button key={need} type="button" className="chip" aria-pressed={needOn(need)} onClick={() => toggleNeed(need)}>{label}</button>
              ))}
            </div>
          )}

          <section className="convo" aria-label="Conversation">
            {heard && <p className="convo-heard"><span className="sr-only">You said: </span>“{heard}”</p>}
            {prompt && <p className={`convo-reply${thinking ? ' is-thinking' : ''}`} role="status" aria-live="polite">{prompt}</p>}

            {optionList.length > 0 && !confirming && (
              <ol className="options">
                {optionList.slice(0, 4).map((place, index) => (
                  <li key={place.id}>
                    <button type="button" className="option" onClick={() => chooseFromList(place, index)}>
                      <span className="option-n">{index + 1}</span>
                      <span>{placeLabel(place)}{place.useType && place.kind === 'room' && <small>{useTypeLabel(place.useType)}</small>}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {confirming && (
              <div className="convo-actions">
                <button type="button" className="button button-accent button-big" onClick={() => void confirmPending()}>Yes, start</button>
                <button type="button" className="button button-ghost button-big" onClick={() => rejectPending()}>No</button>
              </div>
            )}

            {ready && route && (
              <div className="ready">
                {!voiceFirst && <ul className="ready-facts" aria-label="Route summary">
                  <li><strong>{Math.round(route.totalDistanceM)} m</strong><small>distance</small></li>
                  <li><strong>{Math.max(1, Math.round(route.totalDurationS / 60))} min</strong><small>time</small></li>
                  <li><strong>{route.levels.map((level) => level.split('.').at(-1)).join('→')}</strong><small>floors</small></li>
                </ul>}
                <div className="convo-actions">
                  <button type="button" className="button button-accent button-big" onClick={() => beginNavigation()}>Start</button>
                  {!voiceFirst && <button type="button" className="button button-ghost button-big" onClick={() => setSheetOpen(true)}>Details</button>}
                </div>
              </div>
            )}
          </section>
        </main>
      )}

      {/* ───────── Travelling: camera HUD ───────── */}
      {started && screen === 'navigate' && route && (
        <main className={`hud${voiceFirst ? ' hud-minimal' : ''}`} aria-labelledby="hud-title">
          <CameraBackdrop enabled={cameraGranted} />
          <header className="hud-top">
            <div className="hud-trip">
              <h1 id="hud-title">To {displayName(route.to)}{route.to.label && route.to.kind === 'room' ? `, ${route.to.label}` : ''}</h1>
              <p>Step {Math.min(guidance.stepIndex + 1, route.steps.length)} of {route.steps.length}, {Math.round(guidance.remainingTotalM)} m to go</p>
            </div>
            <button type="button" className="hud-pill hud-pill-danger" onClick={() => void runAppCommand('emergency')}>Emergency</button>
          </header>
          <ol className="hud-track" aria-hidden="true">
            {route.steps.map((step) => <li key={step.index} className={step.index < guidance.stepIndex ? 'done' : step.index === guidance.stepIndex ? 'current' : ''} />)}
          </ol>

          {!voiceFirst && (
            <div className="hud-arrow" aria-hidden="true" style={guidance.compassReliable && guidance.headingDeltaDeg != null ? { transform: `rotate(${guidance.headingDeltaDeg}deg)` } : undefined}>
              {guidance.compassReliable && guidance.headingDeltaDeg != null ? '↑' : maneuverGlyph(guidance.currentStep?.maneuver)}
            </div>
          )}

          <section className="hud-panel" aria-label="Current instruction">
            {voiceFirst && <p className="hud-fromto">From {route.from.name} to {displayName(route.to)}</p>}
            <p className="hud-instruction">{guidance.currentStep?.text ?? 'Follow the route.'}</p>
            {!voiceFirst && guidance.currentStep && guidance.currentStep.distanceM > 0 && <p className="hud-sub">{Math.round(guidance.remainingStepM)} m left on this step</p>}
            {!voiceFirst && guidance.nextStep && <p className="hud-next">Then: {guidance.nextStep.text}</p>}
            {visionLine && <p className="hud-vision"><span aria-hidden="true">◉ </span>{visionLine}</p>}
            {(heard || (message && !thinking)) && (
              <p className="hud-convo">{heard && <span className="hud-heard">“{heard}” </span>}{thinking ? 'Thinking…' : message}</p>
            )}
            {!voiceFirst && (
              <div className="hud-controls" role="group" aria-label="Navigation controls">
                <button type="button" className="hud-pill" onClick={() => guidance.repeat()}>Repeat</button>
                <button type="button" className="hud-pill hud-pill-accent" onClick={() => guidance.next()}>{guidance.currentStep?.maneuver === 'take_elevator' ? 'Done' : 'Next'}</button>
                <button type="button" className="hud-pill" onClick={() => { guidance.whereAmI(); if (cameraGranted) void checkCamera('user_query'); }}>Where am I?</button>
                <button type="button" className="hud-pill hud-pill-stop" onClick={() => { guidance.stop(); releaseScreenWakeLock(); setScreen('preview'); }}>Stop</button>
              </div>
            )}
            {!voiceFirst && (
              <div className="hud-links">
                <button type="button" className="hud-link" onClick={() => setSheetOpen(true)}>Map</button>
                {elevatorAhead && <button type="button" className="hud-link" onClick={() => void reportElevatorOutOfService()} disabled={busy}>Elevator not working?</button>}
              </div>
            )}
          </section>
          <div className="sr-only" aria-live="assertive" aria-atomic="true">{liveGuidanceAnnouncement}</div>
        </main>
      )}

      {/* ───────── Arrived ───────── */}
      {started && screen === 'arrived' && (() => {
        const side = route?.steps.at(-1)?.side;
        const target = destination ?? route?.to ?? null;
        const where = side === 'left' ? 'on your left' : side === 'right' ? 'on your right' : 'ahead of you';
        const backTo = route && 'id' in route.from ? route.from : null;
        return (
          <main className="trip arrived" aria-labelledby="arrived-title">
            <section className="arrived-card">
              <span className="arrived-arrow" aria-hidden="true">{side === 'left' ? '←' : side === 'right' ? '→' : '↑'}</span>
              <h1 id="arrived-title">You have arrived</h1>
              <p>{target ? `${displayName(target)}${target.label && target.kind === 'room' ? `, the ${target.label},` : ''} is ${where}.` : `Your destination is ${where}.`}</p>
            </section>
            <section className="convo" aria-label="Conversation">
              {heard && <p className="convo-heard">“{heard}”</p>}
              <p className="convo-reply" role="status">{thinking ? 'Thinking…' : 'Where to next? Say it, or choose below.'}</p>
              <div className="convo-actions">
                <button className="button button-accent button-big" type="button" onClick={startNewDestination}>New destination</button>
                {backTo && <button className="button button-ghost button-big" type="button" onClick={() => void createRoute(backTo, route!.to)}>Back to {displayName(backTo)}</button>}
              </div>
            </section>
          </main>
        );
      })()}

      {/* ───────── Settings (the one screen that scrolls) ───────── */}
      {started && screen === 'settings' && (
        <main className="settings" aria-labelledby="settings-title">
          <div className="settings-head">
            <h1 id="settings-title">Settings</h1>
            <button className="button button-accent" type="button" onClick={moveBack}>Done</button>
          </div>
          <div className="setting-control">
            <span><strong>Your needs</strong><small>Routes adapt to them</small></span>
            <div className="need-chips" role="group" aria-label="Access needs">
              {needChips.map(([need, label]) => (
                <button key={need} type="button" className="chip" aria-pressed={needOn(need)} onClick={() => toggleNeed(need)}>{label}</button>
              ))}
            </div>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={voiceFirst} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, voiceFirst: event.target.checked } }))} /><span><strong>Voice-first mode</strong><small>Minimal screen, always listening. On automatically for blind users.</small></span></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.realtimeVoice} onChange={(event) => {
            const enabled = event.target.checked;
            updatePreferences((current) => ({ ...current, settings: { ...current.settings, realtimeVoice: enabled } }));
            if (enabled) void connectRealtime();
            else { rtRef.current?.close(); rtRef.current = null; setRtStatus('off'); }
          }} /><span><strong>Conversational voice</strong><small>Answers in under a second, knows where you are and can look through the camera. Needs a connection.</small></span></label>
          <VoicePicker value={preferences.settings.voiceName} onChange={(voiceName) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, voiceName } }))} />
          <label className="setting-control" htmlFor="speech-rate"><span><strong>Speech rate</strong><small>{preferences.settings.speechRate.toFixed(1)}×</small></span><input id="speech-rate" type="range" min="0.6" max="1.5" step="0.1" value={preferences.settings.speechRate} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: Number(event.target.value) } }))} /></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.speakWithAppVoice} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, speakWithAppVoice: event.target.checked } }))} /><span><strong>Speak with app voice</strong><small>Turn this off when your screen reader already reads the instruction.</small></span></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.beaconEnabled} onChange={(event) => { const enabled = event.target.checked; updatePreferences((current) => ({ ...current, settings: { ...current.settings, beaconEnabled: enabled } })); guidance.setBeaconEnabled(enabled); }} /><span><strong>Audio direction beacon</strong><small>A stereo tick that moves toward the route direction and double-ticks when you face it.</small></span></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.haptics} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, haptics: event.target.checked } }))} /><span><strong>Vibrate on each new instruction</strong><small>Feel when the next step starts. Android phones.</small></span></label>
          <div className="setting-control">
            <span><strong>Text size</strong></span>
            <div className="floor-tabs" role="group" aria-label="Text size">
              {([1, 1.25, 1.5] as const).map((scale) => (
                <button key={scale} type="button" className="floor-tab" aria-pressed={preferences.settings.textScale === scale} onClick={() => updatePreferences((current) => ({ ...current, settings: { ...current.settings, textScale: scale } }))}>
                  {scale === 1 ? 'Standard' : scale === 1.25 ? 'Large' : 'Largest'}
                </button>
              ))}
            </div>
          </div>
          <label className="setting-control" htmlFor="step-length"><span><strong>Step length</strong><small>{preferences.settings.stepLengthM.toFixed(1)} m</small></span><input id="step-length" type="range" min="0.3" max="1.5" step="0.1" value={preferences.settings.stepLengthM} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, stepLengthM: Number(event.target.value) }, profile: { ...current.profile, stepLengthM: Number(event.target.value) } }))} /></label>
          <div className="setting-control">
            <span><strong>History</strong></span>
            <button className="button button-ghost" type="button" onClick={() => { clearRecents(); announce('Recent places cleared.'); }}>Clear recent places</button>
          </div>
        </main>
      )}

      {started && emergencyOpen && (
        <div className="sheet-backdrop" role="presentation">
          <section className="emergency-panel" role="alertdialog" aria-modal="true" aria-labelledby="emergency-title" aria-describedby="emergency-location">
            <h2 id="emergency-title">Emergency</h2>
            <p>If you are in danger or hurt, call for help. Tell them where you are:</p>
            <p id="emergency-location" className="emergency-location">{locationDescription()}</p>
            <div className="emergency-actions">
              <a className="button button-danger button-big" href="tel:112">Call 112, emergency</a>
              <a className="button button-danger button-big" href="tel:144">Call 144, ambulance</a>
              <button className="button button-ghost button-big" type="button" onClick={() => setEmergencyOpen(false)}>Close</button>
            </div>
          </section>
        </div>
      )}

      {sheetOpen && route && (
        <RouteSheet route={route} levelId={selectedLevel || route.levels[0]} onLevel={setSelectedLevel} onClose={() => setSheetOpen(false)} activeStepIndex={screen === 'navigate' ? guidance.stepIndex : undefined} />
      )}

      <footer className="dock" hidden={!started || screen === 'settings'}>
        {rtActive && (
          <RealtimeDock
            status={rtStatus}
            muted={rtMuted}
            voiceFirst={voiceFirst}
            onToggleMute={() => { const next = !rtMuted; setRtMuted(next); rtRef.current?.setMuted(next); }}
            onInterrupt={() => rtRef.current?.cancelSpeech()}
            onText={(text) => { void dispatchCommand(text); }}
          />
        )}
        {/* Kept mounted (hidden) while the realtime voice runs, so the fallback can take over at once. */}
        <div hidden={rtActive}>
        <VoiceBar
          ref={voiceBarRef}
          voiceFirst={voiceFirst}
          continuous={screen === 'navigate' || voiceFirst || !touched}
          language={profile.language ?? 'en'}
          onCommand={(transcript) => { void dispatchCommand(transcript); }}
        />
        </div>
      </footer>
    </div>
  );
}
