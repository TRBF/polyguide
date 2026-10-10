import type { Need, Place, Profile } from '@polyguide/shared';

export interface AppSettings {
  voiceFirst: boolean;
  speechRate: number;
  speakWithAppVoice: boolean;
  beaconEnabled: boolean;
  stepLengthM: number;
  /** speechSynthesis voice name; null = pick the best voice for the language automatically. */
  voiceName: string | null;
  /** Short vibration on each new instruction (Android; iOS has no web vibration). */
  haptics: boolean;
  /** Whole-interface zoom for low vision, independent of the low-vision route profile. */
  textScale: 1 | 1.25 | 1.5;
  /** Camera/motion/mic were granted once; the start tap re-requests them silently. */
  permissionsGranted: boolean;
  /** Speech-to-speech agent (OpenAI Realtime) that also sees the camera; off = recognizer + text agent. */
  realtimeVoice: boolean;
}

export interface Preferences {
  profile: Profile;
  settings: AppSettings;
}

const STORAGE_KEY = 'polyguide.preferences.v1';

export const defaultPreferences: Preferences = {
  profile: { needs: [], language: 'en', stepLengthM: 0.7 },
  settings: {
    voiceFirst: false,
    speechRate: 1,
    speakWithAppVoice: true,
    beaconEnabled: true,
    stepLengthM: 0.7,
    voiceName: null,
    haptics: true,
    textScale: 1,
    permissionsGranted: false,
    realtimeVoice: true,
  },
};

const validNeeds: Need[] = ['wheelchair', 'blind', 'lowVision', 'lowStamina', 'avoidCrowds'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function loadPreferences(): Preferences {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return defaultPreferences;
    const parsed: unknown = JSON.parse(saved);
    if (!isRecord(parsed)) return defaultPreferences;
    const profileData = isRecord(parsed.profile) ? parsed.profile : {};
    const settingsData = isRecord(parsed.settings) ? parsed.settings : {};
    const needs = Array.isArray(profileData.needs)
      ? profileData.needs.filter((need): need is Need => validNeeds.includes(need as Need))
      : [];
    const stepLengthM = Number(settingsData.stepLengthM ?? profileData.stepLengthM ?? 0.7);
    const rate = Number(settingsData.speechRate ?? 1);
    return {
      profile: {
        needs,
        avoidStairs: profileData.avoidStairs === true,
        language: profileData.language === 'de' ? 'de' : 'en',
        stepLengthM: Number.isFinite(stepLengthM) ? Math.min(1.5, Math.max(0.3, stepLengthM)) : 0.7,
      },
      settings: {
        voiceFirst: typeof settingsData.voiceFirst === 'boolean' ? settingsData.voiceFirst : needs.includes('blind'),
        speechRate: Number.isFinite(rate) ? Math.min(1.5, Math.max(0.6, rate)) : 1,
        speakWithAppVoice: settingsData.speakWithAppVoice !== false,
        beaconEnabled: settingsData.beaconEnabled !== false,
        stepLengthM: Number.isFinite(stepLengthM) ? Math.min(1.5, Math.max(0.3, stepLengthM)) : 0.7,
        voiceName: typeof settingsData.voiceName === 'string' && settingsData.voiceName ? settingsData.voiceName : null,
        haptics: settingsData.haptics !== false,
        textScale: settingsData.textScale === 1.25 || settingsData.textScale === 1.5 ? settingsData.textScale : 1,
        permissionsGranted: settingsData.permissionsGranted === true,
        realtimeVoice: settingsData.realtimeVoice !== false,
      },
    };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage may be disabled or full. The app remains usable for this session.
  }
}

/** True once the user has finished onboarding on this device (returning users skip the needs screen). */
export function hasSavedPreferences(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/* ───────── Recent places (spec §6.1 "recent destinations") ───────── */

const RECENTS_KEY = 'polyguide.recents.v1';
const MAX_RECENTS = 4;
export type RecentKind = 'origin' | 'destination';
type Recents = Record<RecentKind, Place[]>;

function loadRecents(): Recents {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? 'null');
    if (isRecord(parsed)) {
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is Place => isRecord(p) && typeof p.id === 'string' && typeof p.name === 'string').slice(0, MAX_RECENTS) : []);
      return { origin: list(parsed.origin), destination: list(parsed.destination) };
    }
  } catch {
    // ignore
  }
  return { origin: [], destination: [] };
}

export function recentPlaces(kind: RecentKind): Place[] {
  return loadRecents()[kind];
}

export function rememberPlace(kind: RecentKind, place: Place): void {
  if (place.id.startsWith('node:')) return; // ad-hoc points (GPS, reroutes) are not places worth recalling
  try {
    const all = loadRecents();
    all[kind] = [place, ...all[kind].filter((p) => p.id !== place.id)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(all));
  } catch {
    // Storage may be unavailable; recents are a convenience only.
  }
}

export function clearRecents(): void {
  try {
    localStorage.removeItem(RECENTS_KEY);
  } catch {
    // ignore
  }
}

/* ───────── Last known position (the voice agent's starting hint on the next visit) ───────── */

const LAST_FIX_KEY = 'polyguide.lastFix.v1';
/** Older than this, the remembered position says nothing about where the user is. */
const LAST_FIX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function saveLastFix(place: Place, at: number): void {
  if (place.id.startsWith('node:')) return;
  try {
    localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ place, at }));
  } catch {
    // A convenience only.
  }
}

export function loadLastFix(now = Date.now()): { place: Place; at: number } | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_FIX_KEY) ?? 'null');
    if (!isRecord(parsed) || !isRecord(parsed.place) || typeof parsed.at !== 'number') return null;
    const place = parsed.place as unknown as Place;
    if (typeof place.id !== 'string' || typeof place.name !== 'string' || now - parsed.at > LAST_FIX_MAX_AGE_MS) return null;
    return { place, at: parsed.at };
  } catch {
    return null;
  }
}
