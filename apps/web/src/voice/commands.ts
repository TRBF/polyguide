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
  const destination = text.match(/^(?:please\s+)?(?:take me to|navigate to|go to|bring me to|guide me to|directions to|route to|show me the way to|how do i get to|how can i get to|i want to go to|i'd like to go to|i need to go to|i need to get to|where is|where's|find)\s+(?:the\s+)?(.+?)(?:\s+please)?$/);
  if (destination?.[1]) return { type: 'navigate_to', target: destination[1], source: 'regex' };
  // Needs said as a need, not a place: "I need the toilet", "toilet please", "way out".
  if (/^(?:i need (?:the |a )?|i have to (?:go to )?(?:the )?)?(?:toilet|toilets|bathroom|restroom|loo|wc)(?:\s+please)?$/.test(text)) {
    return { type: 'navigate_to', target: 'nearest toilet', source: 'regex' };
  }
  if (/^(?:the\s+)?(?:nearest\s+)?(?:exit|way out|way outside)(?:\s+please)?$|^how do i get out$|^get me out(?: of here)?$/.test(text)) {
    return { type: 'navigate_to', target: 'nearest exit', source: 'regex' };
  }
  if (/^(?:the\s+)?(?:nearest\s+)?(?:elevator|lift)(?:\s+please)?$/.test(text)) {
    return { type: 'navigate_to', target: 'nearest elevator', source: 'regex' };
  }
  const location = text.match(/^(?:i am at|i'm at|i am in|i'm in)\s+(.+)$/);
  if (location?.[1]) return { type: 'set_location', target: location[1], source: 'regex' };
  // "number two", "option 2", or a bare "two" / "2" / "the second one" after a list was read out.
  const option = text.match(/^(?:number|option|the)?\s*(one|two|three|four|five|first|second|third|fourth|fifth|[1-9])(?:\s+one)?$/);
  if (option?.[1]) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
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

export interface TripRequest {
  fromText: string;
  toText: string;
}

/** Extract both ends of a spoken trip when the AI agent is unavailable. */
export function parseTripRequest(transcript: string): TripRequest | null {
  const text = transcript.trim().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  const match = text.match(/^(?:i am|i'm|im)\s+(?:currently\s+)?(?:at|in|near|by|next to|outside|inside|standing at)\s+(.+?)\s*(?:[,;.]?\s+(?:and\s+)?(?:i\s+)?(?:want|would like|need)\s+to\s+(?:go|get)\s+to|[,;.]?\s+(?:and\s+)?(?:please\s+)?(?:take me|navigate|guide me|bring me)\s+to)\s+(.+?)\s*[.!?]*$/i);
  const fromText = match?.[1]?.trim().replace(/[,.]+$/g, '');
  const toText = match?.[2]?.trim().replace(/[,.!?]+$/g, '');
  if (!fromText || !toText) return null;
  return { fromText, toText };
}

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

/** Commands that are about the app or the user's situation rather than a navigation intent. */
export type AppCommand =
  | { type: 'emergency' }
  | { type: 'elevator_broken' }
  | { type: 'change_needs' }
  | { type: 'start_over' }
  | { type: 'system_check' }
  | { type: 'tutorial' }
  | { type: 'yes' }
  | { type: 'no' }
  | { type: 'repeat_slower' }
  | { type: 'louder' };

export function parseAppCommand(transcript: string): AppCommand | null {
  const text = normalize(transcript);
  if (/^(?:emergency|it's an emergency|call (?:for )?help|call an ambulance|call 112|call 144|i need (?:urgent|emergency) help|help me please|i am hurt|i'm hurt|i fell|i have fallen|sos)$/.test(text)) return { type: 'emergency' };
  if (/\b(?:elevator|lift)\b.*\b(?:not working|broken|out of order|out of service|closed|doesn't work|does not work|isn't working|is not working|won't come|stuck)\b|^(?:broken|no) (?:elevator|lift)$/.test(text)) return { type: 'elevator_broken' };
  if (/^(?:change|edit|update) (?:my )?(?:needs|profile|preferences)$/.test(text)) return { type: 'change_needs' };
  if (/^(?:how does (?:it|this|the app|polyguide) work|how do i use (?:it|this|the app|polyguide)|(?:show|open|start|play)(?: me)? the (?:guide|tutorial|introduction)|tutorial|guide|introduction|wie funktioniert (?:das|es|die app))$/.test(text)) return { type: 'tutorial' };
  if (/^(?:system check|status check|check the system|run (?:a )?(?:system check|diagnostics)|is everything working|systemcheck)$/.test(text)) return { type: 'system_check' };
  if (/^(?:start over|start again|restart|reset|start from scratch|new (?:trip|route|destination)|(?:plan |make )?(?:a |another )?new route|another (?:route|trip|destination)|cancel (?:the |this )?(?:route|trip)|clear (?:the |this )?(?:route|trip)|neue route|von vorne)$/.test(text)) return { type: 'start_over' };
  if (/^(?:yes|yeah|yep|yes please|correct|that's right|ok|okay|sure|sounds good|go ahead|let's go)$/.test(text)) return { type: 'yes' };
  if (/^(?:no|nope|no thanks|wrong|that's wrong|not that one)$/.test(text)) return { type: 'no' };
  if (/^(?:repeat slower|say (?:that|it) (?:again )?slower|slower please|too fast|more slowly)$/.test(text)) return { type: 'repeat_slower' };
  if (/^(?:louder|speak up|i can't hear (?:you)?|volume up)$/.test(text)) return { type: 'louder' };
  return null;
}
