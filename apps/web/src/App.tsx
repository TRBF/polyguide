import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  type AgentResponse,
  type Intent,
  type IntentRequest,
  type Need,
  type Place,
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
import { PATTERN_LEGEND, buzz, stepPattern } from './guidance/haptics';
import { requestSensorPermissions } from './sensorPermissions';
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
/** How many choices are read out, shown and numbered: the same everywhere, so "number 3" means one thing. */
const MAX_OPTIONS = 4;
const WELCOME = `Welcome to PolyGuide. ${safetyNotice} ${ASK_TRIP} If you are blind or use a wheelchair, tell me.`;

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
  const [pending, setPendingState] = useState<{ from?: Place; to?: Place } | null>(null);
  /** The trip being proposed, readable at once: two quick sentences must not each see a stale copy. */
  const pendingRef = useRef<{ from?: Place; to?: Place } | null>(null);
  function setPending(next: { from?: Place; to?: Place } | null): void {
    pendingRef.current = next;
    setPendingState(next);
  }
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
  // Screen readers: when a screen swaps, the focused button disappears and focus falls to the page. Put it on
  // the new screen's heading instead (never steal it from a field or button the user is on).
  useEffect(() => {
    if (!started) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const heading = document.querySelector<HTMLElement>('main h1');
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [screen, started]);

  // The emergency dialog takes focus (on its title, not a call button a stray tap could press) and closes on Escape.
  useEffect(() => {
    if (!emergencyOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    document.getElementById('emergency-title')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setEmergencyOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [emergencyOpen]);

  // Survey mode (team only): offered in settings when the server has a survey code configured.
  const [survey, setSurvey] = useState<{ enabled: boolean; total: number } | null>(null);
  const [surveyCode, setSurveyCode] = useState(() => { try { return localStorage.getItem('polyguide.surveyCode') ?? ''; } catch { return ''; } });
  const [surveySpot, setSurveySpot] = useState('');
  const [surveyBusy, setSurveyBusy] = useState(false);
  const [surveyMessage, setSurveyMessage] = useState('');
  useEffect(() => {
    if (screen !== 'settings') return;
    let cancelled = false;
    void api.refsStatus().then((status) => { if (!cancelled && status) setSurvey({ enabled: status.enabled, total: status.total }); });
    return () => { cancelled = true; };
  }, [screen]);

  const dispatchQueue = useRef<Promise<void>>(Promise.resolve());
  const latestDispatch = useRef<(text: string) => Promise<void>>(async () => undefined);
  /** Changes whenever navigation ends; async work started earlier checks it before acting. */
  const navToken = useRef(0);
  useEffect(() => {
    if (screen !== 'navigate') navToken.current += 1;
  }, [screen]);
  const hapticsRef = useRef(preferences.settings.haptics);
  hapticsRef.current = preferences.settings.haptics;

  const profile = useMemo(() => ({
    ...preferences.profile,
    needs: [...preferences.profile.needs],
    stepLengthM: preferences.settings.stepLengthM,
    ...(avoidElevators.length ? { avoidElevatorAt: avoidElevators } : {}),
  }), [preferences, avoidElevators]);

  const announce = useCallback((text: string, priority: 'instruction' | 'vision' | 'heading' | 'info' = 'info') => {
    setMessage(text);
    speak(text, priority);
  }, []);

  const onGuidanceSpeak = useCallback((text: string, priority: 'instruction' | 'vision' | 'heading' | 'info') => {
    setLiveGuidanceAnnouncement('');
    if (guidanceAnnouncementTimer.current !== null) window.clearTimeout(guidanceAnnouncementTimer.current);
    guidanceAnnouncementTimer.current = window.setTimeout(() => setLiveGuidanceAnnouncement(text), 60);
    speak(text, priority);
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
    void requestSensorPermissions().catch(() => undefined);
    setStarted(true);
    setScreen('where');
    voiceBarRef.current?.startContinuous();
    void enableDevicePermissions(true);
    const needs = describeNeeds(preferences);
    const text = returning
      ? `Welcome back${needs ? `. Using your needs: ${needs}` : ''}. ${ASK_TRIP}`
      : WELCOME;
    setMessage(returning ? text : ASK_TRIP);
    speak(returning ? `${text} ${safetyNotice}` : text, 'info');
  }

  // Hands-free listening: always on the first screen (a blind user can't tap "Blind" first), and on every
  // screen in voice-first mode. Touch users fall back to push-to-talk once they move on.
  useEffect(() => {
    if (!started) return;
    if (preferences.settings.voiceFirst || !touched) voiceBarRef.current?.startContinuous();
    else if (screen !== 'navigate') voiceBarRef.current?.stopContinuous();
  }, [started, preferences.settings.voiceFirst, screen, touched]);

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

  // Every change of movement is felt: each new step (and arrival, and a reroute's first step) buzzes the
  // pattern for what to do next, so users who cannot hear the voice still notice every turn.
  const lastHapticStep = useRef('');
  useEffect(() => {
    if (screen !== 'navigate' || !route || guidance.phase === 'idle' || !guidance.currentStep) return;
    const key = `${route.routeId}:${guidance.stepIndex}:${guidance.phase === 'arrived' ? 'arrived' : ''}`;
    if (lastHapticStep.current === key) return;
    lastHapticStep.current = key;
    if (hapticsRef.current) buzz(stepPattern(guidance.phase === 'arrived' ? 'arrive' : guidance.currentStep.maneuver));
  }, [screen, route?.routeId, guidance.stepIndex, guidance.phase, guidance.currentStep]);

  // The camera checks every new step automatically (and whenever the user asks). It goes through the
  // guidance engine, which runs one camera request at a time and stops when the server has no AI.
  const guidanceActive = guidance.phase === 'navigating' || guidance.phase === 'approaching';
  useEffect(() => {
    if (screen !== 'navigate' || !cameraGranted || !route || !guidanceActive) return;
    const key = `${route.routeId}:${guidance.stepIndex}`;
    if (lastVisionStep.current === key) return;
    const timer = window.setTimeout(() => {
      lastVisionStep.current = key; // only once it really ran: a cancelled timer retries on the next render
      guidance.checkStep();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [screen, cameraGranted, route?.routeId, guidance.stepIndex, guidanceActive, guidance.checkStep]);

  useEffect(() => {
    if (screen === 'navigate' && guidance.phase === 'arrived') {
      releaseScreenWakeLock();
      setScreen('arrived');
    }
  }, [guidance.phase, screen]);

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
    setOriginMatches(filtered.slice(0, MAX_OPTIONS));
    return filtered.slice(0, MAX_OPTIONS);
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
    const shown = filtered.slice(0, MAX_OPTIONS);
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
    return filtered.slice(0, MAX_OPTIONS);
  }

  async function chooseOrigin(place: Place): Promise<void> {
    rememberPlace('origin', place);
    setOrigin(place);
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

  async function rerouteFromNode(nodeId: string, roomText: string, token = navToken.current): Promise<void> {
    if (!route) return;
    setBusy(true);
    const result = await api.route({
      from: { type: 'node', nodeId },
      to: { type: 'place', placeId: route.to.id },
      profile,
    });
    setBusy(false);
    // The user stopped or started another trip while this was in flight: do not pull them back in.
    if (token !== navToken.current) return;
    if (!result.ok) {
      announce(`I found ${roomText}, but could not build a new route from there. ${result.message}`);
      return;
    }
    setRoute(result);
    setStartAfterRoute(true);
    setScreen('navigate');
    announce(`Rerouting from ${roomText}.`);
  }

  /** Survey mode: photograph the spot the team member names and add its fingerprint to the library. */
  async function captureSpot(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const query = surveySpot.trim();
    if (!query || !surveyCode) return;
    setSurveyBusy(true);
    setSurveyMessage('');
    try {
      const matches = await fetchPlaces(query);
      const place = matches?.find((p) => sameName(p, query)) ?? matches?.[0];
      if (!place) {
        setSurveyMessage(`No place matches “${query}”.`);
        return;
      }
      let imageJpegBase64: string;
      try {
        imageJpegBase64 = await captureRoomSignFrame(1280);
      } catch {
        setSurveyMessage('The camera is not available. Allow camera access and try again.');
        return;
      }
      const r = await api.captureRef({ imageJpegBase64, placeId: place.id, ...(guidance.headingDeg != null ? { headingDeg: guidance.headingDeg } : {}) }, surveyCode);
      if (!r.ok) {
        setSurveyMessage(r.message);
        return;
      }
      setSurvey((current) => (current ? { ...current, total: r.total } : current));
      setSurveyMessage(`Saved at ${place.name}${r.signs.length ? `, read ${r.signs.join(', ')}` : ''}. ${r.total} spots in the library. Capture the same spot facing the other way too.`);
    } finally {
      setSurveyBusy(false);
    }
  }

  /**
   * "Where am I?": one camera frame plus the graph, answered in plain words ("You are on floor F, at HG F 33.2.
   * The elevator is about 25 metres away."). Planning a trip, the spot becomes the starting point; walking, a
   * confident reading that is off the route reroutes from there. Without a camera it still answers from the route.
   */
  async function locateMe(): Promise<void> {
    const navigating = screen === 'navigate' && route ? route : null;
    const token = navToken.current;
    const prior = navigating ? guidance.currentStep?.startNodeId : (pendingRef.current?.from ?? origin)?.nodeId;
    setThinking(true);
    setMessage('Looking around…');
    let imageJpegBase64: string | undefined;
    if (cameraGranted) {
      try { imageJpegBase64 = await captureRoomSignFrame(1280); } catch { /* answer from the route instead */ }
    }
    const r = await api.where({ imageJpegBase64, nearNodeId: prior, routeId: navigating?.routeId, language: profile.language });
    setThinking(false);
    if (token !== navToken.current && navigating) return; // the user stopped meanwhile
    if (!r.ok) {
      announce(r.message, 'vision');
      return;
    }
    if (r.evidence.length) setGuidanceVision(r.evidence.join(' · '));
    if (navigating) {
      announce(r.description, 'vision');
      if (r.onRoute === false && r.confidence >= 0.75) await rerouteFromNode(r.nodeId, r.place ? displayName(r.place) : 'here', token);
      return;
    }
    // Planning: a spot found from the camera becomes the starting point (the user can still say no).
    if (r.place && r.method !== 'route') {
      const to = pendingRef.current?.to ?? destination ?? undefined;
      setPending({ from: r.place, to: to && to.id !== r.place.id ? to : undefined });
      announce(`${r.description} ${to && to.id !== r.place.id ? `Going to ${displayName(to)}. Is that right?` : 'That is your starting point now. Where do you want to go?'}`, 'info');
    } else announce(r.description, 'info');
  }

  async function checkCamera(trigger: VisionTrigger = 'user_query', quiet = false): Promise<void> {
    const token = navToken.current;
    const wasNavigating = screen === 'navigate';
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
        speak(vision.utterance, 'vision');
      }
      if (vision.offRouteSuspected && vision.detectedRoomNames[0] && wasNavigating && token === navToken.current) {
        const sign = vision.detectedRoomNames[0];
        const localized = await api.localize({ roomText: sign });
        if (token !== navToken.current) return;
        if (localized.ok && localized.confidence >= 0.9) await rerouteFromNode(localized.nodeId, sign, token);
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
    if (screen === 'navigate') {
      guidance.stop();
      releaseScreenWakeLock();
      setScreen('preview');
      return;
    }
    if (screen === 'arrived') {
      setScreen('where');
      return;
    }
    // where / destination / preview are all the one trip screen: Back drops a proposal, but never walks into
    // the old setup screens (permissions, needs), which the one-screen design no longer shows.
    if (pendingRef.current || agentOptions) rejectPending();
    else if (screen !== 'where') setScreen('where');
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
        // Camera + graph on every screen: signs, reference photos and the route, in one spoken sentence.
        await locateMe();
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
          else if (matches.length > 1) announce(`I found ${Math.min(matches.length, MAX_OPTIONS)} starting points: ${listPlaceNames(matches.slice(0, MAX_OPTIONS))}. Say a number.`);
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

  /**
   * Everything said or typed lands here. Commands run one at a time, in order: "I'm in F7 … take me to F30"
   * can arrive as two clips, and the second must see the trip the first one set up, not race it.
   */
  function dispatchCommand(transcript: string): Promise<void> {
    // An emergency, or stop/next while walking, never waits behind a slow agent request.
    const urgent = parseAppCommand(transcript)?.type === 'emergency'
      || /^(stop|cancel|next|repeat|back|help)[.!?]?$/i.test(transcript.trim());
    if (urgent) return latestDispatch.current(transcript).catch(() => undefined);
    const run = dispatchQueue.current
      .then(() => new Promise((resolve) => window.setTimeout(resolve, 0))) // let React commit the previous result
      .then(() => latestDispatch.current(transcript))
      .catch(() => undefined);
    dispatchQueue.current = run;
    return run;
  }

  async function runDispatch(transcript: string): Promise<void> {
    const said = transcript.trim();
    if (!said) return;
    setHeard(said);
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
    // Walking: step commands never wait for the network. "Where am I?" goes straight to the camera anywhere.
    const quick = parseCommand(said);
    if (quick?.type === 'where_am_i') {
      await runIntent(quick);
      return;
    }
    if (screen === 'navigate' || screen === 'arrived') {
      if (quick && ['next', 'back', 'repeat', 'stop', 'whats_ahead', 'help'].includes(quick.type)) {
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

  latestDispatch.current = runDispatch;

  function agentContext() {
    // Once arrived, the user stands at the old destination: that is where any new trip starts.
    const arrivedAt = screen === 'arrived' && route ? route.to : undefined;
    const from = pendingRef.current?.from ?? arrivedAt ?? origin ?? undefined;
    const to = pendingRef.current?.to ?? (arrivedAt ? undefined : destination ?? undefined);
    const phase = pendingRef.current?.from && pendingRef.current.to ? 'confirm' as const
      : screen === 'navigate' ? 'navigate' as const
      : screen === 'arrived' ? 'arrived' as const
      : route && screen === 'preview' ? 'ready' as const
      : 'trip' as const;
    const options = agentOptions?.places ?? (screen === 'where' ? originMatches : destinationMatches);
    return {
      phase,
      ...(from ? { from: { id: from.id, name: from.name } } : {}),
      ...(to ? { to: { id: to.id, name: to.name } } : {}),
      ...(options.length ? { options: options.slice(0, MAX_OPTIONS).map((p) => ({ id: p.id, name: p.name })) } : {}),
      needs: profile.needs,
      avoidStairs: Boolean(profile.avoidStairs),
      ...(screen === 'navigate' && guidance.currentStep ? { step: guidance.currentStep.text, nearNodeId: guidance.currentStep.startNodeId } : {}),
    };
  }

  async function handleAgent(r: Extract<AgentResponse, { ok: true }>): Promise<void> {
    misunderstood.current = 0;
    switch (r.action) {
      case 'set_trip': {
        // Walking, and the user tells us where they are ("I'm at F 33") for the same destination: believe them
        // and reroute from there at once. The person knows where they stand better than the camera or step count.
        if (screen === 'navigate' && route && r.from && !r.options?.length && (!r.to || r.to.id === route.to.id) && r.from.id !== route.to.id) {
          setPending(null);
          setAgentOptions(null);
          announce(`Okay, you are at ${displayName(r.from)}.`);
          await rerouteFromNode(r.from.nodeId, displayName(r.from));
          return;
        }
        // The server already merged what it knew: what it left out (an ambiguous or unknown place) stays out.
        setPending({ from: r.from, to: r.to });
        setAgentOptions(r.options?.length ? { places: r.options, for: r.optionsFor ?? 'to' } : null);
        // While walking, a new trip is only a proposal: guidance keeps going until the user says yes.
        if (screen === 'arrived') setScreen('where');
        announce(screen === 'navigate' && r.from && r.to ? `${r.reply} Say yes to switch, or no to keep going.` : r.reply);
        return;
      }
      case 'confirm':
      case 'start':
        if (pendingRef.current?.from && pendingRef.current.to) await confirmPending();
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
        announce(`${r.reply || 'Got it.'}${origin || pendingRef.current ? '' : ` ${ASK_TRIP}`}`);
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
        // Continuous listening hears hallway chatter: stay quiet while walking rather than talk over guidance.
        if (screen === 'navigate') return;
        announce(r.reply || `Sorry, I did not get that. ${ASK_TRIP}`);
        return;
      default:
        await runIntent({ type: r.action === 'where_am_i' ? 'where_am_i' : r.action === 'whats_ahead' ? 'whats_ahead' : r.action, source: 'llm' } as Intent);
    }
  }

  /** "Yes": the trip the agent proposed becomes the route, and navigation starts right away. */
  async function confirmPending(): Promise<void> {
    const trip = pendingRef.current;
    if (!trip?.from || !trip.to) return;
    setPending(null);
    setAgentOptions(null);
    const next = await createRoute(trip.to, trip.from);
    if (!next) {
      // createRoute said why; keep the proposal so "yes" can be tried again (or "no" to drop it).
      setPending(trip);
      return;
    }
    if (screen === 'navigate') guidance.stop();
    rememberPlace('origin', trip.from);
    setOrigin(trip.from);
    setOriginQuery(trip.from.name);
    beginNavigation(next);
    announce(`Starting. ${shortSummary(next)}`);
  }

  function rejectPending(reply?: string): void {
    setPending(null);
    setAgentOptions(null);
    announce(reply || (screen === 'navigate' ? 'Okay, keeping the current route.' : `Okay. ${ASK_TRIP}`));
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
    const next = { ...pendingRef.current, [agentOptions.for]: place } as { from?: Place; to?: Place };
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
        if (pendingRef.current?.from && pendingRef.current.to) await confirmPending();
        else if (screen === 'preview') beginNavigation();
        else if (screen === 'needs') setScreen('permissions');
        else if (screen === 'permissions') { await enableDevicePermissions(); setScreen('where'); }
        else if (screen === 'arrived') startNewDestination();
        else if (screen === 'destination' && destinationMatches.length === 1) await createRoute(destinationMatches[0]);
        else if (screen === 'where' && originMatches.length === 1) await chooseOrigin(originMatches[0]);
        else announce('Okay.');
        return;
      case 'no':
        if (pendingRef.current) rejectPending();
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
      onPointerDown={() => { if (started && !touched) setTouched(true); }}
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
          <button type="button" className="trip-locate" onClick={() => void locateMe()} disabled={thinking}>
            <span aria-hidden="true">◎</span> {thinking ? 'Looking around…' : 'Where am I? Use the camera'}
          </button>

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
                {optionList.slice(0, MAX_OPTIONS).map((place, index) => (
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
            {confirming && (
              // A new trip proposed while walking: the current route keeps running until the user says yes.
              <div className="hud-controls hud-controls-two" role="group" aria-label="Switch to the new trip?">
                <button type="button" className="hud-pill hud-pill-accent" onClick={() => void confirmPending()}>Yes, switch</button>
                <button type="button" className="hud-pill" onClick={() => rejectPending()}>No, keep going</button>
              </div>
            )}
            {!confirming && (voiceFirst ? (
              // Voice-first keeps only the two buttons that matter when speech fails in a noisy hall.
              <div className="hud-controls hud-controls-two" role="group" aria-label="Navigation controls">
                <button type="button" className="hud-pill hud-pill-accent" onClick={() => guidance.next()}>{guidance.currentStep?.maneuver === 'take_elevator' ? 'Done' : 'Next step'}</button>
                <button type="button" className="hud-pill hud-pill-stop" onClick={() => { guidance.stop(); releaseScreenWakeLock(); setScreen('preview'); }}>Stop</button>
              </div>
            ) : (
              <div className="hud-controls" role="group" aria-label="Navigation controls">
                <button type="button" className="hud-pill" onClick={() => guidance.repeat()}>Repeat</button>
                <button type="button" className="hud-pill hud-pill-accent" onClick={() => guidance.next()}>{guidance.currentStep?.maneuver === 'take_elevator' ? 'Done' : 'Next'}</button>
                <button type="button" className="hud-pill" onClick={() => void runIntent({ type: 'where_am_i', source: 'regex' })}>Where am I?</button>
                <button type="button" className="hud-pill hud-pill-stop" onClick={() => { guidance.stop(); releaseScreenWakeLock(); setScreen('preview'); }}>Stop</button>
              </div>
            ))}
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
          <VoicePicker value={preferences.settings.voiceName} onChange={(voiceName) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, voiceName } }))} />
          <label className="setting-control" htmlFor="speech-rate"><span><strong>Speech rate</strong><small>{preferences.settings.speechRate.toFixed(1)}×</small></span><input id="speech-rate" type="range" min="0.6" max="1.5" step="0.1" value={preferences.settings.speechRate} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: Number(event.target.value) } }))} /></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.speakWithAppVoice} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, speakWithAppVoice: event.target.checked } }))} /><span><strong>Speak with app voice</strong><small>Turn this off when your screen reader already reads the instruction.</small></span></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.beaconEnabled} onChange={(event) => { const enabled = event.target.checked; updatePreferences((current) => ({ ...current, settings: { ...current.settings, beaconEnabled: enabled } })); guidance.setBeaconEnabled(enabled); }} /><span><strong>Audio direction beacon</strong><small>A stereo tick that moves toward the route direction and double-ticks when you face it.</small></span></label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.settings.haptics} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, haptics: event.target.checked } }))} /><span><strong>Vibrate at every step</strong><small>{PATTERN_LEGEND}</small></span></label>
          {preferences.settings.haptics && (
            <button type="button" className="button button-ghost" onClick={() => { buzz(stepPattern('left')); window.setTimeout(() => buzz(stepPattern('right')), 900); announce('Two buzzes: left. Three buzzes: right.'); }}>Try the vibrations</button>
          )}
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
          {survey?.enabled && (
            <form className="setting-control survey" onSubmit={(event) => void captureSpot(event)}>
              <span><strong>Survey: teach PolyGuide this spot</strong><small>Team only. Stand at a room door or landmark, type where you are, point the camera along the corridor, then capture. Only a text description is stored, never the photo. {survey.total} spots saved.</small></span>
              <label className="survey-field"><span>Survey code</span><input type="password" autoComplete="off" value={surveyCode} onChange={(event) => { setSurveyCode(event.target.value); try { localStorage.setItem('polyguide.surveyCode', event.target.value); } catch { /* private mode */ } }} /></label>
              <label className="survey-field"><span>Where you stand</span><input value={surveySpot} placeholder="e.g. HG F 33.2 or main entrance" autoComplete="off" onChange={(event) => setSurveySpot(event.target.value)} /></label>
              <button className="button button-accent" type="submit" disabled={surveyBusy || !surveyCode || !surveySpot.trim()}>{surveyBusy ? 'Saving…' : 'Capture this spot'}</button>
              {surveyMessage && <p className="survey-message" role="status">{surveyMessage}</p>}
            </form>
          )}
        </main>
      )}

      {started && emergencyOpen && (
        <div className="sheet-backdrop" role="presentation">
          <section className="emergency-panel" role="alertdialog" aria-modal="true" aria-labelledby="emergency-title" aria-describedby="emergency-location">
            <h2 id="emergency-title" tabIndex={-1}>Emergency</h2>
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
        <VoiceBar
          ref={voiceBarRef}
          voiceFirst={voiceFirst}
          continuous={screen === 'navigate' || voiceFirst || !touched}
          language={profile.language ?? 'en'}
          onCommand={(transcript) => { void dispatchCommand(transcript); }}
        />
      </footer>
    </div>
  );
}
