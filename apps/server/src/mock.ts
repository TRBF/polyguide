/**
 * USE_MOCK=1: every SPEC §7 endpoint serves packages/shared fixtures so Track C is never blocked.
 */
import { Hono } from 'hono';
import Fuse from 'fuse.js';
import {
  mockLevels,
  mockLocalize,
  mockPlaces,
  mockRouteWheelchair,
  mockVisionResult,
  type HealthResponse,
  type Intent,
  type IntentRequest,
  type LocalizeRequest,
  type LocalizeResult,
  type Place,
  type PlaceKind,
  type RouteRequest,
  type RouteResult,
  type VisionResponse,
} from '@polyguide/shared';

const fuse = new Fuse(mockPlaces, { keys: ['name', 'label', 'aliases'], threshold: 0.4, ignoreLocation: true });

function findPlace(text: string): Place | undefined {
  return fuse.search(text, { limit: 1 })[0]?.item;
}

export const mockRoutes = new Hono();

mockRoutes.get('/health', (c) =>
  c.json<HealthResponse>({
    ok: true,
    mock: true,
    graph: { nodes: 6, edges: 5, places: mockPlaces.length, dataSnapshotAt: null },
  }),
);

mockRoutes.get('/levels', (c) => c.json(mockLevels));

mockRoutes.get('/places', (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const limit = Number(c.req.query('limit') ?? 10) || 10;
  const kind = c.req.query('kind') as PlaceKind | undefined;
  let places = q ? fuse.search(q).map((r) => r.item) : mockPlaces;
  if (kind) places = places.filter((p) => p.kind === kind);
  return c.json(places.slice(0, limit));
});

mockRoutes.get('/map/:levelId', (c) => {
  const levelId = c.req.param('levelId');
  const steps = mockRouteWheelchair.steps.filter((s) => s.levelId === levelId && s.polyline.length > 1);
  return c.json({
    type: 'FeatureCollection',
    features: [
      ...steps.map((s) => ({
        type: 'Feature',
        properties: { layer: 'pathway', kind: s.edgeKinds[0] ?? 'hallway', levelId },
        geometry: { type: 'LineString', coordinates: s.polyline },
      })),
      ...mockPlaces
        .filter((p) => p.levelId === levelId)
        .map((p) => ({
          type: 'Feature',
          properties: { layer: 'place', id: p.id, name: p.name, kind: p.kind, levelId },
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        })),
    ],
  });
});

mockRoutes.post('/route', async (c) => {
  const body = (await c.req.json().catch(() => null)) as RouteRequest | null;
  if (!body?.from || !body?.to) {
    return c.json<RouteResult>({ ok: false, reason: 'invalid_request', message: 'from and to are required' }, 400);
  }
  const toRef = body.to;
  const to = toRef.type === 'place' ? mockPlaces.find((p) => p.id === toRef.placeId) : undefined;
  return c.json<RouteResult>({
    ...mockRouteWheelchair,
    to: to ?? mockRouteWheelchair.to,
    profile: body.profile ?? mockRouteWheelchair.profile,
  });
});

mockRoutes.post('/localize', async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as LocalizeRequest;
  if (body.roomText) {
    const place = findPlace(body.roomText);
    if (!place) {
      return c.json<LocalizeResult>({ ok: false, reason: 'no_match', message: `No room matches "${body.roomText}"` });
    }
    return c.json<LocalizeResult>({
      ok: true,
      place,
      nodeId: place.nodeId,
      levelId: place.levelId,
      confidence: 0.9,
      method: 'room_text',
      alternatives: [],
    });
  }
  if (body.lat != null) {
    return c.json<LocalizeResult>({ ok: false, reason: 'indoor_gps_ignored', message: 'GPS is ignored indoors' });
  }
  return c.json<LocalizeResult>(mockLocalize);
});

mockRoutes.post('/vision/check', (c) => c.json<VisionResponse>({ ok: true, ...mockVisionResult }));

const INTENT_PATTERNS: [RegExp, Intent['type']][] = [
  [/^(next|continue)\b/i, 'next'],
  [/^(back|previous)\b/i, 'back'],
  [/^repeat\b/i, 'repeat'],
  [/^stop\b/i, 'stop'],
  [/where am i/i, 'where_am_i'],
  [/what'?s ahead/i, 'whats_ahead'],
  [/^help\b/i, 'help'],
];

mockRoutes.post('/intent', async (c) => {
  const body = (await c.req.json().catch(() => null)) as IntentRequest | null;
  const u = body?.utterance?.trim() ?? '';
  const nav = u.match(/^(?:navigate to|take me to|go to)\s+(.+)$/i);
  if (nav) return c.json<Intent>({ type: 'navigate_to', target: nav[1], source: 'llm' });
  const at = u.match(/^(?:i'?m at|i am at|i'?m next to)\s+(.+)$/i);
  if (at) return c.json<Intent>({ type: 'set_location', target: at[1], source: 'llm' });
  const hit = INTENT_PATTERNS.find(([re]) => re.test(u));
  return c.json<Intent>({ type: hit?.[1] ?? 'unknown', source: 'llm' });
});

mockRoutes.get('/dev/compare', (c) =>
  c.json({ mock: true, from: c.req.query('from'), to: c.req.query('to'), mode: c.req.query('mode'), ours: null, eth: null }),
);
