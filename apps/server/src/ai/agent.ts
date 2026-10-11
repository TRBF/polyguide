/**
 * POST /api/agent: the voice agent. Every sentence the user says (Whisper or the browser recognizer) or types
 * comes here with the app's state; a text model with structured output decides what the user wants and pulls
 * out the places they named. The server — not the model — resolves those names against the HG graph, so a room
 * is never invented, and writes the confirmation sentence itself ("From HG F 7 to HG F 30, the Audimax. Is that
 * right?"). The client executes the action; nothing here routes or navigates.
 *
 * The system prompt lists every HG room code, named place, entrance and room type. It is static (built once from
 * the graph), so the provider can cache it.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { USE_TYPES, useTypeFromText, type AgentAction, type AgentRequest, type AgentResponse, type Need, type Place } from '@polyguide/shared';
import { planRoute } from '@polyguide/routing';
import { getGraph, getPlace, getProfileOptions, matchPlaces, normRoom, searchPlaces } from '../graphStore';
import { classifyError, describeError, getOpenAI, reasoningEffort, textModel, withTimeout } from './openai';
import { sanitizeUtterance } from './visionPrompt';

const TIMEOUT_MS = 6000;
const MAIN_ENTRANCE = 'pl_lm_137';

const ACTIONS = ['set_trip', 'confirm', 'reject', 'choose_option', 'set_needs', 'start', 'next', 'back', 'repeat', 'stop', 'where_am_i', 'whats_ahead', 'emergency', 'elevator_broken', 'slower', 'faster', 'settings', 'help', 'none'] as const satisfies readonly AgentAction[];
const NEEDS = ['wheelchair', 'blind', 'lowVision', 'avoidStairs'] as const;

/** A place the client already knows: ids and names are short, and only the id is trusted (names are re-read). */
const placeRef = z.object({ id: z.string().min(1).max(80), name: z.string().max(80) });
/** What the model may hand back as a place name; longer text is not a place and is never echoed. */
const MAX_PLACE_TEXT = 60;
const MAX_REPLY_CHARS = 200;

/** A place name the model extracted, or null when it does not look like one (too long, odd characters). */
export function placeText(text: string | null): string | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_PLACE_TEXT || !/^[\p{L}\p{N} .,'’()&/-]+$/u.test(t)) return null;
  return t;
}

const requestSchema = z.object({
  utterance: z.string().min(1).max(500),
  context: z.object({
    phase: z.enum(['trip', 'confirm', 'ready', 'navigate', 'arrived']),
    from: placeRef.optional(),
    to: placeRef.optional(),
    options: z.array(placeRef).max(8).optional(),
    needs: z.array(z.enum(['wheelchair', 'blind', 'lowVision', 'lowStamina', 'avoidCrowds'])).default([]),
    avoidStairs: z.boolean().optional(),
    step: z.string().max(300).optional(),
    /** While walking: a graph node on the current step, so "I'm at the elevator" means the one nearby. */
    nearNodeId: z.string().max(80).optional(),
  }),
  language: z.enum(['en', 'de']).optional(),
});

const modelOutput = z.object({
  action: z.enum(ACTIONS),
  from_text: z.string().nullable(),
  to_text: z.string().nullable(),
  option: z.number().int().nullable(),
  needs_add: z.array(z.enum(NEEDS)),
  needs_remove: z.array(z.enum(NEEDS)),
  reply: z.string(),
});

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'from_text', 'to_text', 'option', 'needs_add', 'needs_remove', 'reply'],
  properties: {
    action: { type: 'string', enum: ACTIONS },
    from_text: { type: ['string', 'null'], description: 'Where the user is now, as a room code ("HG F 7") or a place ("main entrance", "Audimax"). null if not said.' },
    to_text: { type: ['string', 'null'], description: 'Where the user wants to go, same format. "nearest toilet" etc. allowed. null if not said.' },
    option: { type: ['integer', 'null'], description: '1-based choice when picking from options read out.' },
    needs_add: { type: 'array', items: { type: 'string', enum: NEEDS } },
    needs_remove: { type: 'array', items: { type: 'string', enum: NEEDS } },
    reply: { type: 'string', description: 'At most 25 words to speak back. For set_trip leave it empty: the app writes the confirmation.' },
  },
} as const;

/* ───────────── Static system prompt (built once from the graph) ───────────── */

