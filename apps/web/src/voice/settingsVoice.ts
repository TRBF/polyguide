/**
 * Settings by voice alone: an instant local parser (no network, works offline) and one applier used by every
 * voice path — the local parser, the voice agent (set_setting) and the realtime agent (change_setting tool).
 */
import { isValidSettingChange, type SettingChange } from '@polyguide/shared';
import type { Preferences } from '../storage';

const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim();

const ON = String.raw`(?:turn on|switch on|enable|activate|start|put on|einschalten|aktivieren|an)`;
const OFF = String.raw`(?:turn off|switch off|disable|deactivate|stop|no more|ausschalten|deaktivieren|aus)`;

type Rule = [RegExp, SettingChange | 'read'];

const RULES: Rule[] = [
  [/^(?:what are my settings|read (?:me )?(?:my |the )?settings|current settings|my settings|settings status|welche einstellungen)$/, 'read'],
  // Speech rate
  [/^(?:speak|talk|read)(?: a bit| a little)? (?:more )?(?:slower|slowly)(?: please)?$|^(?:slower|slow down)(?: please)?$|^(?:langsamer)(?: bitte)?$/, { setting: 'speech_rate', value: 'down' }],
  [/^(?:speak|talk|read)(?: a bit| a little)? (?:faster|quicker|more quickly)(?: please)?$|^(?:faster|speed up)(?: please)?$|^(?:schneller)(?: bitte)?$/, { setting: 'speech_rate', value: 'up' }],
  [/^(?:normal|default|reset(?: the)?) (?:speech )?speed$|^speak normally$/, { setting: 'speech_rate', value: 'reset' }],
  // Voice-only (voice-first) mode
  [new RegExp(String.raw`^(?:${ON} (?:the )?voice[- ]?(?:only|first) mode|voice[- ]?(?:only|first) mode on|voice only|nur sprache)$`), { setting: 'voice_only', value: 'on' }],
  [new RegExp(String.raw`^(?:${OFF} (?:the )?voice[- ]?(?:only|first) mode|voice[- ]?(?:only|first) mode off|show (?:me )?(?:the )?(?:full )?screen|normal mode)$`), { setting: 'voice_only', value: 'off' }],
  // Vibration
  [new RegExp(String.raw`^(?:${ON} (?:the )?(?:vibrations?|haptics?|buzzing)|vibrate(?: on)?|vibration on)$`), { setting: 'vibration', value: 'on' }],
  [new RegExp(String.raw`^(?:${OFF} (?:the )?(?:vibrations?|haptics?|buzzing)|stop vibrating|no vibrations?|vibrations? off|vibration aus)$`), { setting: 'vibration', value: 'off' }],
  // Direction beacon
  [new RegExp(String.raw`^(?:${ON} (?:the )?(?:beacon|beeps?|beeping|ticking|direction (?:sound|beep))|beacon on)$`), { setting: 'beacon', value: 'on' }],
  [new RegExp(String.raw`^(?:${OFF} (?:the )?(?:beacon|beeps?|beeping|ticking|direction (?:sound|beep))|stop (?:the )?(?:beeping|ticking|beep)|beacon off|no (?:more )?beeping)$`), { setting: 'beacon', value: 'off' }],
  // App voice (only explicit: "stop talking" means "be quiet now", not "never speak again")
  [new RegExp(String.raw`^(?:${ON} (?:the )?(?:app )?voice|unmute(?: the app)?|speak again|start talking again)$`), { setting: 'app_voice', value: 'on' }],
  [new RegExp(String.raw`^(?:${OFF} (?:the )?app voice|mute (?:the )?app(?: voice)?|my screen reader reads(?: it)?)$`), { setting: 'app_voice', value: 'off' }],
  // Text size
  [/^(?:bigger|larger|increase(?: the)?) (?:text|font|letters|text size)$|^(?:make (?:the )?(?:text|font|letters) )?(?:bigger|larger)$|^zoom in$|^gr(?:ö|oe)ssere schrift$/, { setting: 'text_size', value: 'up' }],
  [/^(?:smaller|decrease(?: the)?) (?:text|font|letters|text size)$|^(?:make (?:the )?(?:text|font|letters) )?smaller$|^zoom out$|^kleinere schrift$/, { setting: 'text_size', value: 'down' }],
  [/^(?:normal|default|reset(?: the)?) (?:text|font) size$/, { setting: 'text_size', value: 'reset' }],
  // Language
  [/^(?:speak|switch to|use|in) german(?: please)?$|^(?:auf )?deutsch(?: bitte)?$|^sprich deutsch$/, { setting: 'language', value: 'de' }],
  [/^(?:speak|switch to|use|in) english(?: please)?$|^(?:auf )?englisch(?: bitte)?$|^english please$/, { setting: 'language', value: 'en' }],
  // Live (conversational) voice
  [new RegExp(String.raw`^(?:${ON} (?:the )?(?:live|conversation(?:al)?|natural|realtime) voice)$`), { setting: 'live_voice', value: 'on' }],
  [new RegExp(String.raw`^(?:${OFF} (?:the )?(?:live|conversation(?:al)?|natural|realtime) voice)$`), { setting: 'live_voice', value: 'off' }],
];

