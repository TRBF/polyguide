/**
 * POST /api/where — "where am I?" in one call: the camera reads signs and fingerprints the spot, the graph supplies
 * the places and walking distances around the user's last known position, and the evidence is fused into one node
 * that is described in plain words. Works without a photo (the prior alone) and without AI (no camera evidence).
 *
 * POST /api/refs — survey mode: the team captures reference spots on site (photo + the node they stand at). Only
 * the fingerprint and its embedding are stored. Locked behind SURVEY_TOKEN; GET /api/refs reports availability.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { NodeId, Place, RefCaptureResponse, WhereResponse } from '@polyguide/shared';
import { getGraph, getPlace, isNearRoute, matchPlaces } from '../graphStore';
import { classifyError, describeError, getOpenAI, reasoningEffort, visionModel, withTimeout } from '../ai/openai';
import { describeSpot, placesAt, walkDistances } from './graphNear';
import { fuse, type FuseInput } from './fuse';
import { LOCALIZE_JSON_SCHEMA, LOCALIZE_SYSTEM_PROMPT, parseObservation, type LandmarkKind, type LocalizeObservation } from './localizePrompt';
import { addRef, embed, fingerprintText, loadRefs, nearestRefs, refStats } from './refs';

const TIMEOUT_MS = 10_000;
const MAX_IMAGE_CHARS = 3_000_000;
const PRIOR_REACH_M = 300;
const LANDMARK_REACH_M = 80;

const image = z.string().min(100).max(MAX_IMAGE_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64');
const whereSchema = z.object({
  imageJpegBase64: image.optional(),
  nearNodeId: z.string().max(80).optional(),
  routeId: z.string().max(80).optional(),
  language: z.enum(['en', 'de']).optional(),
});
const captureSchema = z.object({
  imageJpegBase64: image,
  nodeId: z.string().max(80).optional(),
  placeId: z.string().max(80).optional(),
  headingDeg: z.number().min(0).max(360).optional(),
}).refine((b) => b.nodeId || b.placeId, 'nodeId or placeId');

/** One camera call: signs, floor letter, landmark kinds and the fingerprint. */
async function observe(imageJpegBase64: string, signal: AbortSignal): Promise<LocalizeObservation> {
  const openai = getOpenAI()!;
  const response = await openai.responses.create({
    model: visionModel(),
    instructions: LOCALIZE_SYSTEM_PROMPT,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Where is this? Read every sign you can.' },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${imageJpegBase64}`, detail: 'high' },
      ],
    }],
    text: { format: { type: 'json_schema', name: 'localize', schema: LOCALIZE_JSON_SCHEMA, strict: true } },
    reasoning: reasoningEffort(),
    max_output_tokens: 900,
    store: false,
  }, { signal });
  return parseObservation(JSON.parse(response.output_text));
}

/* ───── Landmark kinds → graph nodes ───── */

const PLACE_KIND: Partial<Record<LandmarkKind, (p: Place) => boolean>> = {
  elevator: (p) => /elevator/i.test(p.label ?? p.name),
  toilet_sign: (p) => /toilet/i.test(p.label ?? p.name),
  cafeteria: (p) => /food|drink|caf|mensa/i.test(`${p.label ?? ''} ${p.name}`),
  library: (p) => /library/i.test(p.label ?? p.name),
  cloakroom: (p) => /cloakroom/i.test(p.label ?? p.name),
  information_desk: (p) => /information/i.test(p.label ?? p.name),
  entrance_doors: (p) => p.kind === 'entrance',
  lecture_hall_doors: (p) => p.kind === 'room' && /hörsaal|horsaal|h.rsaal|lecture/i.test(`${p.useType ?? ''} ${p.label ?? ''}`),
};
let stairNodes: Set<NodeId> | null = null;
const isStairNode = (id: NodeId) => {
  if (!stairNodes) {
    stairNodes = new Set();
    for (const e of getGraph().edges.values()) if (e.kind === 'stairs') { stairNodes.add(e.from); stairNodes.add(e.to); }
  }
  return stairNodes.has(id);
};

