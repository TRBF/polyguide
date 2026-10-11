/**
 * Settings a user can change by voice alone, shared by the local command parser, the voice agent (structured
 * output) and the realtime agent (tool call), so all three speak the same language.
 */
export const VOICE_SETTINGS = ['speech_rate', 'voice_only', 'vibration', 'beacon', 'app_voice', 'text_size', 'language', 'live_voice'] as const;
export type VoiceSetting = (typeof VOICE_SETTINGS)[number];

/** on/off for switches; up/down/reset for speech rate and text size; en/de for language. */
export const SETTING_VALUES = ['on', 'off', 'up', 'down', 'reset', 'en', 'de'] as const;
export type SettingValue = (typeof SETTING_VALUES)[number];

export interface SettingChange {
  setting: VoiceSetting;
  value: SettingValue;
}

/** Which values make sense for each setting (anything else is ignored). */
export const SETTING_ALLOWED: Record<VoiceSetting, readonly SettingValue[]> = {
  speech_rate: ['up', 'down', 'reset'],
  voice_only: ['on', 'off'],
  vibration: ['on', 'off'],
  beacon: ['on', 'off'],
  app_voice: ['on', 'off'],
  text_size: ['up', 'down', 'reset'],
  language: ['en', 'de'],
  live_voice: ['on', 'off'],
};

export const isValidSettingChange = (c: Partial<SettingChange> | null | undefined): c is SettingChange =>
  Boolean(c?.setting && c.value && (VOICE_SETTINGS as readonly string[]).includes(c.setting) && SETTING_ALLOWED[c.setting].includes(c.value));

/** For prompts: what can be changed, in plain words. */
export const VOICE_SETTINGS_HELP =
  'speech_rate up/down/reset ("speak slower", "faster"), voice_only on/off (minimal screen, always listening), vibration on/off, beacon on/off (the direction beep), app_voice on/off (only for screen-reader users), text_size up/down/reset, language en/de, live_voice on/off (the conversational voice)';