/** A settings command, "read" for "what are my settings", or null. */
export function parseSettingCommand(transcript: string): SettingChange | 'read' | null {
  const text = norm(transcript);
  for (const [re, out] of RULES) if (re.test(text)) return out;
  return null;
}

const RATE_STEP = 0.15;
const TEXT_SCALES = [1, 1.25, 1.5] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AppliedSetting {
  prefs: Preferences;
  /** What to say. Said before the change takes effect when the change silences the app voice. */
  say: string;
  /** The app voice turns off: speak `say` first, then apply. */
  sayFirst?: boolean;
}

/** Pure: the preferences after a voice settings change, and what to say about it. */
export function applySettingChange(prefs: Preferences, change: SettingChange): AppliedSetting | null {
  if (!isValidSettingChange(change)) return null;
  const s = prefs.settings;
  const set = (settings: Partial<Preferences['settings']>, say: string, sayFirst = false): AppliedSetting =>
    ({ prefs: { ...prefs, settings: { ...s, ...settings } }, say, ...(sayFirst ? { sayFirst } : {}) });
  switch (change.setting) {
    case 'speech_rate': {
      const rate = change.value === 'reset' ? 1 : round2(Math.min(1.5, Math.max(0.6, s.speechRate + (change.value === 'up' ? RATE_STEP : -RATE_STEP))));
      if (rate === s.speechRate) return set({}, change.value === 'up' ? 'That is already the fastest speed.' : change.value === 'down' ? 'That is already the slowest speed.' : 'Speed is already normal.');
      return set({ speechRate: rate }, change.value === 'reset' ? 'Normal speed.' : change.value === 'up' ? 'Speaking faster.' : 'Speaking slower.');
    }
    case 'voice_only':
      return change.value === 'on'
        ? set({ voiceFirst: true }, 'Voice-only mode on. The screen is minimal and I am always listening.')
        : set({ voiceFirst: false }, 'Voice-only mode off. The full screen is back.');
    case 'vibration':
      return change.value === 'on' ? set({ haptics: true }, 'Vibration on. Two buzzes mean left, three mean right.') : set({ haptics: false }, 'Vibration off.');
    case 'beacon':
      return change.value === 'on' ? set({ beaconEnabled: true }, 'Direction beep on.') : set({ beaconEnabled: false }, 'Direction beep off.');
    case 'app_voice':
      return change.value === 'on'
        ? set({ speakWithAppVoice: true }, 'App voice on.')
        : set({ speakWithAppVoice: false }, 'App voice off. Your screen reader reads the instructions now. Say turn on the voice to undo.', true);
    case 'text_size': {
      const i = TEXT_SCALES.indexOf(s.textScale);
      const next = change.value === 'reset' ? 1 : TEXT_SCALES[Math.min(TEXT_SCALES.length - 1, Math.max(0, i + (change.value === 'up' ? 1 : -1)))];
      if (next === s.textScale) return set({}, change.value === 'up' ? 'The text is already at its largest.' : change.value === 'down' ? 'The text is already at its smallest.' : 'Text size is already normal.');
      return set({ textScale: next }, next === 1 ? 'Normal text size.' : `Text ${next === 1.5 ? 'at its largest' : 'larger'}.`);
    }
    case 'language':
      return { prefs: { ...prefs, profile: { ...prefs.profile, language: change.value as 'en' | 'de' } }, say: change.value === 'de' ? 'Ich spreche jetzt Deutsch.' : 'Speaking English now.' };
    case 'live_voice':
      return change.value === 'on' ? set({ realtimeVoice: true }, 'Live voice on.') : set({ realtimeVoice: false }, 'Live voice off. I use the simple voice now.');
  }
}

/** "Voice-only mode on. Speech speed normal. …" for "what are my settings". */
export function describeSettings(prefs: Preferences): string {
  const s = prefs.settings;
  const speed = s.speechRate === 1 ? 'normal' : s.speechRate > 1 ? 'faster than normal' : 'slower than normal';
  const text = s.textScale === 1 ? 'normal' : s.textScale === 1.5 ? 'largest' : 'larger';
  return [
    `Voice-only mode ${s.voiceFirst ? 'on' : 'off'}.`,
    `Speech speed ${speed}.`,
    `Vibration ${s.haptics ? 'on' : 'off'}.`,
    `Direction beep ${s.beaconEnabled ? 'on' : 'off'}.`,
    `Text size ${text}.`,
    `Language ${prefs.profile.language === 'de' ? 'German' : 'English'}.`,
    'To change one, say for example: speak slower, or turn off vibration.',
  ].join(' ');
}
