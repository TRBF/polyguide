import {
  API,
  type AgentRequest,
  type AgentResponse,
  type Intent,
  type IntentRequest,
  type Level,
  type LocalizeRequest,
  type LocalizeResult,
  type Place,
  type Profile,
  type RouteRequest,
  type RouteResult,
  type RefCaptureRequest,
  type RefCaptureResponse,
  type VisionRequest,
  type VisionResponse,
  type WhereRequest,
  type WhereResponse,
} from '@polyguide/shared';
import { mockPlaces, mockRouteWheelchair } from '@polyguide/shared/src/fixtures';

export type FloorMap = {
  type: 'FeatureCollection';
  features: Array<Record<string, unknown>>;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

function fixtureRoute(from: Place, to: Place, profile: Profile): Extract<RouteResult, { ok: true }> {
  if (from.id === 'pl_entrance_main' && to.id === 'pl_hg_f_30') {
    const routeId = `${mockRouteWheelchair.routeId}_${profile.needs.join('_') || 'default'}`;
    if (profile.needs.includes('wheelchair') || profile.avoidStairs) {
      return { ...mockRouteWheelchair, from, to, profile, routeId };
    }
    return {
      ...mockRouteWheelchair,
      from,
      to,
      profile,
      routeId,
      profileSummary: ['Uses stairs'],
      steps: mockRouteWheelchair.steps.map((step) => step.index === 2
        ? { ...step, maneuver: 'take_stairs_up', text: 'Take the stairs up to floor F', speech: 'Take the stairs up to floor F.', edgeKinds: ['stairs'] }
        : step),
    };
  }

  const latDeltaM = (to.lat - from.lat) * 110540;
  const lonDeltaM = (to.lon - from.lon) * 111320 * Math.cos((from.lat * Math.PI) / 180);
  const distanceM = Math.max(18, Math.round(Math.hypot(latDeltaM, lonDeltaM)));
  const timeS = Math.round(distanceM / (profile.needs.includes('wheelchair') ? 1 : 1.3));
  const line: [number, number][] = [[from.lon, from.lat], [to.lon, to.lat]];
  return {
    ok: true,
    routeId: `r_mock_${from.id}_${to.id}`,
    from,
    to,
    profile,
    profileSummary: profile.needs.includes('wheelchair') ? ['Step-free route (mock)'] : ['Mock route'],
    totalDistanceM: distanceM,
    totalDurationS: timeS,
    levels: from.levelId === to.levelId ? [from.levelId] : [from.levelId, to.levelId],
    warnings: ['This route is a local fixture because the route service is unavailable.'],
    engine: 'own',
    steps: [
      {
        index: 0,
        maneuver: 'depart',
        text: `Go toward ${to.name}`,
        speech: `Go toward ${to.name}.`,
        distanceM,
        durationS: timeS,
        bearingDeg: (Math.atan2(lonDeltaM, latDeltaM) * 180 / Math.PI + 360) % 360,
        levelId: from.levelId,
        startNodeId: from.nodeId,
        endNodeId: to.nodeId,
        polyline: line,
        expectedLandmarks: [],
        edgeKinds: ['hallway'],
      },
      {
        index: 1,
        maneuver: 'arrive',
        text: `Arrived: ${to.name}`,
        speech: `You have arrived at ${to.name}.`,
        distanceM: 0,
        durationS: 0,
        bearingDeg: null,
        levelId: to.levelId,
        startNodeId: to.nodeId,
        endNodeId: to.nodeId,
        polyline: [[to.lon, to.lat], [to.lon, to.lat]],
        expectedLandmarks: [{ label: to.name, kind: 'room_sign', side: 'ahead', atDistanceM: 0, placeId: to.id }],
        side: 'ahead',
        edgeKinds: [],
      },
    ],
  };
}

/** Never fabricate data: when the server is unreachable we report it, so the user is told instead of misled. */
const UNAVAILABLE = 'The PolyGuide server is unavailable. Please try again.';

async function postJsonLenient<T>(url: string, body: unknown): Promise<T | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const api = {
  async levels(): Promise<Level[]> {
    return getJson<Level[]>(API.levels);
  },

  /** Throws when the server is unreachable; callers show an error instead of stale/fake places. */
  /** `near`: a place id; results are then ordered by distance from it. */
  async places(query = '', kind?: Place['kind'], near?: string): Promise<Place[]> {
    const search = new URLSearchParams({ q: query, limit: '30' });
    if (kind) search.set('kind', kind);
    if (near) search.set('near', near);
    return getJson<Place[]>(`${API.places}?${search}`);
  },

  async route(request: RouteRequest): Promise<RouteResult> {
    const fromRef = request.from;
    const toRef = request.to;
    try {
      const result = await postJsonLenient<RouteResult>(API.route, request);
      if (!result) return { ok: false, reason: 'server_error', message: UNAVAILABLE };
      // Only the server's own mock mode (USE_MOCK=1) returns r_mock_ ids; fixture routing stays a dev aid.
      if (result.ok && result.routeId.startsWith('r_mock_') && toRef.type === 'place' && (fromRef.type === 'place' || fromRef.type === 'node')) {
        const from = fromRef.type === 'place'
          ? mockPlaces.find((place) => place.id === fromRef.placeId)
          : mockPlaces.find((place) => place.nodeId === fromRef.nodeId);
        const to = mockPlaces.find((place) => place.id === toRef.placeId);
        if (from && to) return fixtureRoute(from, to, request.profile);
      }
      return result;
    } catch {
      return { ok: false, reason: 'server_error', message: UNAVAILABLE };
    }
  },

  async localize(request: LocalizeRequest): Promise<LocalizeResult> {
    try {
      const result = await postJsonLenient<LocalizeResult>(API.localize, request);
      if (result) return result;
    } catch {
      // fall through
    }
    return { ok: false, reason: 'no_match', message: UNAVAILABLE };
  },

  async vision(request: VisionRequest): Promise<VisionResponse> {
    try {
      const result = await postJsonLenient<VisionResponse>(API.vision, request);
      if (result) return result;
    } catch {
      // fall through
    }
    return { ok: false, reason: 'model_error', message: 'The camera check is unavailable right now.' };
  },

  /** The voice agent. Never throws: a failure comes back as ok:false so the caller can fall back to local parsing. */
  async agent(request: AgentRequest): Promise<AgentResponse> {
    try {
      const result = await postJsonLenient<AgentResponse>(API.agent, request);
      if (result) return result;
    } catch {
      // fall through
    }
    return { ok: false, reason: 'model_error', message: 'The voice agent is unavailable.' };
  },

  /** "Where am I?": camera + graph. Never throws. */
  async where(request: WhereRequest): Promise<WhereResponse> {
    try {
      const result = await postJsonLenient<WhereResponse>(API.where, request);
      if (result) return result;
    } catch {
      // fall through
    }
    return { ok: false, reason: 'model_error', message: UNAVAILABLE };
  },

  /** Survey mode: is capturing enabled on this server, and how many spots are in the library. */
  async refsStatus(): Promise<{ enabled: boolean; total: number; nodes: number; byLevel: Record<string, number> } | null> {
    try {
      return await getJson(API.refs);
    } catch {
      return null;
    }
  },

  /** Survey mode: save the spot the team member is standing at (the code is the server's SURVEY_TOKEN). */
  async captureRef(request: RefCaptureRequest, surveyCode: string): Promise<RefCaptureResponse> {
    try {
      const response = await fetch(API.refs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Survey-Token': surveyCode },
        body: JSON.stringify(request),
      });
      return (await response.json()) as RefCaptureResponse;
    } catch {
      return { ok: false, reason: 'model_error', message: UNAVAILABLE };
    }
  },

  async intent(request: IntentRequest): Promise<Intent> {
    try {
      return await postJson<Intent>(API.intent, request);
    } catch {
      return { type: 'unknown', source: 'llm' };
    }
  },

  async floorMap(levelId: string): Promise<FloorMap> {
    return getJson<FloorMap>(API.map(levelId));
  },
};
