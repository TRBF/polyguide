import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  type Intent,
  type IntentRequest,
  type Need,
  type Place,
  type RouteResult,
  type VisionTrigger,
} from '@polyguide/shared';
import { api } from './api';
import { captureRoomSignFrame, releaseScreenWakeLock, requestAppPermissions, requestScreenWakeLock } from './camera';
import { RouteMap } from './RouteMap';
import { VoiceBar, type VoiceBarHandle } from './VoiceBar';
import { configureSpeech, speak, stopSpeech } from './voice/tts';
import { parseCommand } from './voice/commands';
import { loadPreferences, savePreferences, type Preferences } from './storage';
import { useGuidance } from './guidance';
import './styles.css';

type Route = Extract<RouteResult, { ok: true }>;
type Screen = 'needs' | 'permissions' | 'where' | 'destination' | 'preview' | 'navigate' | 'arrived' | 'settings';
const safetyNotice = 'This app supplements your cane or guide dog. It does not detect obstacles.';
const stepNames: Record<Screen, string> = {
  needs: 'Your needs',
  permissions: 'Device permissions',
  where: 'Where are you?',
  destination: 'Where to?',
  preview: 'Route preview',
  navigate: 'Navigate',
  arrived: 'Arrived',
  settings: 'Settings',
};
const entrySpeech: Record<Screen, string> = {
  needs: `Welcome to PolyGuide. ${safetyNotice} Choose your access needs. Say help for options.`,
  permissions: 'Device permissions. Enable camera, motion, microphone and screen wake, or continue using touch and typed commands.',
  where: 'Where are you? Search for a room, scan a room sign, or use GPS outdoors. Say help for options.',
  destination: 'Where to? Search for a room or point of interest. Say take me to and a room name, or say help.',
  preview: 'Route preview. Review the route and steps, then say start or touch the Start button. Say help for options.',
  navigate: 'Navigation started. Say next, back, repeat, where am I, what is ahead, stop, or help.',
  arrived: 'You have arrived. Say new destination or touch the button to continue.',
  settings: 'Settings. Adjust speech, voice mode, beacon and step length. Say back to return.',
};

function placeLabel(place: Place): string {
  return place.label ? `${place.name} — ${place.label}` : place.name;
}

const compact = (value: string) => value.toUpperCase().replace(/[\s.\-_,]+/g, '');

/** "hg f 30" / "F30" / "Audimax" name this place exactly (not HG F 30.1). */
function sameName(place: Place, query: string): boolean {
  const q = compact(query);
  if (!q) return false;
  return [place.name, place.label ?? '', ...place.aliases].some((name) => {
    const n = compact(name);
    return n === q || (n.startsWith('HG') && n.slice(2) === q);
  });
}

function listPlaceNames(places: Place[]): string {
  return places.map((place, index) => `${index + 1}, ${place.label ? `${place.name}, ${place.label}` : place.name}`).join('; ');
}

