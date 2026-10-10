/**
 * Loads data/hg at boot and holds the in-memory graph, search index and recent routes.
 * Helpers here are also used by Track B (vision prompt landmarks, off-route checks).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fuse from 'fuse.js';
import { useTypeFromText, type GraphJson, type GraphNode, type NodeId, type Overrides, type Place, type PlaceId, type RouteId, type RouteResult } from '@polyguide/shared';
import { Graph, dist2D, pointSegment, type ProfileOptions } from '@polyguide/routing';

const DATA_DIR = process.env.DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../data');
const HG_DIR = resolve(DATA_DIR, 'hg');

const readJson = <T>(path: string, fallback?: T): T => {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${path} (run pnpm fetch:eth && pnpm build:graph)`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

/* ───────────── Graph + options ───────────── */

let graph: Graph | null = null;
let profileOptions: ProfileOptions = {};
let fuse: Fuse<Place> | null = null;
const placeByNorm = new Map<string, Place>();

/** "HG F 30" / "hg f30" / "F 30." → "HGF30"; "F 30" → "F30". */
export const normRoom = (s: string) => s.toUpperCase().replace(/[\s.\-_,]+/g, '');

export function loadGraph(): Graph {
  const t0 = performance.now();
  const json = readJson<GraphJson>(resolve(HG_DIR, 'graph.json'));
  graph = new Graph(json);
  const overrides = readJson<Overrides>(resolve(DATA_DIR, 'overrides.json'), {
    closedEdges: [],
    edgeMultipliers: {},
    notes: {},
    seats: [],
  });
  const crowd = readJson<Record<string, number[]>>(resolve(HG_DIR, 'crowd.json'), {});
  profileOptions = {
    overrides,
    crowd,
    seats: overrides.seats.map((s) => ({ ...s, ...graph!.xy(s) })),
  };
  fuse = new Fuse(json.places, {
    keys: [
      { name: 'name', weight: 2 },
      { name: 'label', weight: 2 },
      { name: 'aliases', weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true,
  });
  placeByNorm.clear();
  // Rooms first so "HG E 41" resolves to the room rather than a POI inside it.
  for (const p of [...json.places].sort((a, b) => Number(b.kind === 'room') - Number(a.kind === 'room'))) {
    for (const key of [p.name, ...p.aliases]) {
      const k = normRoom(key);
      if (!placeByNorm.has(k)) placeByNorm.set(k, p);
    }
  }
  console.log(
    `graph: ${json.nodes.length} nodes, ${json.edges.length} edges, ${json.places.length} places, snapshot ${json.dataSnapshotAt} ` +
      `(loaded in ${(performance.now() - t0).toFixed(0)} ms; ${overrides.closedEdges.length} closed edges)`,
  );
  return graph;
}

export function getGraph(): Graph {
  return graph ?? loadGraph();
}

export const getProfileOptions = () => profileOptions;

export function getNode(id: NodeId): GraphNode | undefined {
  return getGraph().nodes.get(id);
}

export function getPlace(id: PlaceId): Place | undefined {
  return getGraph().places.find((p) => p.id === id);
}

/* ───────────── Search ───────────── */

export interface PlaceMatch {
  place: Place;
  /** 0..1 */
  confidence: number;
}

/** Ranked place matches for free text ("HG E 41", "e41", "audimax", "toilet"). */
export function matchPlaces(text: string, opts: { limit?: number; kind?: Place['kind']; levelId?: string; byType?: boolean } = {}): PlaceMatch[] {
  const g = getGraph();
  const limit = opts.limit ?? 10;
  const keep = (p: Place) => (!opts.kind || p.kind === opts.kind) && (!opts.levelId || p.levelId === opts.levelId);
  const out: PlaceMatch[] = [];
  const seen = new Set<string>();
  const push = (place: Place, confidence: number) => {
    if (!seen.has(place.id) && keep(place)) {
      seen.add(place.id);
      out.push({ place, confidence });
    }
  };
  const n = normRoom(text);
  const exact = placeByNorm.get(n) ?? placeByNorm.get(`${g.json.facility}${n}`);
  if (exact) push(exact, 0.95);
  // "seminar room" / "lecture hall" / "Hörsaal": every place of that type (search only; the caller ranks by distance).
  const type = opts.byType ? useTypeFromText(text) : undefined;
  if (type) for (const p of g.places) if (p.useType === type) push(p, 0.8);
  for (const r of fuse!.search(text, { limit: limit * 3 })) push(r.item, Math.max(0.05, Math.min(0.85, 1 - (r.score ?? 1))));
  return out.slice(0, limit);
}

/** Straight-line metres between two places, plus ~20 m per floor so other floors rank behind this one. */
function roughDistance(a: Place, b: Place): number {
  const g = getGraph();
  const pa = g.xy(a);
  const pb = g.xy(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) + 20 * Math.abs((a.verticalOrder ?? 0) - (b.verticalOrder ?? 0));
}

export function searchPlaces(q: string, limit = 10, kind?: Place['kind'], nearPlaceId?: string): Place[] {
  const near = nearPlaceId ? getPlace(nearPlaceId) : undefined;
  if (near && q.trim()) {
    // Rank every match by distance from the user, not by text score alone ("seminar room" near me).
    return matchPlaces(q, { limit: 1000, kind, byType: true })
      .map((m) => ({ place: m.place, d: roughDistance(near, m.place) - m.confidence * 30 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => x.place);
  }
  if (!q.trim()) return getGraph().places.filter((p) => !kind || p.kind === kind).slice(0, limit);
  return matchPlaces(q, { limit, kind, byType: true }).map((m) => m.place);
}

/** Best place for a name as read from a sign or said by the user. */
export function getPlaceByName(text: string, levelHint?: string): Place | undefined {
  return (matchPlaces(text, { limit: 1, levelId: levelHint })[0] ?? matchPlaces(text, { limit: 1 })[0])?.place;
}

export function nearestNode(p: { lat: number; lon: number }, filter: (n: GraphNode) => boolean = () => true): { node: GraphNode; distM: number } | undefined {
  const g = getGraph();
  const xy = g.xy(p);
  let best: { node: GraphNode; distM: number } | undefined;
  for (const n of g.nodes.values()) {
    if (!filter(n)) continue;
    const d = dist2D(n, xy);
    if (!best || d < best.distM) best = { node: n, distM: d };
  }
  return best;
}

/* ───────────── Route store ───────────── */

type OkRoute = Extract<RouteResult, { ok: true }>;
const MAX_ROUTES = 50;

class RouteStore {
  private routes = new Map<RouteId, OkRoute>();
  set(route: OkRoute) {
    this.routes.delete(route.routeId);
    this.routes.set(route.routeId, route);
    while (this.routes.size > MAX_ROUTES) this.routes.delete(this.routes.keys().next().value!);
  }
  get(id: RouteId): OkRoute | undefined {
    return this.routes.get(id);
  }
  get size() {
    return this.routes.size;
  }
}
export const routeStore = new RouteStore();

let routeSeq = 0;
export const newRouteId = () => `r_${Date.now().toString(36)}_${(routeSeq++).toString(36)}`;

/** Node ids along a stored route (start and end of every step plus all polyline nodes on the path). */
export function getRouteNodeIds(routeId: RouteId): NodeId[] {
  const r = routeStore.get(routeId);
  return r ? [...new Set(r.steps.flatMap((s) => [s.startNodeId, s.endNodeId]))] : [];
}

/**
 * Is the place within radiusM of the route (on the same level)? Used for vision off-route checks:
 * a room sign that is NOT near the route (false) suggests the user went the wrong way; null means unknown.
 */
export function isNearRoute(routeId: RouteId, placeId: PlaceId, radiusM = 10): boolean | null {
  const r = routeStore.get(routeId);
  const g = getGraph();
  const place = getPlace(placeId);
  // null = unknown (route evicted or server restarted): callers must NOT treat this as "off route".
  if (!r || !place) return null;
  const node = g.nodes.get(place.nodeId);
  const targets = [g.xy(place), ...(node ? [node] : [])];
  for (const s of r.steps) {
    if (s.levelId !== place.levelId && s.toLevelId !== place.levelId) continue;
    const pts = s.polyline.map(([lon, lat]) => g.xy({ lon, lat }));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      if (targets.some((t) => pointSegment(t, a, b).d <= radiusM)) return true;
    }
  }
  return false;
}

/* ───────────── Map layers ───────────── */

type Feature = { type: 'Feature'; geometry: any; properties: Record<string, unknown> };
let mapByLevel: Map<string, Feature[]> | null = null;

/** 6 decimals ≈ 0.1 m: plenty for drawing, and much smaller JSON. */
const round7 = (c: any): any => (typeof c[0] === 'number' ? [+c[0].toFixed(6), +c[1].toFixed(6)] : c.map(round7));

/** Room polygons + pathways per level for drawing (SPEC §7 /api/map/:levelId). Built lazily from the snapshot. */
export function getMapLayer(levelId: string): { type: 'FeatureCollection'; features: Feature[] } {
  if (!mapByLevel) {
    mapByLevel = new Map();
    const g = getGraph();
    const placeByName = new Map(g.places.filter((p) => p.kind === 'room').map((p) => [p.name, p]));
    const add = (lvl: string, f: Feature) => (mapByLevel!.get(lvl) ?? mapByLevel!.set(lvl, []).get(lvl)!).push(f);
    const units = readJson<{ features: { geometry: any; properties: any }[] }>(resolve(HG_DIR, 'units.geojson'));
    for (const u of units.features) {
      if (!u.geometry) continue;
      const p = u.properties;
      const place = placeByName.get(p.NAME);
      add(p.LEVEL_ID, {
        type: 'Feature',
        geometry: { type: u.geometry.type, coordinates: round7(u.geometry.coordinates) },
        properties: { layer: 'room', name: p.NAME, useType: p.USE_TYPE, placeId: place?.id ?? null, levelId: p.LEVEL_ID },
      });
    }
    for (const e of g.json.edges) {
      if (e.levelFrom !== e.levelTo || !e.levelFrom) continue;
      const a = g.nodes.get(e.from)!;
      const b = g.nodes.get(e.to)!;
      add(e.levelFrom, {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
        properties: { layer: 'pathway', kind: e.kind, edgeId: e.id, levelId: e.levelFrom },
      });
    }
    for (const p of g.places) {
      if (p.kind === 'room') continue;
      add(p.levelId, {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { layer: 'place', placeId: p.id, name: p.name, kind: p.kind, levelId: p.levelId },
      });
    }
  }
  return { type: 'FeatureCollection', features: mapByLevel.get(levelId) ?? [] };
}
