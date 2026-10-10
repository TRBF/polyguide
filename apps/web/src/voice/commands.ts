import type { Intent } from '@polyguide/shared';

export function parseCommand(transcript: string): Intent | null {
  const text = transcript.trim().toLowerCase().replace(/[?!.,]+$/g, '');
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