let systemPrompt: string | null = null;
function buildSystemPrompt(): string {
  if (systemPrompt) return systemPrompt;
  const g = getGraph();
  const byFloor = new Map<string, string[]>();
  for (const p of g.places) {
    if (p.kind !== 'room') continue;
    const floor = p.levelId.split('.').pop()!;
    (byFloor.get(floor) ?? byFloor.set(floor, []).get(floor)!).push(p.name.replace(/^HG\s+/, ''));
  }
  const floors = [...g.levels].map((l) => l.id.split('.').pop()!).filter((f) => byFloor.has(f));
  const rooms = floors.map((f) => `${f}: ${byFloor.get(f)!.join(', ')}`).join('\n');
  const named = g.places.filter((p) => p.kind === 'room' && p.label).map((p) => `${p.label} = ${p.name}`).join('; ');
  const entrances = [...new Set(g.places.filter((p) => p.kind === 'entrance').map((p) => p.label ?? p.name))].join('; ');
  const poiTypes = [...new Set(g.places.filter((p) => p.kind === 'poi').map((p) => p.label).filter(Boolean))].join(', ');
  const roomTypes = [...new Set(Object.values(USE_TYPES))].join(', ');
  systemPrompt = `You are the voice agent of PolyGuide, an indoor navigation app for blind, low-vision and wheelchair users in the ETH Zürich main building (HG).
The user speaks; speech-to-text may garble room codes ("F seven" = "F 7", "H G E forty one" = "HG E 41", "F thirty point one" = "F 30.1", "k30" = "K 30"). Decide what they want and fill the JSON.

Room codes are "HG <floor> <number>". Floors from bottom to top: ${floors.join(', ')} (EO, FO, GO… are half floors). Rooms by floor (without "HG"):
${rooms}
Named places: ${named}.
Entrances: ${entrances}.
Facilities: ${poiTypes}. Room types: ${roomTypes}.

Actions:
- set_trip: the user names where they are and/or where to go ("I'm in F7 and want to get to F30", "take me to the Audimax", "I'm at the main entrance"). Put the start in from_text and the goal in to_text, normalised to a room code from the list when it is a room ("HG F 7"), else the place as said ("nearest toilet", "main entrance", "a seminar room"). Leave reply empty.
- While walking (phase navigate) the user may tell you where they are: "I'm at F 33", "I'm next to E 12", "I can feel the sign says G 5", "I'm at the elevator". That is set_trip with only from_text (their position) and to_text null. Believe them: the user knows where they stand better than the camera does.
- confirm / reject: yes or no to the trip the app just proposed (phase "confirm"). "Yes, start", "correct", "let's go" = confirm. "No", "wrong" = reject; if they also correct a place, use set_trip instead.
- choose_option: picking from options the app read out ("the second one", "number 2", "F 33.1") → option = its number.
- set_needs: "I'm blind", "I use a wheelchair", "avoid stairs", "I'm not in a wheelchair" → needs_add / needs_remove (wheelchair, blind, lowVision, avoidStairs). Reply with a short confirmation.
- start: begin navigation of a ready route. next, back, repeat, stop: step commands. where_am_i, whats_ahead: questions while walking.
- emergency: danger, hurt, fell, call for help. elevator_broken: an elevator is out of service.
- slower, faster: speech speed. settings: open settings. help: what can I say.
- none: anything else; reply briefly and helpfully (e.g. ask where they are or where they want to go). Never claim a path is safe or clear.
The app state comes with each message. Keep replies short, plain, and spoken-friendly.`;
  return systemPrompt;
}

/* ───────────── Place resolution (server-side, against the graph) ───────────── */

interface Resolved {
  place?: Place;
  options?: Place[];
}

const spoken = (p: Place) => (p.kind === 'entrance' && p.label ? p.label : p.label && p.kind === 'room' ? `${p.name}, the ${p.label}` : p.name);

/** "nearest toilet", "a seminar room", "exit", "Audimax", "HG F 7" → a place, or options when ambiguous. */
/**
 * `position`: the user says they are AT this kind of place ("I'm at the elevator"), so the nearest one counts, even
 * the one on their own node. Otherwise it is a destination: never the place they stand in, and the quickest by route.
 */
