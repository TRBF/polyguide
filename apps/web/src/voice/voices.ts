/**
 * Choosing a speechSynthesis voice. Without an explicit voice and lang, browsers read English text
 * with the device's default voice, which on a German/Swiss phone is German (thick accent).
 */

export type SpeechLang = 'en' | 'de';

/** Minimal shape of SpeechSynthesisVoice, so the ranking is testable without a browser. */
export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/** macOS/iOS novelty and robotic "Eloquence" voices: understandable at best, never the right default. */
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;
/** Signals of a natural-sounding voice across platforms. */
const QUALITY = /\b(premium|enhanced|neural|natural|siri)\b/i;
/** Well-known good English voices (Apple, Google, Microsoft). */
const GOOD_EN = /\b(ava|samantha|zoe|allison|susan|evan|nathan|serena|daniel|karen|moira|tessa|kate|oliver|jamie|google (us|uk) english|aria|jenny|guy|sonia|libby|ryan)\b/i;
const GOOD_DE = /\b(anna|petra|markus|yannick|helena|google deutsch|katja|conrad|amala)\b/i;

const langOf = (v: VoiceLike) => v.lang.replace('_', '-').toLowerCase();

/** Higher is better; -Infinity means the voice can't speak this language. */
export function scoreVoice(v: VoiceLike, lang: SpeechLang): number {
  const l = langOf(v);
  if (!l.startsWith(lang)) return -Infinity;
  let s = 10;
  if (lang === 'en') {
    if (l === 'en-us') s += 6;
    else if (l === 'en-gb') s += 5;
    else if (/^en-(au|ie|ca|nz)$/.test(l)) s += 3;
  } else if (l === 'de-de' || l === 'de-ch') {
    s += 5;
  }
  if (QUALITY.test(v.name)) s += 20;
  if ((lang === 'en' ? GOOD_EN : GOOD_DE).test(v.name)) s += 8;
  if (/google/i.test(v.name)) s += 6; // Chrome's network voices are far more natural than the OS fallback
  if (NOVELTY.test(v.name)) s -= 30;
  if (v.default) s += 1;
  return s;
}

/** Voices usable for this language, best first. */
export function rankVoices<T extends VoiceLike>(voices: T[], lang: SpeechLang): T[] {
  return voices
    .map((v) => ({ v, s: scoreVoice(v, lang) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

/** The user's chosen voice if it is still installed and speaks this language, otherwise the best one. */
export function pickVoice<T extends VoiceLike>(voices: T[], lang: SpeechLang, preferredName?: string | null): T | null {
  const ranked = rankVoices(voices, lang);
  return (preferredName && ranked.find((v) => v.name === preferredName)) || ranked[0] || null;
}
