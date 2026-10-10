/**
 * POST /api/position: what is around a point the client believes the user is at. The voice agent gets this
 * with every turn, so it can say "the door on your left should be HG F 33" or check a sign it just read.
 * Bearings are absolute (compass); the client turns them into left/right with the live phone heading.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { EdgeKind, NearbyPlace, PositionInfo, PositionRequest } from '@polyguide/shared';
import { bearingDeg, dist2D } from '@polyguide/routing';
import { getGraph, getPlace, nearestNode } from './graphStore';

const NEARBY_M = 25;
const MAX_NEARBY = 10;
const GPS_ENTRANCE_M = 40;
const GPS_MAX_ACCURACY_M = 30;

const requestSchema = z.object({
  placeId: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  levelId: z.string().optional(),
  gps: z.object({ lat: z.number(), lon: z.number(), accuracyM: z.number() }).optional(),
});

export function describePosition(req: PositionRequest): PositionInfo {
  const g = getGraph();
  const place = req.placeId ? getPlace(req.placeId) : undefined;
  const point = place ?? (req.lat != null && req.lon != null ? { lat: req.lat, lon: req.lon } : undefined);
  const levelId = place?.levelId ?? req.levelId;
  if ((!point || !levelId) && req.gps) return gpsCandidates(req.gps);
  if (!point || !levelId) return { ok: false, message: 'Send a placeId, lat, lon and levelId, or gps.' };

  const here = g.xy(point);
  const placeNode = place ? g.nodes.get(place.nodeId) : undefined;
  const snap = placeNode ? { node: placeNode, distM: dist2D(here, g.xy(placeNode)) } : nearestNode(point, (n) => n.levelId === levelId);
  if (!snap) return { ok: false, message: `No corridor on level ${levelId}.` };

  // One entry per name: a room with several doors, or an elevator listed per floor, is one thing to the user.
  const seen = new Set<string>();
  const nearby: NearbyPlace[] = g.places
    .filter((p) => p.levelId === levelId && p.id !== place?.id)
    .map((p) => ({ p, d: dist2D(here, g.xy(p)) }))
    .filter((x) => x.d <= NEARBY_M)
    .sort((a, b) => a.d - b.d)
    .filter(({ p }) => !seen.has(p.name) && Boolean(seen.add(p.name)))
    .slice(0, MAX_NEARBY)
    .map(({ p, d }) => ({
      placeId: p.id,
      name: p.name,
      ...(p.label ? { label: p.label } : {}),
      kind: p.kind,
      ...(p.useType ? { useType: p.useType } : {}),
      distM: Math.round(d * 10) / 10,
      bearingDeg: Math.round(bearingDeg(here, g.xy(p))),
    }));

  const paths = walkableDirections(snap.node.id, levelId);

  let gpsEntrance: { name: string; distM: number } | undefined;
  if (req.gps && req.gps.accuracyM <= GPS_MAX_ACCURACY_M) {
    const gxy = g.xy(req.gps);
    const best = g.places
      .filter((p) => p.kind === 'entrance')
      .map((p) => ({ p, d: dist2D(gxy, g.xy(p)) }))
      .sort((a, b) => a.d - b.d)[0];
    if (best && best.d <= GPS_ENTRANCE_M) gpsEntrance = { name: best.p.label ?? best.p.name, distM: Math.round(best.d) };
  }

  return {
    ok: true,
    levelId,
    floor: levelId.split('.').at(-1) ?? levelId,
    nodeId: snap.node.id,
    snapM: Math.round(snap.distM * 10) / 10,
    nearby,
    paths,
    ...(gpsEntrance ? { gpsEntrance } : {}),
  };
}

/**
 * Directions one can walk from a node, read ~PATH_PROBE_M out along the graph so a 1 m door stub reports the
 * corridor it joins. Directions within 30° of each other are one way.
 */
