import { describe, expect, it } from 'vitest';
import { pickVoice, rankVoices, type VoiceLike } from './voices';

const v = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({ name, lang, localService: true, ...extra });

// A typical German-locale iPhone/Mac: German default voice first, mixed-quality English voices.
const mac = [
  v('Anna', 'de-DE', { default: true }),
  v('Albert', 'en-US'),
  v('Fred', 'en-US'),
  v('Samantha', 'en-US'),
  v('Ava (Premium)', 'en-US'),
  v('Daniel', 'en-GB'),
  v('Rishi', 'en-IN'),
];

describe('voice choice', () => {
  it('never picks the German default for English', () => {
    expect(pickVoice(mac, 'en')!.lang.startsWith('en')).toBe(true);
  });
  it('prefers premium/enhanced voices, then known good ones, and drops novelty voices to the bottom', () => {
    const names = rankVoices(mac, 'en').map((x) => x.name);
    expect(names[0]).toBe('Ava (Premium)');
    expect(names[1]).toBe('Samantha');
    expect(names.slice(-2).sort()).toEqual(['Albert', 'Fred']);
    expect(names).not.toContain('Anna');
  });
  it("prefers Chrome's Google voices over the OS fallback", () => {
    expect(pickVoice([v('English United States', 'en_US'), v('Google US English', 'en-US', { localService: false })], 'en')!.name).toBe('Google US English');
  });
  it('honours the saved choice only if installed and in the right language', () => {
    expect(pickVoice(mac, 'en', 'Daniel')!.name).toBe('Daniel');
    expect(pickVoice(mac, 'en', 'Gone Voice')!.name).toBe('Ava (Premium)');
    expect(pickVoice(mac, 'en', 'Anna')!.name).toBe('Ava (Premium)');
    expect(pickVoice(mac, 'de')!.name).toBe('Anna');
  });
  it('returns null when nothing speaks the language', () => {
    expect(pickVoice([v('Anna', 'de-DE')], 'en')).toBeNull();
  });
});