export function resolvePlace(text: string, near: Place | undefined, needs: string[], avoidStairs = false, position = false): Resolved {
  let q = text.trim().replace(/^(?:the|a|an|room)\s+/i, '').replace(/^(?:nearest|closest)\s+/i, '');
  const wantsNearest = /^(?:the\s+)?(?:nearest|closest)\s/i.test(text.trim()) || /^(?:a|an|any)\s/i.test(text.trim());
  const g = getGraph();
  const ref = near ?? getPlace(MAIN_ENTRANCE);
  // Exits are the building's entrances.
  if (/^(?:exit|way out|main exit|building exit)$/i.test(q)) {
    const entrances = g.places.filter((p) => p.kind === 'entrance' && p.nodeId !== near?.nodeId);
    const sorted = ref ? entrances.sort((a, b) => dist(ref, a) - dist(ref, b)) : entrances;
    return { place: quickestReachable(near, sorted, needs, avoidStairs) };
  }
  if (needs.includes('wheelchair') && /\b(?:toilet|bathroom|restroom|wc|loo)\b/i.test(q) && !/accessible/i.test(q)) q = 'accessible toilet';
  const generic = wantsNearest || Boolean(useTypeFromText(q)) || /\b(?:toilet|bathroom|restroom|wc|elevator|lift|cafe|cafeteria|food|library|printer|printing|lounge|cloakroom|entrance)\b/i.test(q);
  if (generic) {
    const found = searchPlaces(q, 8, undefined, ref);
    if (position) return { place: found[0] };
    return { place: quickestReachable(near, found.filter((p) => p.nodeId !== near?.nodeId), needs, avoidStairs) };
  }
  // A room code or a name.
  const exact = g.places.find((p) => p.kind === 'room' && (normRoom(p.name) === normRoom(q) || normRoom(p.name) === `HG${normRoom(q)}`));
  if (exact) return { place: exact };
  const matches = matchPlaces(q, { limit: 5 }).filter((m) => m.place.kind !== 'poi' || !/^elevator/i.test(m.place.name));
  if (!matches.length) return {};
  const [best, second] = matches;
  if (best.confidence >= 0.9 || (best.confidence >= 0.6 && (!second || best.confidence - second.confidence >= 0.2))) return { place: best.place };
  // A walking user saying "I'm at F 33" where only F 33.2–33.5 exist: we know roughly where they are on the
  // route, so take the matching room closest to that instead of making them pick a number mid-corridor.
  if (position && near && best.confidence >= 0.5) {
    const close = matches.filter((m) => m.confidence >= best.confidence - 0.15).sort((a, b) => dist(near, a.place) - dist(near, b.place));
    return { place: close[0].place };
  }
  return { options: matches.slice(0, 4).map((m) => m.place) };
}

/**
 * "Nearest" by the user's own route, not a straight line: of the few closest candidates, the one with the
 * quickest route for their profile (a wheelchair user must not be sent to an entrance with steps). Falls back
 * to the closest when the start is unknown or no candidate has a route.
 */
function quickestReachable(near: Place | undefined, candidates: Place[], needs: string[], avoidStairs: boolean): Place | undefined {
  if (!near || candidates.length < 2) return candidates[0];
  const profile = { needs: needs as Need[], avoidStairs };
  let best: { place: Place; seconds: number } | undefined;
  for (const place of candidates.slice(0, 4)) {
    try {
      const r = planRoute(getGraph(), { routeId: 'probe', from: near, to: place, profile, options: getProfileOptions() });
      if (r.ok && (!best || r.totalDurationS < best.seconds)) best = { place, seconds: r.totalDurationS };
    } catch {
      /* unreachable candidate */
    }
  }
  return best?.place ?? candidates[0];
}

/** A graph node as a place-like position, for "near me" searches. */
function positionAt(nodeId: string | undefined): Place | undefined {
  if (!nodeId) return undefined;
  const n = getGraph().nodes.get(nodeId);
  if (!n || n.lat == null || n.lon == null) return undefined;
  return { id: `node:${n.id}`, name: 'your position', kind: 'landmark', levelId: n.levelId ?? '', verticalOrder: n.verticalOrder, lat: n.lat, lon: n.lon, nodeId: n.id, aliases: [] };
}

function dist(a: Place, b: Place): number {
  const g = getGraph();
  const pa = g.xy(a);
  const pb = g.xy(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) + 20 * Math.abs((a.verticalOrder ?? 0) - (b.verticalOrder ?? 0));
}

/** The confirmation the user hears for a proposed trip (written here, not by the model, so it is exact). */
export function tripReply(from?: Place, to?: Place, options?: Place[], optionsFor?: 'from' | 'to'): string {
  if (options?.length) {
    const list = options.map((p, i) => `${i + 1}, ${spoken(p)}`).join('; ');
    return `${optionsFor === 'from' ? 'Where are you? ' : 'Which one? '}I found: ${list}. Say the number.`;
  }
  if (from && to) return `From ${spoken(from)} to ${spoken(to)}. Is that right?`;
  if (to) return `Going to ${spoken(to)}. Where are you now? Say a room number or scan a sign.`;
  if (from) return `You are at ${spoken(from)}. Where do you want to go?`;
  return 'I did not catch the place. Say a room number, like H G F 30, or a place like the nearest toilet.';
}

export const agentRoutes = new Hono();

