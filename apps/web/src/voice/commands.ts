import type { Intent } from '@polyguide/shared';

export function parseCommand(transcript: string): Intent | null {
  const text = transcript.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,]+$/g, '');
  if (!text) return null;
  if (/^(next|continue|done|i am done|i'm done|start|new destination|new route)$/.test(text)) return { type: 'next', source: 'regex' };
  if (/^(back|go back|previous)$/.test(text)) return { type: 'back', source: 'regex' };
  if (/^(repeat|say that again|again)$/.test(text)) return { type: 'repeat', source: 'regex' };
  if (/^(stop|cancel|end navigation)$/.test(text)) return { type: 'stop', source: 'regex' };
  if (/^(help|what can i say|commands)$/.test(text)) return { type: 'help', source: 'regex' };
  if (/^(where am i|where are we)$/.test(text)) return { type: 'where_am_i', source: 'regex' };
  if (/^(what'?s ahead|what is ahead|what'?s next)$/.test(text)) return { type: 'whats_ahead', source: 'regex' };
  if (/^(scan|scan sign|scan a room sign|find my location)$/.test(text)) {
    return { type: 'set_location', target: 'scan sign', source: 'regex' };
  }
  if (/^(use gps|use gps outdoors|find me outdoors)$/.test(text)) {
    return { type: 'set_location', target: 'use gps', source: 'regex' };
  }
  const destination = text.match(/^(?:take me to|navigate to|go to)\s+(.+)$/);
  if (destination?.[1]) return { type: 'navigate_to', target: destination[1], source: 'regex' };
  const location = text.match(/^(?:i am at|i'm at|i am in|i'm in)\s+(.+)$/);
  if (location?.[1]) return { type: 'set_location', target: location[1], source: 'regex' };
  const option = text.match(/^(?:number|option)\s+(one|two|three|four|five|\d+)$/);
  if (option?.[1]) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    return { type: 'choose_option', option: words[option[1]] ?? Number(option[1]), source: 'regex' };
  }
  return null;
}

const normalize = (transcript: string) => transcript.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,]+$/g, '');
/** Said outright that they want to go somewhere ("take me to …"), whatever the screen asked. */
const GOING = /^(?:please\s+)?(?:take me|navigate|go to|bring me|guide me|directions|route to|i want to go|i'd like to go|i need to (?:go|get)|how do i get)\b/;
/** Said outright where they are ("I'm at …"). */
const BEING = /^(?:i am|i'm|im)\s+(?:at|in|near|by|next to|outside|inside|standing)\b/;
/** A short reply naming a room, e.g. "k30", "HG E 41", "F 33.1". */
const looksLikeRoom = (text: string) => /\d/.test(text) && text.split(/\s+/).length <= 4;
/** A short reply the model could not place ("the audimax"): search it as a place rather than give up. */
const shortReply = (text: string) => text.split(/\s+/).length <= 5;
const placeText = (transcript: string) => transcript.trim().replace(/[?!.,]+$/g, '').replace(/^the\s+/i, '');

/**
 * Reads a reply as the answer to the question the screen asked. On "Where are you?" a bare place is where the
 * user is, not where they want to go (and the reverse on "Where to?"). An explicit "take me to …" / "I'm at …"
 * keeps its meaning. With no intent yet, a bare room code is answered directly (no server round trip).
 */
export function answerForScreen(screen: string, transcript: string, intent: Intent | null): Intent | null {
  const text = normalize(transcript);
  if (screen === 'where') {
    if (intent?.type === 'navigate_to' && intent.target && !GOING.test(text)) return { ...intent, type: 'set_location' };
    if ((!intent && looksLikeRoom(text)) || (intent?.type === 'unknown' && shortReply(text))) return { type: 'set_location', target: placeText(transcript), source: 'regex' };
  }
  if (screen === 'destination') {
    const tool = intent?.target === 'scan sign' || intent?.target === 'use gps';
    if (intent?.type === 'set_location' && intent.target && !tool && !BEING.test(text)) return { ...intent, type: 'navigate_to' };
    if ((!intent && looksLikeRoom(text)) || (intent?.type === 'unknown' && shortReply(text))) return { type: 'navigate_to', target: placeText(transcript), source: 'regex' };
  }
  return intent;
}