export function App() {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [started, setStarted] = useState(false);
  const [screen, setScreen] = useState<Screen>('needs');
  const [screenBeforeSettings, setScreenBeforeSettings] = useState<Screen>('needs');
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

  const profile = useMemo(() => ({
    ...preferences.profile,
    needs: [...preferences.profile.needs],
    stepLengthM: preferences.settings.stepLengthM,
  }), [preferences]);

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
    configureSpeech({ enabled: preferences.settings.speakWithAppVoice, rate: preferences.settings.speechRate });
  }, [preferences]);

  useEffect(() => {
    // The welcome is spoken from the start button's click (browsers block speech before a gesture).
    if (!started || screen === 'needs') return;
    if (!preferences.settings.voiceFirst) return;
    if (screen === 'preview' && route) {
      const minutes = Math.max(1, Math.round(route.totalDurationS / 60));
      const summary = [`Route to ${route.to.name}: ${Math.round(route.totalDistanceM)} metres, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, ...route.profileSummary.map((s) => `${s}.`), ...route.warnings].join(' ');
      announce(`${summary} ${entrySpeech.preview}`, 'info');
      return;
    }
    announce(entrySpeech[screen], 'info');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announce, started, preferences.settings.voiceFirst, screen, route?.routeId]);

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

  function beginApp(): void {
    setStarted(true);
    speak(entrySpeech.needs, 'info');
  }

  useEffect(() => {
    if (startAfterRoute && screen === 'navigate' && route) {
      guidance.start();
      setStartAfterRoute(false);
    }
  }, [guidance.start, route?.routeId, screen, startAfterRoute]);

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

  async function createRoute(target: Place, fromPlace: Place | null = origin): Promise<void> {
    if (!fromPlace) {
      setDestination(target);
      setDestinationQuery(target.name);
      setScreen('where');
      announce(`Destination selected: ${target.name}. First, choose where you are.`);
      return;
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
      return;
    }
    setMessage('');
    setDestination(target);
    setRoute(result);
    setSelectedLevel(result.levels[0] ?? target.levelId);
    setDestinationMatches([]);
    setScreen('preview');
  }

  /** Server errors are announced, never replaced by stale or fake results. */
  async function fetchPlaces(query: string): Promise<Place[] | null> {
    try {
      return await api.places(query);
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
    const filtered = matches.filter((place) => place.kind === 'room' || place.kind === 'entrance' || place.kind === 'poi');
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
    setBusy(true);
    const found = await fetchPlaces(searchText);
    setBusy(false);
    if (!found) return [];
    const filtered = found.filter((place) => place.kind === 'room' || place.kind === 'poi');
    const shown = filtered.slice(0, 5);
    setDestinationMatches(shown);
    // A spoken room code that names a room exactly ("HG F 30", "F 30") needs no disambiguation.
    const exact = shown.find((place) => sameName(place, searchText));
    // Several places with the same name (toilets, elevators) can't be told apart by voice; choose by distance.
    const indistinct = shown.length > 1 && new Set(shown.map(placeLabel)).size === 1;
    if (filtered.length && origin && !exact && (nearest || indistinct)) {
      setBusy(true);
      const best = await quickestOf(filtered.slice(0, 8), origin);
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
    setOrigin(place);
    setOriginQuery(place.name);
    setOriginMatches([]);
    announce(`Starting point set to ${place.name}.`);
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

  async function checkCamera(trigger: VisionTrigger = 'user_query'): Promise<void> {
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
      announce(text, 'vision');
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

  async function enableDevicePermissions(): Promise<void> {
    setPermissionBusy(true);
    setPermissionMessage('Requesting device permissions…');
    const permissions = await requestAppPermissions();
    setPermissionBusy(false);
    setCameraGranted(permissions.includes('camera'));
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

  async function dispatchCommand(transcript: string): Promise<void> {
    const normalizedCommand = transcript.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,]+$/g, '');
    if (/^(open )?settings$/.test(normalizedCommand)) {
      openSettings();
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

    const parsed = parseCommand(transcript);
    const screenKey: IntentRequest['screen'] = screen === 'where' ? 'start' : screen === 'permissions' ? 'needs' : screen;
    const intent: Intent = parsed ?? await api.intent({ utterance: transcript, screen: screenKey, language: profile.language });
    switch (intent.type) {
      case 'help':
        announce('You can say: next, back, repeat, stop, help, where am I, what is ahead, take me to a room, or I am at a room. You can also type the same commands.');
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
          guidance.whereAmI();
          if (!cameraGranted) announce('Enable camera access to check a room sign. You can also say scan sign.', 'vision');
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
        announce('I did not understand that command. Say help for examples, or type the command.');
    }
  }

  function beginNavigation(): void {
    if (!route) return;
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

  if (!started) {
    return (
      <div className="app-shell">
        <main className="main-content">
          <button type="button" className="button button-primary start-gate" onClick={beginApp} autoFocus>
            Tap here to start PolyGuide
          </button>
          <p className="lead">PolyGuide helps you find your way inside ETH Zürich. It supplements your cane or guide dog and does not detect obstacles.</p>
        </main>
      </div>
    );
  }

  return (
    <div className={`app-shell${preferences.settings.voiceFirst ? ' app-voice-first' : ''}${profile.needs.includes('lowVision') ? ' app-low-vision' : ''}`}>
      <header className="app-header">
        <a className="brand" href="#top" onClick={(event) => event.preventDefault()} aria-label="PolyGuide home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span><strong>PolyGuide</strong><small>ETH Zürich · HG</small></span>
        </a>
        <div className="header-actions">
          <button type="button" className="button button-quiet" onClick={() => announce('You can say next, back, repeat, stop, help, where am I, what is ahead, take me to a room, or I am at a room.')}>Help</button>
          <button type="button" className="button button-quiet" onClick={openSettings}>Settings</button>
        </div>
      </header>

      <main id="top" className="main-content">
        <div className="screen-kicker">{stepNames[screen]}</div>
        {message && <p className="global-message" role="status" aria-live="polite">{message}</p>}

        {screen === 'needs' && (
          <section className="screen-panel" aria-labelledby="needs-title">
            <h1 id="needs-title">A route that fits your needs</h1>
            <p className="lead">Choose any combination. PolyGuide adjusts routes around the access needs you select.</p>
            <div className="safety-notice" role="note">
              <span className="notice-icon" aria-hidden="true">!</span>
              <p><strong>Safety notice</strong><br />{safetyNotice}</p>
            </div>
            <fieldset className="needs-list">
              <legend>Route preferences</legend>
              {preferenceToggle('wheelchair', 'Wheelchair', 'Prefer step-free routes and elevators.')}
              {preferenceToggle('blind', 'Blind', 'Get voice-first turn guidance and fewer complex turns.')}
              {preferenceToggle('lowVision', 'Low vision', 'Use large type and high contrast.')}
              <label className="need-option">
                <input type="checkbox" checked={Boolean(profile.avoidStairs)} onChange={(event) => updatePreferences((current) => ({ ...current, profile: { ...current.profile, avoidStairs: event.target.checked } }))} />
                <span className="need-copy"><strong>Avoid stairs</strong><small>Exclude stairs for this route.</small></span>
              </label>
              <label className="need-option need-disabled">
                <input type="checkbox" disabled aria-describedby="stamina-explainer" />
                <span className="need-copy"><strong>Low stamina <span className="soon-tag">Coming soon</span></strong><small id="stamina-explainer">Routes with shorter distances between rest points.</small></span>
              </label>
              <label className="need-option need-disabled">
                <input type="checkbox" disabled aria-describedby="crowds-explainer" />
                <span className="need-copy"><strong>Avoid crowds <span className="soon-tag">Coming soon</span></strong><small id="crowds-explainer">Routes using live crowd levels.</small></span>
              </label>
            </fieldset>
            <label className="toggle-row">
              <input type="checkbox" checked={preferences.settings.voiceFirst} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, voiceFirst: event.target.checked } }))} />
              <span><strong>Voice-first mode</strong><small>Announce each screen and keep the microphone control large.</small></span>
            </label>
            <div className="screen-actions">
              <button className="button button-primary" type="button" onClick={() => setScreen('permissions')}>Continue</button>
            </div>
          </section>
        )}

        {screen === 'permissions' && (
          <section className="screen-panel" aria-labelledby="permissions-title">
            <h1 id="permissions-title">Enable the tools you want to use</h1>
            <p className="lead">One tap requests camera, motion, microphone, and screen wake access. You can continue if a permission is unavailable.</p>
            <ul className="permission-list">
              <li><strong>Camera:</strong> read room signs and describe nearby landmarks when you ask.</li>
              <li><strong>Motion:</strong> estimate walking progress and heading where supported.</li>
              <li><strong>Microphone:</strong> listen to commands when you start voice input.</li>
              <li><strong>Screen wake:</strong> keep the display awake during navigation where supported.</li>
            </ul>
            <p className="privacy-note">Camera frames are sent for a check and are not stored by PolyGuide. The app does not detect obstacles.</p>
            <div className="permission-actions">
              <button className="button button-primary" type="button" onClick={() => void enableDevicePermissions()} disabled={permissionBusy}>
                {permissionBusy ? 'Requesting permissions…' : 'Enable camera, motion and microphone'}
              </button>
              <button className="button button-secondary" type="button" onClick={() => setScreen('where')}>Continue without permissions</button>
            </div>
            {permissionMessage && <p className="form-note" role="status">{permissionMessage}</p>}
            <div className="screen-actions"><button className="button button-secondary" type="button" onClick={() => setScreen('where')}>Continue</button></div>
          </section>
        )}

        {screen === 'where' && (
          <section className="screen-panel" aria-labelledby="where-title">
            <h1 id="where-title">Where are you?</h1>
            <p className="lead">Search for your room, scan a room sign, or use GPS outdoors. Indoor GPS is not used.</p>
            {origin && <p className="selection-card"><span className="selection-label">Starting point</span><strong>{placeLabel(origin)}</strong></p>}
            <form className="search-form" onSubmit={submitOrigin}>
              <label htmlFor="origin-search">Room or entrance</label>
              <div className="search-row">
                <input id="origin-search" value={originQuery} onChange={(event) => setOriginQuery(event.target.value)} placeholder="For example, HG E 41" autoComplete="off" />
                <button className="button button-primary" type="submit" disabled={busy || !originQuery.trim()}>Search</button>
              </div>
            </form>
            <div className="action-row">
              <button className="button button-secondary" type="button" onClick={() => void scanForLocation()} disabled={cameraBusy}>
                {cameraBusy ? 'Checking sign…' : 'Scan a room sign'}
              </button>
              <button className="button button-secondary" type="button" onClick={() => void useOutdoorGps()} disabled={busy}>Use GPS outdoors</button>
            </div>
            {cameraMessage && <p className="form-note" role="status">{cameraMessage}</p>}
            {originMatches.length > 0 && (
              <div className="results-block" aria-label="Starting point results">
                <h2>Choose a starting point</h2>
                <ul className="result-list">{originMatches.map((place, index) => <li key={place.id}><button className="result-button" type="button" onClick={() => void chooseOrigin(place)}><span className="result-number">{index + 1}</span><span>{placeLabel(place)}</span></button></li>)}</ul>
              </div>
            )}
            <div className="screen-actions split-actions">
              <button className="button button-secondary" type="button" onClick={moveBack}>Back</button>
              <button className="button button-primary" type="button" onClick={() => setScreen('destination')} disabled={!origin}>Continue</button>
            </div>
          </section>
        )}

        {screen === 'destination' && (
          <section className="screen-panel" aria-labelledby="destination-title">
            <h1 id="destination-title">Where to?</h1>
            <p className="lead">Search rooms and points of interest in ETH Zürich’s HG building.</p>
            {origin && <p className="route-endpoint"><span>From</span><strong>{origin.name}</strong></p>}
            {destination && <p className="selection-card"><span className="selection-label">Destination</span><strong>{placeLabel(destination)}</strong></p>}
            <form className="search-form" onSubmit={submitDestination}>
              <label htmlFor="destination-search">Room or point of interest</label>
              <div className="search-row">
                <input id="destination-search" value={destinationQuery} onChange={(event) => setDestinationQuery(event.target.value)} placeholder="For example, HG F 30 or toilet" autoComplete="off" />
                <button className="button button-primary" type="submit" disabled={busy || !destinationQuery.trim()}>Search</button>
              </div>
            </form>
            {destinationMatches.length > 0 && (
              <div className="results-block" aria-label="Destination results">
                <h2>{destinationMatches.length > 1 ? `Choose one of ${destinationMatches.length} matches` : 'Choose destination'}</h2>
                <ul className="result-list">{destinationMatches.map((place, index) => <li key={place.id}><button className="result-button" type="button" onClick={() => void createRoute(place)}><span className="result-number">{index + 1}</span><span>{placeLabel(place)}{place.useType && <small>{place.useType}</small>}</span></button></li>)}</ul>
              </div>
            )}
            <div className="quick-destinations">
              <h2>Popular in the demo</h2>
              <button className="quick-destination" type="button" onClick={() => { setDestinationQuery('HG F 30'); void findDestinations('HG F 30', true); }}>HG F 30 <span>Audimax</span></button>
              <button className="quick-destination" type="button" onClick={() => { setDestinationQuery('HG E 41'); void findDestinations('HG E 41', true); }}>HG E 41 <span>Seminar room</span></button>
            </div>
            <div className="screen-actions split-actions">
              <button className="button button-secondary" type="button" onClick={moveBack}>Back</button>
              {route && <button className="button button-primary" type="button" onClick={() => setScreen('preview')}>Review route</button>}
            </div>
          </section>
        )}

        {screen === 'preview' && route && (
          <section className="screen-panel screen-panel-wide" aria-labelledby="preview-title">
            <h1 id="preview-title">Route preview</h1>
            <p className="lead">From <strong>{route.from.name}</strong> to <strong>{route.to.name}</strong></p>
            <div className="route-stats">
              <div><span>Distance</span><strong>{Math.round(route.totalDistanceM)} m</strong></div>
              <div><span>Estimated time</span><strong>{Math.max(1, Math.round(route.totalDurationS / 60))} min</strong></div>
              <div><span>Floors</span><strong>{route.levels.map((level) => level.split('.').at(-1)).join(' → ')}</strong></div>
            </div>
            <div className="guarantee-list" aria-label="Route profile guarantees">
              {route.profileSummary.map((summary) => <span className="guarantee-chip" key={summary}>{summary}</span>)}
              {route.warnings.map((warning) => <p className="warning-line" key={warning}>{warning}</p>)}
            </div>
            <section className="floor-map-panel" aria-labelledby="floor-map-title">
              <div className="section-heading-row">
                <h2 id="floor-map-title">Floor map</h2>
                <label className="floor-picker">Show floor
                  <select value={selectedLevel} onChange={(event) => setSelectedLevel(event.target.value)}>
                    {route.levels.map((level) => <option value={level} key={level}>Floor {level.split('.').at(-1) ?? level}</option>)}
                  </select>
                </label>
              </div>
              <RouteMap route={route} levelId={selectedLevel || route.levels[0]} />
            </section>
            <section className="step-list-section" aria-labelledby="steps-title">
              <h2 id="steps-title">Route steps</h2>
              <ol className="step-list">{route.steps.map((step) => <li key={step.index}>
                <span className="step-index">{step.index + 1}</span>
                <div><strong>{step.text}</strong><small>{step.distanceM ? `${Math.round(step.distanceM)} m · ` : ''}Floor {step.levelId.split('.').at(-1)}{step.toLevelId ? ` to floor ${step.toLevelId.split('.').at(-1)}` : ''}</small></div>
              </li>)}</ol>
            </section>
            <div className="screen-actions split-actions">
              <button className="button button-secondary" type="button" onClick={moveBack}>Back</button>
              <button className="button button-primary" type="button" onClick={beginNavigation}>Start navigation</button>
            </div>
          </section>
        )}

        {screen === 'navigate' && route && (
          <section className="screen-panel navigate-panel" aria-labelledby="navigate-title">
            <div className="navigate-heading-row">
              <div><h1 id="navigate-title">Navigate to {route.to.name}</h1><p className="eyebrow">Step {Math.min(guidance.stepIndex + 1, route.steps.length)} of {route.steps.length}</p></div>
              <button className="button button-quiet" type="button" onClick={openSettings}>Settings</button>
            </div>
            <div className="compass-card">
              <div className="compass-arrow-wrap">
                <span className="compass-arrow" aria-hidden="true" style={{ transform: `rotate(${guidance.headingDeltaDeg ?? 0}deg)` }}>↑</span>
              </div>
              <p className="compass-status">{guidance.compassReliable ? 'Heading available' : 'Compass unreliable — use the spoken or written direction cue.'}</p>
            </div>
            <div className="instruction-card">
              <p className="eyebrow">Current instruction</p>
              <p className="current-instruction">{guidance.currentStep?.text ?? 'Follow the next route step.'}</p>
              <div className="progress-row">
                <span>{Math.round(guidance.remainingStepM)} m remaining on this step</span>
                <span>{Math.round(guidance.remainingTotalM)} m total</span>
              </div>
              <progress aria-label="Current step progress" max={Math.max(1, guidance.currentStep?.distanceM ?? 1)} value={Math.max(0, (guidance.currentStep?.distanceM ?? 0) - guidance.remainingStepM)} />
              {guidance.nextStep && <p className="next-instruction"><strong>Next:</strong> {guidance.nextStep.text}</p>}
            </div>
            <div className="navigation-controls" aria-label="Navigation controls">
              <button className="button button-nav" type="button" onClick={() => guidance.repeat()}>Repeat</button>
              <button className="button button-nav button-primary" type="button" onClick={() => guidance.next()}>{guidance.currentStep?.maneuver === 'take_elevator' ? 'Done with elevator' : 'Next'}</button>
              <button className="button button-nav" type="button" onClick={() => guidance.whereAmI()}>Where am I?</button>
              <button className="button button-nav button-stop" type="button" onClick={() => { guidance.stop(); releaseScreenWakeLock(); setScreen('preview'); }}>Stop</button>
            </div>
            <div className="camera-card">
              <div className="camera-preview" aria-hidden="true">
                {cameraFramePreview ? <img src={cameraFramePreview} alt="" /> : <span>⌖</span>}
                {(cameraBusy || guidance.visionBusy) && <span className="camera-checking">Checking…</span>}
              </div>
              <div><strong>Camera guidance</strong><p>{cameraBusy || guidance.visionBusy ? 'Checking…' : guidance.lastVision?.sceneSummary || cameraMessage || 'The camera checks automatically near each turn.'}</p>{guidanceVision && <p className="vision-summary">{guidanceVision}</p>}</div>
              <button className="button button-secondary" type="button" onClick={() => void checkCamera('user_query')} disabled={cameraBusy || !cameraGranted}>{cameraBusy ? 'Checking…' : 'Check camera'}</button>
            </div>
            <div className="sr-only" aria-live="assertive" aria-atomic="true">{liveGuidanceAnnouncement}</div>
          </section>
        )}

        {screen === 'arrived' && (
          <section className="screen-panel arrival-panel" aria-labelledby="arrived-title">
            <div className="arrival-mark" aria-hidden="true">✓</div>
            <h1 id="arrived-title">You’ve arrived</h1>
            <p className="lead">{destination?.name ?? route?.to.name ?? 'Your destination'}{(() => {
              const side = route?.steps.at(-1)?.side;
              return side === 'left' || side === 'right' ? ` is on your ${side}.` : side === 'ahead' ? ' is ahead of you.' : '.';
            })()}</p>
            <p>Keep your cane or guide dog with you. PolyGuide does not detect obstacles.</p>
            <div className="screen-actions"><button className="button button-primary" type="button" onClick={startNewDestination}>Choose a new destination</button></div>
          </section>
        )}

        {screen === 'settings' && (
          <section className="screen-panel" aria-labelledby="settings-title">
            <h1 id="settings-title">Settings</h1>
            <p className="lead">These preferences are saved on this device.</p>
            <label className="setting-control" htmlFor="speech-rate"><span><strong>Speech rate</strong><small>{preferences.settings.speechRate.toFixed(1)}×</small></span><input id="speech-rate" type="range" min="0.6" max="1.5" step="0.1" value={preferences.settings.speechRate} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, speechRate: Number(event.target.value) } }))} /></label>
            <label className="toggle-row"><input type="checkbox" checked={preferences.settings.speakWithAppVoice} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, speakWithAppVoice: event.target.checked } }))} /><span><strong>Speak with app voice</strong><small>Turn this off when your screen reader already reads the instruction.</small></span></label>
            <label className="toggle-row"><input type="checkbox" checked={preferences.settings.beaconEnabled} onChange={(event) => { const enabled = event.target.checked; updatePreferences((current) => ({ ...current, settings: { ...current.settings, beaconEnabled: enabled } })); guidance.setBeaconEnabled(enabled); }} /><span><strong>Audio direction beacon</strong><small>A stereo tick that moves toward the route direction and double-ticks when you face it.</small></span></label>
            <label className="setting-control" htmlFor="step-length"><span><strong>Step length</strong><small>{preferences.settings.stepLengthM.toFixed(1)} m</small></span><input id="step-length" type="range" min="0.3" max="1.5" step="0.1" value={preferences.settings.stepLengthM} onChange={(event) => updatePreferences((current) => ({ ...current, settings: { ...current.settings, stepLengthM: Number(event.target.value) }, profile: { ...current.profile, stepLengthM: Number(event.target.value) } }))} /></label>
            <div className="screen-actions split-actions"><button className="button button-secondary" type="button" onClick={moveBack}>Back</button><button className="button button-primary" type="button" onClick={moveBack}>Done</button></div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        {screen !== 'needs' && screen !== 'settings' && <button type="button" className="button button-quiet footer-back" onClick={moveBack}>Back</button>}
        <VoiceBar
          ref={voiceBarRef}
          voiceFirst={preferences.settings.voiceFirst}
          continuous={screen === 'navigate'}
          language={profile.language ?? 'en'}
          onCommand={(transcript) => { void dispatchCommand(transcript); }}
        />
      </footer>
    </div>
  );
}
