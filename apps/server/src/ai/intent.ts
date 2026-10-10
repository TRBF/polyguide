/**
 * POST /api/intent (SPEC §5.6). The client regex fast path catches the common commands; anything
 * else lands here. We retry the regex (cheap, works without a key), then ask a small text model.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Intent, IntentType } from '@polyguide/shared';
import { classifyError, describeError, getOpenAI, reasoningEffort, textModel, withTimeout } from './openai';

const TIMEOUT_MS = 4000;

const INTENT_TYPES = ['navigate_to', 'set_location', 'where_am_i', 'whats_ahead', 'repeat', 'next', 'back', 'stop', 'help', 'choose_option', 'unknown'] as const;

const NUMBER_WORDS: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 };

const SIMPLE: [RegExp, IntentType][] = [
  // Anchored: continuous listening hears chatter, so "stop by the office" must not stop navigation.
  [/^(next|continue|done|ok(ay)? next|i['’]?m (there|done))( please)?$/, 'next'],
  [/^(go )?(back|previous)( please)?$/, 'back'],
  [/^(repeat|say (that|it) again|again|pardon|what\??)$/, 'repeat'],
  [/^(stop|cancel|end navigation|stop navigation|quit)( please)?$/, 'stop'],
  [/^(please )?(where am i|i['’]?m lost)$/, 'where_am_i'],
  [/^(what['’]?s|what is) (ahead|in front)( of me)?$|^what (can|do) you see$/, 'whats_ahead'],
  [/^(help|what can i say)( please)?$/, 'help'],
];

/** Deterministic parse of the obvious phrasings; null when the model is needed. */
export function regexIntent(utterance: string): Intent | null {
  const raw = utterance.trim().replace(/[.!]+$/, '');
  const u = raw.toLowerCase().replace(/[‘’]/g, "'").replace(/\?+$/, '');
  if (!u) return null;
  // Targets come from `raw` so "HG F 30" keeps its casing.
  const nav = raw.match(/^(?:navigate to|take me to|go to|bring me to|guide me to|directions to)\s+(?:the\s+)?(.+)$/i);
  if (nav) return { type: 'navigate_to', target: nav[1].trim(), source: 'regex' };
  const at = raw.match(/^(?:i['’]?m at|i am at|i['’]?m in|i am in|i['’]?m next to|i am next to|i['’]?m by|i['’]?m near)\s+(?:the\s+)?(.+)$/i);
  if (at) return { type: 'set_location', target: at[1].trim(), source: 'regex' };
  const opt = u.match(/^(?:number|option|the)?\s*(\d|one|two|three|four|five|first|second|third|fourth|fifth)(?:\s+one)?$/);
  if (opt) return { type: 'choose_option', option: Number(opt[1]) || NUMBER_WORDS[opt[1]], source: 'regex' };
  const hit = SIMPLE.find(([re]) => re.test(u));
  return hit ? { type: hit[1], source: 'regex' } : null;
}

export const INTENT_SYSTEM_PROMPT = `You map one spoken command from a user of PolyGuide, an accessible indoor navigation app for ETH Zürich, to an intent.
Intents:
- navigate_to: the user wants to go somewhere. target = the destination as said, e.g. "HG F 30", "Audimax", "nearest toilet", "nearest accessible toilet".
- set_location: the user tells where they are now. target = the place as said, e.g. "HG E 41", "main staircase", "main entrance".
- where_am_i: the user asks where they are or says they are lost.
- whats_ahead: the user asks what is ahead or what the camera sees.
- repeat: repeat the last instruction.
- next: go to the next step, or confirm they finished (e.g. left the elevator).
- back: go to the previous step or screen.
- stop: stop or cancel navigation.
- help: asks what they can say or do.
- choose_option: picks an item from a list read to them. option = the 1-based number.
- unknown: anything else.
Keep target in the user's words but drop filler ("please", "the"). Room codes look like "HG F 30"; write them in that form. The user may speak English or German.
Examples:
"nearest toilet" → navigate_to, target "nearest toilet"
"where's the closest wheelchair accessible bathroom" → navigate_to, target "nearest accessible toilet"
"I need to get to the Audimax please" → navigate_to, target "Audimax"
"bring mich zu H G F dreissig" → navigate_to, target "HG F 30"
"I'm next to the main staircase" → set_location, target "main staircase"
"I just came in the main entrance" → set_location, target "main entrance"
"go back" → back
"say that again" → repeat
"I'm out of the elevator" → next
"the second one" → choose_option, option 2
"what can you see" → whats_ahead
"I don't know where I am" → where_am_i
"never mind, cancel" → stop
"what's the weather" → unknown`;

const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'target', 'option'],
  properties: {
    type: { type: 'string', enum: INTENT_TYPES },
    target: { type: ['string', 'null'] },
    option: { type: ['integer', 'null'] },
  },
} as const;

const modelOutput = z.object({
  type: z.enum(INTENT_TYPES),
  target: z.string().nullable(),
  option: z.number().int().nullable(),
});

const requestSchema = z.object({
  utterance: z.string().max(500),
  screen: z.enum(['needs', 'start', 'destination', 'preview', 'navigate', 'arrived', 'settings']).default('navigate'),
  language: z.enum(['en', 'de']).optional(),
});

export const intentRoutes = new Hono();

intentRoutes.post('/intent', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json<Intent>({ type: 'unknown', source: 'regex' }, 400);
  const { utterance, screen, language } = parsed.data;

  const fast = regexIntent(utterance);
  if (fast) return c.json<Intent>(fast);

  const openai = getOpenAI();
  if (!openai || !utterance.trim()) return c.json<Intent>({ type: 'unknown', source: 'regex' });

  let aborted = false;
  try {
    const response = await withTimeout(TIMEOUT_MS, (signal) => {
      signal.addEventListener('abort', () => (aborted = true), { once: true });
      return openai.responses.create(
        {
          model: textModel(),
          instructions: INTENT_SYSTEM_PROMPT,
          input: `Screen: ${screen}\nLanguage: ${language ?? 'en'}\nUser said: "${utterance.trim()}"`,
          text: { format: { type: 'json_schema', name: 'intent', schema: INTENT_JSON_SCHEMA, strict: true } },
          reasoning: reasoningEffort(),
          store: false,
        },
        { signal },
      );
    });
    const out = modelOutput.safeParse(JSON.parse(response.output_text));
    if (!out.success) return c.json<Intent>({ type: 'unknown', source: 'llm' });
    const { type, target, option } = out.data;
    const intent: Intent = { type, source: 'llm' };
    if ((type === 'navigate_to' || type === 'set_location') && target?.trim()) intent.target = target.trim();
    else if (type === 'navigate_to' || type === 'set_location') intent.type = 'unknown';
    if (type === 'choose_option' && option != null && option > 0) intent.option = option;
    else if (type === 'choose_option') intent.type = 'unknown';
    return c.json<Intent>(intent);
  } catch (err) {
    console.warn(`intent failed: ${classifyError(err, aborted).reason} (${describeError(err)})`);
    return c.json<Intent>({ type: 'unknown', source: 'llm' });
  }
});
