import {
  API,
  type Intent,
  type IntentRequest,
  type Level,
  type LocalizeRequest,
  type LocalizeResult,
  type Place,
  type Profile,
  type RouteRequest,
  type RouteResult,
  type VisionRequest,
  type VisionResponse,
} from '@polyguide/shared';
import { mockLevels, mockLocalize, mockPlaces, mockRouteWheelchair, mockVisionResult } from '@polyguide/shared/src/fixtures';

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

function localSearch(query: string, kind?: Place['kind']): Place[] {
  const pool = kind ? mockPlaces.filter((place) => place.kind === kind) : mockPlaces;
  if (!query.trim()) return pool;
  const normalized = normalizeSearch(query);
  return pool
    .map((place) => ({ place, score: Math.min(...[place.name, place.label ?? '', ...place.aliases].map((candidate) => matchScore(normalized, normalizeSearch(candidate)))) }))
    .filter((match) => match.score <= 0.55)
    .sort((a, b) => a.score - b.score)
    .map((match) => match.place);
}

function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

function matchScore(query: string, candidate: string): number {
  if (!query || !candidate) return 1;
  if (candidate === query) return 0;
  if (candidate.startsWith(query) || candidate.includes(query)) return 0.1;
  const queryWords = query.split(' ');
  if (queryWords.every((word) => candidate.includes(word))) return 0.18;
  const distance = editDistance(query.replace(/ /g, ''), candidate.replace(/ /g, ''));
  return distance / Math.max(query.length, candidate.length);
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

export const api = {
  async levels(): Promise<Level[]> {
    try {
      return await getJson<Level[]>(API.levels);
    } catch {
      return mockLevels;
    }
  },

  async places(query = '', kind?: Place['kind']): Promise<Place[]> {
    const search = new URLSearchParams({ q: query, limit: '30' });
    if (kind) search.set('kind', kind);
    try {
      return await getJson<Place[]>(`${API.places}?${search}`);
    } catch {
      return localSearch(query, kind);
    }
  },

  async route(request: RouteRequest): Promise<RouteResult> {
    const fromRef = request.from;
    const toRef = request.to;
    try {
      const result = await postJson<RouteResult>(API.route, request);
      if (result.ok && result.routeId.startsWith('r_mock_') && toRef.type === 'place' && (fromRef.type === 'place' || fromRef.type === 'node')) {
        const from = fromRef.type === 'place'
          ? mockPlaces.find((place) => place.id === fromRef.placeId)
          : mockPlaces.find((place) => place.nodeId === fromRef.nodeId);
        const to = mockPlaces.find((place) => place.id === toRef.placeId);
        if (from && to) return fixtureRoute(from, to, request.profile);
      }
      return result;
    } catch {
      if (fromRef.type === 'place' && toRef.type === 'place') {
        const from = mockPlaces.find((place) => place.id === fromRef.placeId) ?? mockPlaces[0];
        const to = mockPlaces.find((place) => place.id === toRef.placeId) ?? mockPlaces[2];
        return fixtureRoute(from, to, request.profile);
      }
      return { ok: false, reason: 'server_error', message: 'The route service is unavailable. Please try again.' };
    }
  },

  async localize(request: LocalizeRequest): Promise<LocalizeResult> {
    try {
      return await postJson<LocalizeResult>(API.localize, request);
    } catch {
      if (request.roomText) {
        const matches = localSearch(request.roomText);
        const exact = matches[0];
        if (exact) return { ok: true, place: exact, nodeId: exact.nodeId, levelId: exact.levelId, confidence: 0.82, method: 'room_text', alternatives: matches.slice(1, 4) };
        return { ok: false, reason: 'no_match', message: 'I could not match that room sign. Try reading or saying its room number.' };
      }
      return mockLocalize;
    }
  },

  async vision(request: VisionRequest): Promise<VisionResponse> {
    try {
      return await postJson<VisionResponse>(API.vision, request);
    } catch {
      return { ok: true, ...mockVisionResult, latencyMs: 1 };
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