agentRoutes.post('/agent', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json<AgentResponse>({ ok: false, reason: 'invalid_request', message: parsed.error.issues.map((i) => i.path.join('.')).join(', ') }, 400);
  const req = parsed.data as AgentRequest;
  const openai = getOpenAI();
  if (!openai) return c.json<AgentResponse>({ ok: false, reason: 'disabled', message: 'The voice agent needs an OpenAI key on the server.' });
  const ctx = req.context;
  // Place names come from the graph by id, never from the client, so they cannot carry instructions.
  const nameOf = (ref?: { id: string; name: string }) => (ref ? getPlace(ref.id)?.name ?? 'unknown' : 'unknown');
  const userText = [
    `Phase: ${ctx.phase}`,
    `From: ${nameOf(ctx.from)}`,
    `To: ${nameOf(ctx.to)}`,
    ctx.options?.length ? `Options read out: ${ctx.options.map((o, i) => `${i + 1}. ${nameOf(o)}`).join('; ')}` : '',
    `Needs: ${[...ctx.needs, ...(ctx.avoidStairs ? ['avoidStairs'] : [])].join(', ') || 'none'}`,
    ctx.step ? `Current instruction: ${JSON.stringify(ctx.step)}` : '',
    // Quoted as data: the utterance is what the user said, not instructions for the agent.
    `User said: ${JSON.stringify(req.utterance.trim())}`,
  ].filter(Boolean).join('\n');

  const started = Date.now();
  let aborted = false;
  try {
    const response = await withTimeout(TIMEOUT_MS, (signal) => {
      signal.addEventListener('abort', () => (aborted = true), { once: true });
      return openai.responses.create(
        {
          model: textModel(),
          instructions: buildSystemPrompt(),
          input: userText,
          text: { format: { type: 'json_schema', name: 'agent', schema: JSON_SCHEMA, strict: true } },
          reasoning: reasoningEffort(),
          // A bounded answer (includes reasoning tokens): no request can turn the agent into a free essay writer.
          max_output_tokens: 800,
          store: false,
        },
        { signal },
      );
    });
    let raw: unknown;
    try {
      raw = JSON.parse(response.output_text);
    } catch {
      return c.json<AgentResponse>({ ok: false, reason: 'model_error', message: 'The agent answered in an unexpected format.' });
    }
    const out = modelOutput.safeParse(raw);
    if (!out.success) return c.json<AgentResponse>({ ok: false, reason: 'model_error', message: 'The agent answered in an unexpected format.' });
    const m = { ...out.data, from_text: placeText(out.data.from_text), to_text: placeText(out.data.to_text) };
    const latencyMs = Date.now() - started;
    // Spoken to a blind user: same safety filter as the camera (no "the way is clear"), and bounded.
    const reply = sanitizeUtterance(m.reply, 30).slice(0, MAX_REPLY_CHARS);
    if ((out.data.from_text && !m.from_text) || (out.data.to_text && !m.to_text)) {
      return c.json<AgentResponse>({ ok: true, action: 'none', reply: tripReply(), latencyMs });
    }

    if (m.action === 'set_trip' || ((m.action === 'confirm' || m.action === 'none') && (m.from_text || m.to_text))) {
      const knownFrom = ctx.from ? getPlace(ctx.from.id) : undefined;
      // A walking user saying where they are ("I'm at the elevator") means the one near their route position.
      const fromR = m.from_text ? resolvePlace(m.from_text, positionAt(ctx.nearNodeId), ctx.needs, false, true) : {};
      const from = fromR.place ?? (m.from_text ? undefined : knownFrom);
      const toR = m.to_text ? resolvePlace(m.to_text, from ?? knownFrom, ctx.needs, Boolean(ctx.avoidStairs)) : {};
      const to = toR.place ?? (m.to_text ? undefined : ctx.to ? getPlace(ctx.to.id) : undefined);
      if (from && to && from.id === to.id) {
        // Usually "take me back" heard as the place the user already stands in.
        return c.json<AgentResponse>({ ok: true, action: 'set_trip', reply: `You are already at ${spoken(from)}. Where do you want to go?`, from, latencyMs });
      }
      const options = fromR.options ?? toR.options;
      const optionsFor = fromR.options ? 'from' : toR.options ? 'to' : undefined;
      const missingNamed = (m.from_text && !fromR.place && !fromR.options) || (m.to_text && !toR.place && !toR.options);
      const text = missingNamed && !options
        ? `I could not find ${m.to_text && !toR.place ? m.to_text : m.from_text}. Say a room number, like H G F 30.`
        : tripReply(from, to, options, optionsFor);
      return c.json<AgentResponse>({ ok: true, action: 'set_trip', reply: text, from, to, options, optionsFor, latencyMs });
    }
    const needs = m.action === 'set_needs' ? { add: m.needs_add, remove: m.needs_remove } as { add: (Need | 'avoidStairs')[]; remove: (Need | 'avoidStairs')[] } : undefined;
    return c.json<AgentResponse>({ ok: true, action: m.action, reply, option: m.option ?? undefined, needs, latencyMs });
  } catch (err) {
    const { reason, message } = classifyError(err, aborted);
    console.warn(`agent failed: ${reason} (${describeError(err)})`);
    return c.json<AgentResponse>({ ok: false, reason, message });
  }
});
