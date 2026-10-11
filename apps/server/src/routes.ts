/** Real (non-mock) API: SPEC §7, backed by data/hg/graph.json. */
import { Hono } from 'hono';
import { z } from 'zod';
import type { HealthResponse, LocalizeResult, Place, PlaceKind, RouteResult } from '@polyguide/shared';
import { planRoute } from '@polyguide/routing';
import {
  getGraph,
  getMapLayer,
  getPlace,
  getProfileOptions,
  matchPlaces,
  nearestNode,
  newRouteId,
  routeStore,
  searchPlaces,
} from './graphStore';
import { interpretSign, parseSign, priorFrom } from './where/signs';

/** Graph ids are short (e.g. "pl_lm_137", "30.0009"); anything longer is not an id. */
const idSchema = z.string().min(1).max(80);
/** Search text: a room code or a short name. */
const MAX_QUERY = 100;
const needSchema = z.enum(['wheelchair', 'blind', 'lowVision', 'lowStamina', 'avoidCrowds']);
const profileSchema = z.object({
  needs: z.array(needSchema).max(5).default([]),
  avoidStairs: z.boolean().optional(),
  avoidElevatorAt: z.array(idSchema).max(20).optional(),
  speedMps: z.number().positive().max(5).optional(),
  stepLengthM: z.number().positive().max(2).optional(),
  language: z.enum(['en', 'de']).optional(),
});
const locationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('place'), placeId: idSchema }),
  z.object({ type: z.literal('node'), nodeId: idSchema }),
  z.object({ type: z.literal('coord'), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), levelId: idSchema.optional() }),
]);
const routeSchema = z.object({ from: locationSchema, to: locationSchema, profile: profileSchema.default({ needs: [] }) });
const localizeSchema = z.object({
  roomText: z.string().max(MAX_QUERY).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().nonnegative().optional(),
  levelHint: idSchema.optional(),
  near: z.object({
    nodeId: idSchema.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    levelId: idSchema.optional(),
    floorStrength: z.enum(['strong', 'weak']).optional(),
  }).optional(),
});
const PLACE_KINDS = ['room', 'poi', 'entrance', 'landmark', 'seat'] as const;

type Loc = z.infer<typeof locationSchema>;
type Resolved = Place | { name: string; nodeId: string; levelId: string };

function resolveLocation(loc: Loc, label: string): Resolved | undefined {
  const g = getGraph();
  if (loc.type === 'place') return getPlace(loc.placeId);
  if (loc.type === 'node') {
    const n = g.nodes.get(loc.nodeId);
    return n ? { name: label, nodeId: n.id, levelId: n.levelId ?? '' } : undefined;
  }
  const hit = nearestNode(loc, (n) => !loc.levelId || n.levelId === loc.levelId);
  return hit ? { name: label, nodeId: hit.node.id, levelId: hit.node.levelId ?? loc.levelId ?? '' } : undefined;
}

/** RouteResult.to must be a Place; wrap node/coord destinations. */
function asPlace(r: Resolved): Place {
  if ('id' in r) return r;
  const n = getGraph().node(r.nodeId);
  return { id: `node:${n.id}`, name: r.name, kind: 'landmark', levelId: r.levelId, verticalOrder: n.verticalOrder, lat: n.lat, lon: n.lon, nodeId: n.id, aliases: [] };
}

export const apiRoutes = new Hono();

apiRoutes.get('/health', (c) => {
  const g = getGraph();
  return c.json<HealthResponse>({
    ok: true,
    mock: false,
    graph: { nodes: g.nodes.size, edges: g.edges.size, places: g.places.length, dataSnapshotAt: g.json.dataSnapshotAt },
  });
});

apiRoutes.get('/levels', (c) => c.json(getGraph().levels));

apiRoutes.get('/places', (c) => {
  const q = (c.req.query('q') ?? '').slice(0, MAX_QUERY);
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10) || 10));
  const kindQ = c.req.query('kind');
  const kind = PLACE_KINDS.find((k) => k === kindQ) as PlaceKind | undefined;
  const near = c.req.query('near')?.slice(0, 80) || undefined;
  return c.json(searchPlaces(q, limit, kind, near));
});

