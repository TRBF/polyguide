import type { Need, Profile } from '@polyguide/shared';

export interface AppSettings {
  voiceFirst: boolean;
  speechRate: number;
  speakWithAppVoice: boolean;
  beaconEnabled: boolean;
  stepLengthM: number;
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
