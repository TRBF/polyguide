/**
 * POST /api/vision/check (SPEC §5.5). One structured-output call per frame, 6 s budget.
 * Privacy: the image is forwarded to the model and dropped. It is never logged or stored.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { VisionRequest, VisionResponse, VisionResult } from '@polyguide/shared';
import { getGraph, isNearRoute, matchPlaces, normRoom, routeStore } from '../graphStore';
import { classifyError, describeError, getOpenAI, reasoningEffort, visionModel, withTimeout } from './openai';
import { interpretSign, priorFrom } from '../where/signs';
import { VISION_JSON_SCHEMA, VISION_SYSTEM_PROMPT, buildVisionUserText, postProcessVision } from './visionPrompt';

const TIMEOUT_MS = 6000;
/** Triggers that must read small sign text (confirming arrival, locating, answering). Periodic/off_heading stay cheap. */
const HIGH_DETAIL = new Set(['localize', 'approaching_node', 'user_query']);
/** ~3 MB of base64 is far above a 1024 px JPEG at q 0.6; anything bigger is a client bug. */
const MAX_IMAGE_CHARS = 3_000_000;
/** A sign must match a known room at least this well before it can flag off-route. */
const ROOM_MATCH_MIN = 0.6;
const NEAR_ROUTE_M = 15;

const needSchema = z.enum(['wheelchair', 'blind', 'lowVision', 'lowStamina', 'avoidCrowds']);
// Every string is capped: whatever a client sends here becomes paid prompt tokens.
const shortText = z.string().max(80);
const landmarkSchema = z.object({
  label: shortText,
  kind: z.enum(['room_sign', 'elevator', 'stairs', 'entrance', 'poi', 'other']),
  side: z.enum(['left', 'right', 'ahead']).optional(),
  atDistanceM: z.number(),
  placeId: shortText.optional(),
});
const requestSchema = z.object({
  imageJpegBase64: z.string().min(100).max(MAX_IMAGE_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64'),
  trigger: z.enum(['approaching_node', 'off_heading', 'user_query', 'periodic', 'localize']),
  routeId: shortText.optional(),
  stepIndex: z.number().int().min(0).max(1000).optional(),
  step: z
    .object({
      text: z.string().max(300),
      maneuver: shortText,
      levelId: shortText,
      toLevelId: shortText.optional(),
      expectedLandmarks: z.array(landmarkSchema).max(30),
      distanceM: z.number(),
    })
    .optional(),
  nextStepText: z.string().max(300).optional(),
  headingDeltaDeg: z.number().nullable().optional(),
  needs: z.array(needSchema).max(5).default([]),
  userQuestion: z.string().max(500).optional(),
  language: z.enum(['en', 'de']).optional(),
});

function levelName(levelId: string | undefined): string | undefined {
  if (!levelId) return undefined;
  try {
    const l = getGraph().levels.find((x) => x.id === levelId);
    return l ? `floor ${l.name} (${l.id})` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Code decides off-route, not the model: a confidently matched room that is not near the stored
 * route means the user went the wrong way. Without a stored route we keep the model's guess.
 */
export function checkOffRoute(result: VisionResult, req: Pick<VisionRequest, 'routeId' | 'step'>): boolean {
  if (!req.routeId || !result.detectedRoomNames.length) return result.offRouteSuspected;
  try {
    if (!routeStore.get(req.routeId)) return result.offRouteSuspected;
    const expected = new Set((req.step?.expectedLandmarks ?? []).map((l) => normRoom(l.label)));
    let known = 0;
    for (const name of result.detectedRoomNames) {
      if (expected.has(normRoom(name))) {
        known++;
        continue;
      }
      // Read like a person would: the letter weighed against the floor the route is on, so "E 33" seen on
      // floor F is F 33 (its twin above), not a reason to reroute to another floor.
      const match = interpretSign(name, priorFrom({ levelId: req.step?.levelId }))[0];
      if (!match || match.probability < ROOM_MATCH_MIN) continue;
      known++;
      // null = route/place unknown to the store; only a definite false means off-route.
      if (isNearRoute(req.routeId, match.place.id, NEAR_ROUTE_M) === false) return true;
    }
    // Every recognised sign is on the route → not off-route, whatever the model guessed.
    return known > 0 ? false : result.offRouteSuspected;
  } catch {
    return result.offRouteSuspected;
  }
}

export const visionRoutes = new Hono();

visionRoutes.post('/vision/check', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // Only the issue paths, never the payload (it contains the image).
    return c.json({ ok: false, reason: 'invalid_request', message: parsed.error.issues.map((i) => i.path.join('.') || 'body').join(', ') }, 400);
  }
  const req = parsed.data as VisionRequest;
  const openai = getOpenAI();
  if (!openai) return c.json<VisionResponse>({ ok: false, reason: 'disabled', message: 'OPENAI_API_KEY is not set.' });

  const t0 = performance.now();
  let aborted = false;
  try {
    const response = await withTimeout(TIMEOUT_MS, (signal) => {
      signal.addEventListener('abort', () => (aborted = true), { once: true });
      return openai.responses.create(
        {
          model: visionModel(),
          instructions: VISION_SYSTEM_PROMPT,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: buildVisionUserText(req, levelName(req.step?.levelId)) },
                {
                  type: 'input_image',
                  image_url: `data:image/jpeg;base64,${req.imageJpegBase64}`,
                  // Room signs are small: any check that has to read one uses the high-res tiles.
                  detail: HIGH_DETAIL.has(req.trigger) ? 'high' : 'low',
                },
              ],
            },
          ],
          text: { format: { type: 'json_schema', name: 'vision_result', schema: VISION_JSON_SCHEMA, strict: true } },
          reasoning: reasoningEffort(),
          // A bounded answer (includes reasoning tokens): caps the cost of any single request.
          max_output_tokens: 1200,
          store: false,
        },
        { signal },
      );
    });
    const latencyMs = Math.round(performance.now() - t0);
    let raw: unknown;
    try {
      raw = JSON.parse(response.output_text);
    } catch {
      return c.json<VisionResponse>({ ok: false, reason: 'model_error', message: 'Model returned invalid JSON.' });
    }
    const result = postProcessVision(raw, latencyMs);
    result.offRouteSuspected = checkOffRoute(result, req);
    console.log(`vision ${req.trigger} ${latencyMs} ms conf=${result.confidence.toFixed(2)} rooms=[${result.detectedRoomNames.join(', ')}] at=${result.atExpectedPoint} off=${result.offRouteSuspected}`);
    return c.json<VisionResponse>({ ok: true, ...result });
  } catch (err) {
    const { reason, message } = classifyError(err, aborted);
    console.warn(`vision ${req.trigger} failed after ${Math.round(performance.now() - t0)} ms: ${reason} (${describeError(err)})`);
    return c.json<VisionResponse>({ ok: false, reason, message });
  }
});