function landmarkNodes(kinds: LandmarkKind[], distances: Map<NodeId, number>): FuseInput['landmarks'] {
  const g = getGraph();
  const out: FuseInput['landmarks'] = [];
  for (const kind of kinds) {
    const test = PLACE_KIND[kind];
    if (!test && kind !== 'stairs') continue;
    const hits: { nodeId: NodeId; d: number }[] = [];
    for (const [id, d] of distances) {
      if (d > LANDMARK_REACH_M) continue;
      if (kind === 'stairs' ? isStairNode(id) : placesAt(id).some(test!)) hits.push({ nodeId: id, d });
    }
    for (const h of hits.sort((a, b) => a.d - b.d).slice(0, 3)) out.push({ nodeId: h.nodeId, levelId: g.nodes.get(h.nodeId)?.levelId ?? '', kind });
  }
  return out;
}

function signMatches(labels: string[], floorLevelId: string | null, minConfidence: number) {
  const out: FuseInput['signs'] = [];
  for (const label of labels) {
    const m = matchPlaces(label, { limit: 1, kind: 'room', levelId: floorLevelId ?? undefined })[0] ?? matchPlaces(label, { limit: 1, kind: 'room' })[0];
    if (m && m.confidence >= minConfidence) out.push({ nodeId: m.place.nodeId, levelId: m.place.levelId, label: m.place.name, confidence: m.confidence });
  }
  return out;
}

const SAY: Record<string, string> = {
  sign: 'Read the sign', photo: 'Matches a reference photo', partial_sign: 'Partly read the sign', landmark: 'Saw', route: 'Going by your route',
};

export const whereRoutes = new Hono();

whereRoutes.post('/where', async (c) => {
  const parsed = whereSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json<WhereResponse>({ ok: false, reason: 'invalid_request', message: parsed.error.issues.map((i) => i.path.join('.') || 'body').join(', ') }, 400);
  const req = parsed.data;
  const started = Date.now();
  const g = getGraph();
  const priorNode = req.nearNodeId ? g.nodes.get(req.nearNodeId) : undefined;
  const distances = priorNode ? walkDistances(priorNode.id, PRIOR_REACH_M) : null;

  let obs: LocalizeObservation | null = null;
  let photos: FuseInput['photos'] = [];
  let aiFailure: { reason: 'timeout' | 'model_error' | 'rate_limited'; message: string } | null = null;
  if (req.imageJpegBase64 && getOpenAI()) {
    let aborted = false;
    try {
      await withTimeout(TIMEOUT_MS, async (signal) => {
        signal.addEventListener('abort', () => (aborted = true), { once: true });
        obs = await observe(req.imageJpegBase64!, signal);
        const o = obs as LocalizeObservation;
        if (o.fingerprint && loadRefs().length) {
          const vector = await embed(fingerprintText(o.fingerprint, o.roomSigns), signal);
          if (vector) {
            photos = nearestRefs(vector, 5).map(({ ref, similarity }) => ({ nodeId: ref.nodeId, levelId: ref.levelId, similarity, refId: ref.id }));
          }
        }
      });
    } catch (err) {
      aiFailure = classifyError(err, aborted);
      console.warn(`where: camera failed: ${aiFailure.reason} (${describeError(err)})`);
    }
  }

  const o = obs as LocalizeObservation | null;
  const floorLevelId = o?.floorLetter ? `ETH.HG.${o.floorLetter}` : null;
  const result = fuse({
    signs: o ? signMatches(o.roomSigns, floorLevelId, 0.6) : [],
    partialSigns: o ? signMatches(o.partialSigns, floorLevelId, 0.5) : [],
    photos,
    landmarks: o && distances ? landmarkNodes(o.landmarks, distances) : [],
    floorLevelId: floorLevelId && g.levels.some((l) => l.id === floorLevelId) ? floorLevelId : null,
    prior: priorNode && distances ? { nodeId: priorNode.id, levelId: priorNode.levelId ?? '', distances } : null,
  });

  if (!result.best) {
    if (aiFailure && !priorNode) return c.json<WhereResponse>({ ok: false, reason: aiFailure.reason, message: aiFailure.message });
    return c.json<WhereResponse>({
      ok: false,
      reason: 'no_evidence',
      message: 'I could not tell where you are from here. Say a room number near you, like H G F 33, or the name of a place.',
    });
  }

  const spot = describeSpot(result.best.nodeId);
  const evidence = [...result.best.evidence].sort((a, b) => b.weight - a.weight).map((e) => `${SAY[e.kind] ?? e.kind}${e.kind === 'route' || e.kind === 'photo' ? '' : `: ${e.detail.replace(/_/g, ' ')}`}`);
  // Honest about how it knows: a reading is stated, a route-only answer says so.
  const how = result.method === 'route'
    ? (req.imageJpegBase64 ? ' I could not read a sign, so this is from your route.' : ' This is from your route.')
    : '';
  console.log(`where ${Date.now() - started} ms method=${result.method} conf=${result.confidence} node=${result.best.nodeId} signs=[${o?.roomSigns.join(', ') ?? ''}] photos=${photos.length}`);
  return c.json<WhereResponse>({
    ok: true,
    nodeId: result.best.nodeId,
    levelId: spot.levelId,
    place: spot.anchor,
    description: spot.text + how,
    confidence: result.confidence,
    method: result.method,
    evidence,
    // Only evidence from the camera can say the user left the route; the route's own guess never does.
    onRoute: req.routeId && spot.anchor && result.method !== 'route' ? isNearRoute(req.routeId, spot.anchor.id, 15) : null,
    latencyMs: Date.now() - started,
  });
});

