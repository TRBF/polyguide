/**
 * Reflexes: the few things that must happen the instant they are said, without waiting 1–2 s for the AI.
 * "Stop", "be quiet", "emergency", "next" at a corner, "yes" to start. The app runs them locally the moment the
 * words are recognised (for the most urgent ones, even mid-sentence), and the AI's own answer is cancelled so
 * nothing happens twice.
 */

export type Reflex = 'emergency' | 'silence' | 'stop' | 'next' | 'back' | 'repeat' | 'yes' | 'no';

const norm = (t: string) =>
  t.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?¡¿…]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Unambiguous even as the first words of a longer sentence: safe to act on while the user is still talking. */
const MID_SENTENCE: [RegExp, Reflex][] = [
  [/^(?:emergency|sos|call 112|call 144|call an ambulance|notfall)$/, 'emergency'],
  [/^(?:stop talking|be quiet|quiet please|silence|shut up|shh+|ruhe)$/, 'silence'],
];

/** Whole short utterances. */
const WHOLE: [RegExp, Reflex][] = [
  [/^(?:emergency|sos|call (?:112|144|an ambulance|for help)|help me please|please help me|i(?: am|'m) hurt|i fell|i have fallen|notfall|hilfe)$/, 'emergency'],
  [/^(?:wait|hold on|one moment|just a moment|stop talking|quiet|be quiet|silence|shut up|shh+|warte|ruhe|moment)$/, 'silence'],
  [/^(?:stop|stop navigation|stop the navigation|end navigation|cancel navigation|halt|stopp)$/, 'stop'],
  [/^(?:next|next step|done|i'm there|i am there|i'm here|weiter|fertig)$/, 'next'],
  [/^(?:back|go back|previous|previous step|zurück)$/, 'back'],
  [/^(?:repeat|again|say (?:that|it) again|repeat that|pardon|sorry|what|wiederholen|nochmal|bitte\?)$/, 'repeat'],
  [/^(?:yes|yeah|yep|yes please|correct|that's right|right|ok|okay|sure|let's go|go ahead|ja|genau|richtig)$/, 'yes'],
  [/^(?:no|nope|wrong|that's wrong|no thanks|nein|falsch)$/, 'no'],
];

/**
 * The reflex in `text`, if any. `partial` = the user is still speaking: only the unambiguous, urgent phrases
 * count then ("help me" could still become "help me find the toilet").
 */
export function matchReflex(text: string, partial = false): Reflex | null {
  const t = norm(text);
  if (!t || t.split(' ').length > 6) return null;
  for (const [re, reflex] of partial ? MID_SENTENCE : WHOLE) if (re.test(t)) return reflex;
  return null;
}

/** Remembers what the app just did by reflex, so the AI's late tool call for the same thing is ignored. */
export class ReflexMemory {
  private last: { reflex: Reflex; at: number } | null = null;

  constructor(private windowMs = 4000) {}

  mark(reflex: Reflex, now = Date.now()): void {
    this.last = { reflex, at: now };
  }

  /** True if `reflex` was already done within the window (and should not be done again). */
  recently(reflex: Reflex, now = Date.now()): boolean {
    return Boolean(this.last && this.last.reflex === reflex && now - this.last.at < this.windowMs);
  }
}