const PATH_PROBE_M = 6;
function walkableDirections(startId: string, levelId: string): { bearingDeg: number; kind: EdgeKind; lengthM: number }[] {
  const g = getGraph();
  // A door (dead end) → the corridor node it joins: someone reading a door sign stands in the corridor.
  const stub = g.adj.get(startId) ?? [];
  if (stub.length === 1 && g.nodes.get(stub[0].to)?.levelId === levelId) startId = stub[0].to;
  const start = g.xy(g.node(startId));
  const ends: { bearingDeg: number; kind: EdgeKind; lengthM: number }[] = [];
  const seen = new Set([startId]);
  const queue: { id: string; d: number; kind: EdgeKind | null }[] = [{ id: startId, d: 0, kind: null }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { edge, to } of g.adj.get(cur.id) ?? []) {
      const n = g.nodes.get(to);
      if (!n || seen.has(to)) continue;
      seen.add(to);
      const d = cur.d + edge.lengthM;
      const kind = cur.kind && cur.kind !== 'entrance' ? cur.kind : edge.kind;
      if (n.levelId !== levelId) {
        // Stairs or an elevator leading off the floor: report where it starts.
        ends.push({ bearingDeg: Math.round(bearingDeg(start, g.xy(g.node(cur.id)))), kind: edge.kind, lengthM: Math.round(cur.d) });
      } else if (d >= PATH_PROBE_M) {
        if (dist2D(start, g.xy(n)) >= 1.5) ends.push({ bearingDeg: Math.round(bearingDeg(start, g.xy(n))), kind, lengthM: Math.round(d) });
      } else if ((g.adj.get(to)?.length ?? 0) > 1) {
        queue.push({ id: to, d, kind }); // dead ends this close are doors; the nearby list names them
      }
    }
  }
  const out: typeof ends = [];
  for (const e of ends.sort((a, b) => b.lengthM - a.lengthM)) {
    if (!out.some((o) => Math.abs(((o.bearingDeg - e.bearingDeg + 540) % 360) - 180) < 30)) out.push(e);
  }
  return out;
}

/**
 * Nothing known but a GPS fix (indoors it is ±20-60 m): the entrances and room doors within its radius on any
 * floor, as candidates for the agent to ask about ("are you near the main entrance or in the library?").
 */
function gpsCandidates(gps: { lat: number; lon: number; accuracyM: number }): PositionInfo {
  const g = getGraph();
  const here = g.xy(gps);
  const radius = Math.max(25, Math.min(gps.accuracyM, 80));
  const seen = new Set<string>();
  const nearby: NearbyPlace[] = g.places
    .filter((p) => p.kind !== 'poi' || /toilet|elevator|stairs|cafe|food|library/i.test(`${p.label ?? ''} ${p.name}`))
    .map((p) => ({ p, d: dist2D(here, g.xy(p)) }))
    .filter((x) => x.d <= radius)
    // Entrances first: a GPS fix good enough to use usually means the user is at the building's edge.
    .sort((a, b) => Number(b.p.kind === 'entrance') - Number(a.p.kind === 'entrance') || a.d - b.d)
    .filter(({ p }) => !seen.has(p.name) && Boolean(seen.add(p.name)))
    .slice(0, MAX_NEARBY)
    .map(({ p, d }) => ({ placeId: p.id, name: p.name, ...(p.label ? { label: p.label } : {}), kind: p.kind, ...(p.useType ? { useType: p.useType } : {}), distM: Math.round(d), bearingDeg: Math.round(bearingDeg(here, g.xy(p))) }));
  if (!nearby.length) return { ok: false, message: 'No place of HG within the GPS radius.' };
  return { ok: true, levelId: '', floor: 'unknown', nodeId: '', snapM: Math.round(gps.accuracyM), nearby, paths: [], fromGps: true };
}

export const positionRoutes = new Hono();

positionRoutes.post('/position', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json<PositionInfo>({ ok: false, message: 'invalid request' }, 400);
  return c.json<PositionInfo>(describePosition(parsed.data));
});
