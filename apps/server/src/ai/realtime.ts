/**
 * Realtime voice agent (speech to speech, OpenAI Realtime over WebRTC). The browser talks to OpenAI directly;
 * this server only mints a short-lived client secret with the session baked in (instructions, tools, voice), so
 * the API key never reaches the phone, and resolves place names for plan_trip against the graph.
 *
 * The tools run in the browser (it owns the camera, compass, step counter and the UI). Before every reply the
 * browser adds a fresh "[Live state]" system message: position estimate, heading, turn to face the route,
 * nearby room doors relative to where the phone points, GPS. See apps/web/src/realtime.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Place, RealtimeSessionResponse, ResolveTripResponse } from '@polyguide/shared';
import { getPlace } from '../graphStore';
import { buildingFacts, resolvePlace, tripReply } from './agent';
import { describeError, getOpenAI } from './openai';

export const realtimeModel = () => process.env.OPENAI_REALTIME_MODEL?.trim() || 'gpt-realtime-2.1';
const realtimeVoice = () => process.env.OPENAI_REALTIME_VOICE?.trim() || 'marin';
/** Reasoning-capable realtime models only. "minimal" or "low" keeps the first audio fast. */
const realtimeEffort = () => process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim() || 'low';

const TOOLS = [
  {
    type: 'function',
    name: 'get_position',
    description: 'Fresh live state: position estimate, heading, route step, nearby room doors relative to where the phone points, walkable directions, GPS. The same block is also sent before every user turn.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'look',
    description: 'Take a photo with the rear camera (where the phone points) and see it. Use it to read room signs, find doors, elevators, stairs and corridors, and to localize the user. The result says which compass direction the photo faced.',
    parameters: {
      type: 'object',
      properties: { purpose: { type: 'string', description: 'What you are looking for, e.g. "room sign to localize", "is the elevator ahead".' } },
      required: ['purpose'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'set_position',
    description: 'Tell the app where the user really is, after you read a room sign in a photo, recognised a landmark, or the user said so. Updates the position estimate (and the route while navigating). Returns the new live state.',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Room code as on the sign, e.g. "HG F 33", or a named place, e.g. "main entrance", "Audimax".' },
        evidence: { type: 'string', enum: ['sign', 'landmark', 'photo', 'user'], description: 'sign = you read it in a photo; landmark = recognised the place; photo = identify_room was confident; user = they told you.' },
        distance_m: { type: 'number', description: 'Roughly how far the user is from that sign or place (0 if standing at it).' },
      },
      required: ['place', 'evidence', 'distance_m'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'identify_room',
    description: 'Which room is the user in? Takes a photo and compares it with ETH Room Information photos of nearby candidate rooms (lecture halls, seminar, computer, meeting rooms and foyer exhibition spaces; corridors and offices have no photos). Use when the user is inside a room and no door sign is in view. Many HG rooms are built in identical pairs, so the result may be a short list of look-alikes.',
    parameters: {
      type: 'object',
      properties: {
        room_type: { type: 'string', enum: ['Lecture hall', 'Seminars / Courses', 'Computer', 'Meeting room', 'Exhibition space', 'Multipurpose room', 'unknown'], description: 'What the room looks like in the camera frame: tiered fixed seats = Lecture hall; tables for 20-50 = Seminars / Courses; rows of computers = Computer; one table = Meeting room; open hall with displays = Exhibition space.' },
        candidates: { type: 'array', items: { type: 'string' }, description: 'Rooms you suspect, e.g. ["HG E 1.1", "HG E 1.2"]; empty = chosen from the position estimate.' },
      },
      required: ['room_type', 'candidates'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'plan_trip',
    description: 'Propose a trip. Use for any destination or start the user names. Places are resolved against the building map; the result says what was found, options if ambiguous, and the exact sentence to confirm. Ask the user to confirm before start_navigation.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: ['string', 'null'], description: 'Start as a room code or place. null = the current position estimate.' },
        to: { type: ['string', 'null'], description: 'Destination: room code ("HG F 30"), name ("Audimax"), or kind ("nearest toilet", "a seminar room", "exit"). null = keep the current one.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'start_navigation',
    description: 'Start turn-by-turn guidance for the proposed trip once the user confirmed it. The app then speaks every step instruction itself.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'navigation',
    description: 'Step control while navigating: next = this step is done; back = previous step; repeat = the app repeats the instruction; stop = end guidance.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['next', 'back', 'repeat', 'stop'] } },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'set_needs',
    description: 'Update access needs; routes adapt (wheelchair and avoidStairs avoid stairs; blind turns on voice-first mode).',
    parameters: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string', enum: ['wheelchair', 'blind', 'lowVision', 'avoidStairs'] } },
        remove: { type: 'array', items: { type: 'string', enum: ['wheelchair', 'blind', 'lowVision', 'avoidStairs'] } },
      },
      required: ['add', 'remove'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'report_elevator_broken',
    description: 'The elevator on the route is out of service: avoid it and route again from here.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'emergency',
    description: 'The user is hurt, in danger, fell or asks for help: opens the emergency screen with call buttons and their location.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

let instructions: string | null = null;
function buildInstructions(): string {
  instructions ??= `You are PolyGuide, a calm, quick voice guide for blind, low-vision and wheelchair users inside the ETH Zürich main building (HG). You talk with the user like a sighted friend walking next to them.

# Style
- Spoken, short: one or two sentences, under 25 words unless asked for more. One clear action per sentence ("Turn right. Then walk about 10 metres to the door."). No lists, no markdown. Speak room codes as letters and numbers ("H G F 33").
- Speak only when the user talks to you or a tool result needs saying. Never fill silence, never comment on "[Camera, automatic]" notes unless they change what the user should do.
- Reply in the user's language (English or German).
- The app itself speaks each step instruction when navigation starts or a step changes. Do not read the route out step by step; answer questions and correct course.
- Never claim a path is clear or safe: you cannot see obstacles reliably. The user keeps their cane or guide dog.

# Live state
Before each user turn you get a system message starting with "[Live state]". It is the truth about the app right now: screen, trip, current step, position estimate and how it was obtained, phone heading, the next node of the path with its distance and the turn needed to face it, nearby room doors and facilities with their direction relative to where the phone points, walkable corridor directions, GPS. Use it in every answer. Directions in it are relative to the phone's rear camera, which is where the user points the phone, usually straight ahead.
Compass headings indoors can be off by 20-40 degrees near steel and electronics; if "compass unreliable", prefer landmarks over degrees.

# Seeing
Every user turn comes with a small camera frame ("[Camera, automatic]"): you always see roughly what is in front of the phone. Use it to answer and to notice signs, doors, stairs and rooms, but do not describe it unless it helps. For small text (room signs) or a careful look, call look: it takes a sharper photo.
While the position is unknown, the app also reads room signs in the background and tells you in a "[Camera, automatic]" note; the live state then has the new position.

# Knowing where the user is (most important)
Position sources, best first: a room sign you read in a photo; the user saying where they are; a confident identify_room match; the step counter along the route (drifts a few metres per step); a position remembered from an earlier session (they have probably moved: confirm it, e.g. "Are you still near H G F 33?"); GPS (indoors only a list of candidate places within tens of metres, any floor).
- A door sign only means the user stood in the corridor outside that door. If the user says they are inside a room, or the camera frame shows a room interior (rows of seats, tables, computers) that does not fit the position and its room type in the live state, the position is stale: check with identify_room before answering "where am I".
- Inside a lecture, seminar, computer or meeting room with no door sign in view: call identify_room with the room type you see. If it is confident, call set_position. If it returns look-alikes (identical twin rooms), say which ones it could be and ask for the number on the door, or ask the user to face the door so you can read the sign.
- If the position is unknown or low confidence and you need it (to plan a trip, or the user is lost or asks where they are): call look. If the photo shows a room sign, door number or a clear landmark, call set_position with it. If not, ask the user to turn slowly, e.g. "Please turn a quarter turn to your right and hold the phone up", then look again. Up to four looks cover a full circle. Every look tells you the compass direction it faced, so you know where each thing you saw is.
- Room signs in HG are small plates next to doors, e.g. "F 33" or "HG F 33.1". Door numbers on the same corridor are close together; the nearby list tells you which doors should be around, so use it to check what you read.
- If what you see contradicts the estimate (a sign for a room that is not nearby), trust the sign and call set_position.
- If you cannot localize after a few looks, ask the user for a room number they can feel or someone can read, or to walk to the next door.

# Guiding
- "Which way?", "where now?", "am I going right?": answer concretely from the live state, first the turn from the "Next node of the path" line (it is measured from where the user is now to the next point of the path), then how far ("then go about 6 metres and turn left"). Never answer with only "follow the instructions".
- While navigating, whenever you learn where the user really is (a sign in a photo, they tell you "I'm at the elevator"), call set_position: it moves the step guidance to that point, so the app's instructions match where they are. If they say they finished a step ("I'm at the door"), call navigation next.
- Use the live state to answer "where am I", "which way", "what is around me": e.g. "You are on floor F, the door on your left should be F 33. Turn about 40 degrees right to face the route." Use clock directions or left/right with rough degrees. For which way to go, use the "Next node of the path" (or "To face the route") line as given; never turn a compass bearing (e.g. "Phone points 200°") into a turn yourself.
- When the user seems off course (turn to face the route above 60 degrees while moving, or a sign that is not on the route), tell them how to turn, and look if unsure.
- During navigation you may call look to confirm a step end (elevator, door, junction) when the user asks or seems unsure.

# Trips
- When the user names a destination or start, call plan_trip. If they gave no start, pass from = null: the current estimate is used. If the start is unknown, localize first (look) or ask where they are.
- Read back the result's "say" sentence (or the options) and wait for yes. On yes, call start_navigation right away without saying anything first; afterwards say at most "Starting." because the app then reads the first instruction. Options are numbered; when the user picks one, call plan_trip again with that exact name.
- A tool result may contain "app_said": app messages that were not spoken yet. Say them (instructions word for word) in your answer.
- Some of your own earlier turns are app announcements you read aloud (step instructions, warnings); they are the app talking, not you deciding.
- Needs ("I use a wheelchair", "avoid stairs", "I am blind") → set_needs. Elevator out of order → report_elevator_broken. Danger, hurt, fell → emergency immediately.

# Building
The user speaks; transcription may garble room codes ("F seven" = "F 7", "H G E forty one" = "HG E 41", "F thirty point one" = "F 30.1").
${buildingFacts()}`;
  return instructions;
}

const resolveSchema = z.object({
  fromText: z.string().max(200).nullish(),
  toText: z.string().max(200).nullish(),
  nearPlaceId: z.string().optional(),
  needs: z.array(z.string()).default([]),
});

export const realtimeRoutes = new Hono();

realtimeRoutes.post('/realtime/session', async (c) => {
  const openai = getOpenAI();
  if (!openai) return c.json<RealtimeSessionResponse>({ ok: false, reason: 'disabled', message: 'The realtime voice needs an OpenAI key on the server.' });
  const body = (await c.req.json().catch(() => ({}))) as { language?: string };
  const model = realtimeModel();
  try {
    const secret = await openai.realtime.clientSecrets.create({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model,
        instructions: buildInstructions(),
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: { model: process.env.OPENAI_STT_MODEL?.trim() || 'gpt-4o-mini-transcribe', ...(body.language === 'de' ? { language: 'de' } : body.language === 'en' ? { language: 'en' } : {}) },
            // A phone held out in front, in a corridor.
            noise_reduction: { type: 'far_field' },
            // The browser adds the live state, then asks for the reply (create_response off).
            turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 450, create_response: false, interrupt_response: true },
          },
          output: { voice: realtimeVoice() },
        },
        tools: TOOLS as unknown as never,
        tool_choice: 'auto',
        ...(/realtime-2/.test(model) ? { reasoning: { effort: realtimeEffort() as 'low' } } : {}),
      },
    });
    return c.json<RealtimeSessionResponse>({ ok: true, clientSecret: secret.value, model, expiresAt: secret.expires_at });
  } catch (err) {
    console.warn(`realtime session failed: ${describeError(err)}`);
    const status = (err as { status?: number })?.status;
    return c.json<RealtimeSessionResponse>({ ok: false, reason: status === 429 ? 'rate_limited' : 'model_error', message: 'The realtime voice could not start.' });
  }
});

realtimeRoutes.post('/realtime/resolve', async (c) => {
  const parsed = resolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ say: 'invalid request' }, 400);
  const { fromText, toText, nearPlaceId, needs } = parsed.data;
  const near = nearPlaceId ? getPlace(nearPlaceId) : undefined;
  const fromR = fromText ? resolvePlace(fromText, undefined, needs) : {};
  const from: Place | undefined = fromR.place ?? (fromText ? undefined : near);
  const toR = toText ? resolvePlace(toText, from ?? near, needs) : {};
  const to = toR.place;
  const options = fromR.options ?? toR.options;
  const optionsFor = fromR.options ? 'from' : toR.options ? 'to' : undefined;
  const notFound = fromText && !fromR.place && !fromR.options ? fromText : toText && !toR.place && !toR.options ? toText : undefined;
  if (from && to && from.id === to.id) return c.json<ResolveTripResponse>({ from, say: `The user is already at ${from.name}.` });
  const say = notFound && !options ? `I could not find ${notFound} on the map.` : tripReply(from, to, options, optionsFor);
  return c.json<ResolveTripResponse>({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(options ? { options, optionsFor } : {}), ...(notFound ? { notFound } : {}), say });
});
