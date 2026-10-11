import { describe, expect, it } from 'vitest';
import { applySettingChange, describeSettings, parseSettingCommand } from './settingsVoice';
import type { Preferences } from '../storage';

const prefs: Preferences = {
  profile: { needs: [], language: 'en', stepLengthM: 0.7 },
  settings: {
    voiceFirst: false, speechRate: 1, speakWithAppVoice: true, beaconEnabled: true, stepLengthM: 0.7,
    voiceName: null, haptics: true, textScale: 1, permissionsGranted: true, realtimeVoice: true,
  },
} as Preferences;

describe('parseSettingCommand', () => {
  it.each([
    ['Speak slower', { setting: 'speech_rate', value: 'down' }],
    ['talk a bit faster please', { setting: 'speech_rate', value: 'up' }],
    ['Langsamer bitte', { setting: 'speech_rate', value: 'down' }],
    ['turn on voice only mode', { setting: 'voice_only', value: 'on' }],
    ['show me the full screen', { setting: 'voice_only', value: 'off' }],
    ['Turn off the vibrations.', { setting: 'vibration', value: 'off' }],
    ['stop the beeping', { setting: 'beacon', value: 'off' }],
    ['mute the app voice', { setting: 'app_voice', value: 'off' }],
    ['make the text bigger', { setting: 'text_size', value: 'up' }],
    ['zoom out', { setting: 'text_size', value: 'down' }],
    ['Auf Deutsch bitte', { setting: 'language', value: 'de' }],
    ['speak English', { setting: 'language', value: 'en' }],
    ['turn off the live voice', { setting: 'live_voice', value: 'off' }],
  ])('"%s"', (said, expected) => {
    expect(parseSettingCommand(said)).toEqual(expected);
  });

  it('answers "what are my settings"', () => {
    expect(parseSettingCommand('What are my settings?')).toBe('read');
  });

  it('does not treat a trip or "stop talking" as a setting', () => {
    expect(parseSettingCommand('take me to F 30')).toBeNull();
    expect(parseSettingCommand('stop talking')).toBeNull();
    expect(parseSettingCommand('stop')).toBeNull();
  });
});

describe('applySettingChange', () => {
  it('changes speech rate in steps and stops at the limits', () => {
    let p = prefs;
    for (let i = 0; i < 6; i++) p = applySettingChange(p, { setting: 'speech_rate', value: 'up' })!.prefs;
    expect(p.settings.speechRate).toBe(1.5);
    expect(applySettingChange(p, { setting: 'speech_rate', value: 'up' })!.say).toMatch(/already the fastest/);
    expect(applySettingChange(p, { setting: 'speech_rate', value: 'reset' })!.prefs.settings.speechRate).toBe(1);
  });

  it('switches voice-only mode, vibration and the beep', () => {
    expect(applySettingChange(prefs, { setting: 'voice_only', value: 'on' })!.prefs.settings.voiceFirst).toBe(true);
    expect(applySettingChange(prefs, { setting: 'vibration', value: 'off' })!.prefs.settings.haptics).toBe(false);
    expect(applySettingChange(prefs, { setting: 'beacon', value: 'off' })!.prefs.settings.beaconEnabled).toBe(false);
  });

  it('turning the app voice off says so first', () => {
    const r = applySettingChange(prefs, { setting: 'app_voice', value: 'off' })!;
    expect(r.prefs.settings.speakWithAppVoice).toBe(false);
    expect(r.sayFirst).toBe(true);
  });

  it('steps the text size through 1, 1.25, 1.5', () => {
    const a = applySettingChange(prefs, { setting: 'text_size', value: 'up' })!.prefs;
    const b = applySettingChange(a, { setting: 'text_size', value: 'up' })!.prefs;
    expect([a.settings.textScale, b.settings.textScale]).toEqual([1.25, 1.5]);
  });

  it('switches the language in the profile', () => {
    expect(applySettingChange(prefs, { setting: 'language', value: 'de' })!.prefs.profile.language).toBe('de');
  });

  it('rejects nonsense combinations', () => {
    expect(applySettingChange(prefs, { setting: 'vibration', value: 'up' })).toBeNull();
  });

  it('reads the settings back', () => {
    expect(describeSettings(prefs)).toMatch(/Voice-only mode off\. Speech speed normal\. Vibration on\./);
  });
});
