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

const needSchema = z.enum(['wheelchair', 'blind', 'lowVision', 'lowStamina', 'avoidCrowds']);
const profileSchema = z.object({
  needs: z.array(needSchema).default([]),
  avoidStairs: z.boolean().optional(),
  speedMps: z.number().positive().max(5).optional(),
  stepLengthM: z.number().positive().optional(),
  language: z.enum(['en', 'de']).optional(),
});
const locationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('place'), placeId: z.string() }),
  z.object({ type: z.literal('node'), nodeId: z.string() }),
  z.object({ type: z.literal('coord'), lat: z.number(), lon: z.number(), levelId: z.string().optional() }),
]);
const routeSchema = z.object({ from: locationSchema, to: locationSchema, profile: profileSchema.default({ needs: [] }) });
const localizeSchema = z.object({
  roomText: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  accuracyM: z.number().optional(),
  levelHint: z.string().optional(),
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
  const q = c.req.query('q') ?? '';
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10) || 10));
  const kindQ = c.req.query('kind');
  const kind = PLACE_KINDS.find((k) => k === kindQ) as PlaceKind | undefined;
  return c.json(searchPlaces(q, limit, kind));
});

apiRoutes.get('/map/:levelId', (c) => c.json(getMapLayer(c.req.param('levelId'))));

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
    return c.json<RouteResult>({ ok: false, reason: 'server_error', message: String(err) }, 500);
  }
});

apiRoutes.post('/localize', async (c) => {
  const parsed = localizeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, reason: 'no_match', message: 'invalid request' }, 400);
  const { roomText, lat, lon, accuracyM, levelHint } = parsed.data;

  if (roomText?.trim()) {
    const matches = matchPlaces(roomText, { limit: 4, levelId: levelHint });
    const all = matches.length ? matches : matchPlaces(roomText, { limit: 4 });
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