/* ───── Survey mode ───── */

const surveyToken = () => process.env.SURVEY_TOKEN?.trim() ?? '';
function authorized(given: string | undefined): boolean {
  const want = surveyToken();
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

whereRoutes.get('/refs', (c) => c.json({ enabled: Boolean(surveyToken()), ...refStats() }));

whereRoutes.post('/refs', async (c) => {
  if (!surveyToken()) return c.json<RefCaptureResponse>({ ok: false, reason: 'disabled', message: 'Survey mode is off on this server (set SURVEY_TOKEN).' }, 403);
  if (!authorized(c.req.header('x-survey-token'))) return c.json<RefCaptureResponse>({ ok: false, reason: 'unauthorized', message: 'Wrong survey code.' }, 401);
  if (!getOpenAI()) return c.json<RefCaptureResponse>({ ok: false, reason: 'disabled', message: 'Capturing needs the OpenAI key on the server.' }, 503);
  const parsed = captureSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json<RefCaptureResponse>({ ok: false, reason: 'invalid_request', message: parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ') }, 400);
  const body = parsed.data;
  const nodeId = body.nodeId ?? (body.placeId ? getPlace(body.placeId)?.nodeId : undefined);
  const node = nodeId ? getGraph().nodes.get(nodeId) : undefined;
  if (!node) return c.json<RefCaptureResponse>({ ok: false, reason: 'invalid_request', message: 'Unknown spot.' }, 400);

  let aborted = false;
  try {
    const { obs, vector } = await withTimeout(TIMEOUT_MS, async (signal) => {
      signal.addEventListener('abort', () => (aborted = true), { once: true });
      const o = await observe(body.imageJpegBase64, signal);
      return { obs: o, vector: o.fingerprint ? await embed(fingerprintText(o.fingerprint, o.roomSigns), signal) : null };
    });
    if (!vector) return c.json<RefCaptureResponse>({ ok: false, reason: 'model_error', message: 'Nothing recognisable in this photo; try another view of the same spot.' });
    const id = `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    addRef({
      id, nodeId: node.id, levelId: node.levelId ?? '', headingDeg: body.headingDeg, fingerprint: obs.fingerprint,
      signs: obs.roomSigns, embedding: vector, source: 'survey', createdAt: new Date().toISOString(),
    });
    console.log(`refs: captured ${id} at ${node.id} (${node.levelId}) signs=[${obs.roomSigns.join(', ')}]`);
    return c.json<RefCaptureResponse>({ ok: true, id, nodeId: node.id, levelId: node.levelId ?? '', signs: obs.roomSigns, fingerprint: obs.fingerprint, total: loadRefs().length });
  } catch (err) {
    const { reason, message } = classifyError(err, aborted);
    console.warn(`refs: capture failed: ${reason} (${describeError(err)})`);
    return c.json<RefCaptureResponse>({ ok: false, reason, message });
  }
});