// Default: room outlines only (what the app draws, ~5x smaller). ?layers=all adds pathways and place points.
apiRoutes.get('/map/:levelId', (c) => {
  const layer = getMapLayer(c.req.param('levelId'));
  if (c.req.query('layers') === 'all') return c.json(layer);
  return c.json({ ...layer, features: layer.features.filter((f) => f.properties.layer === 'room') });
});

apiRoutes.post('/route', async (c) => {
  const parsed = routeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json<RouteResult>({ ok: false, reason: 'invalid_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
  }
  const { from: fromRef, to: toRef, profile } = parsed.data;
  const from = resolveLocation(fromRef, 'Your location');
  const to = resolveLocation(toRef, 'Destination');
  if (!from || !to) {
    return c.json<RouteResult>({ ok: false, reason: 'unknown_place', message: `Unknown ${!from ? 'start' : 'destination'}.` });
  }
  try {
    const result = planRoute(getGraph(), { routeId: newRouteId(), from, to: asPlace(to), profile, options: getProfileOptions() });
    if (result.ok) routeStore.set(result);
    return c.json<RouteResult>(result);
  } catch (err) {
    console.error('route error', err);
    return c.json<RouteResult>({ ok: false, reason: 'server_error', message: 'Could not compute the route.' }, 500);
  }
});

apiRoutes.post('/localize', async (c) => {
  const parsed = localizeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, reason: 'no_match', message: 'invalid request' }, 400);
  const { roomText, lat, lon, accuracyM, levelHint, near } = parsed.data;

  // A room sign (camera, or a code the user said): number = horizontal position, letter = floor, and likely
  // misreads count, weighed against where the user probably is (see where/signs.ts).
  if (roomText?.trim() && parseSign(roomText)) {
    const prior = priorFrom(near ? { ...near, levelId: near.levelId ?? levelHint } : levelHint ? { levelId: levelHint } : undefined, near?.floorStrength ?? 'strong');
    const candidates = interpretSign(roomText, prior);
    const best = candidates[0];
    if (best) {
      return c.json<LocalizeResult>({
        ok: true,
        place: best.place,
        nodeId: best.place.nodeId,
        levelId: best.place.levelId,
        confidence: best.probability,
        method: 'room_text',
        alternatives: candidates.slice(1).map((m) => m.place),
        ...(best.note ? { note: best.note } : {}),
      });
    }
  }

  if (roomText?.trim()) {
    // Text that looks like a room code ("F 33", "hg e41") must resolve to a room, never to a toilet or café.
    const kind = /^[a-z]{0,3}\s*[a-z]{1,2}\s*\d/i.test(roomText.trim()) ? ('room' as const) : undefined;
    const matches = matchPlaces(roomText, { limit: 4, levelId: levelHint, kind });
    const all = matches.length ? matches : matchPlaces(roomText, { limit: 4, kind });
    const best = all[0];
    if (!best || best.confidence < 0.3) {
      return c.json<LocalizeResult>({ ok: false, reason: 'no_match', message: `No room matches "${roomText}".` });
    }
    return c.json<LocalizeResult>({
      ok: true,
      place: best.place,
      nodeId: best.place.nodeId,
      levelId: best.place.levelId,
      confidence: +best.confidence.toFixed(2),
      method: 'room_text',
      alternatives: all.slice(1).map((m) => m.place),
    });
  }

  if (lat != null && lon != null) {
    if (accuracyM == null || accuracyM >= 20) {
      return c.json<LocalizeResult>({ ok: false, reason: 'gps_inaccurate', message: 'GPS accuracy is worse than 20 m.' });
    }
    const hit = nearestNode({ lat, lon }, (n) => !n.indoor);
    if (!hit || hit.distM > 50) {
      return c.json<LocalizeResult>({ ok: false, reason: 'indoor_gps_ignored', message: 'GPS is ignored indoors.' });
    }
    return c.json<LocalizeResult>({
      ok: true,
      nodeId: hit.node.id,
      levelId: hit.node.levelId ?? '',
      confidence: +Math.max(0.2, 1 - hit.distM / 50).toFixed(2),
      method: 'gps',
      alternatives: [],
    });
  }
  return c.json<LocalizeResult>({ ok: false, reason: 'no_match', message: 'Send roomText or lat/lon.' }, 400);
});
