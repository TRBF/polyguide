/**
 * GET /api/dev/compare — our route vs ETH's NAServer (dev only; the one place we call ETH at runtime).
 *   ?from=<placeId|name>&to=<placeId|name>&mode=walking|wheelchair
 *   ?random=5[&mode=…][&seed=1]  → N random room pairs + summary (SPEC §4.1 validation, ±15 %)
 * ETH's Walking mode prohibits elevators, so for mode=walking we close our elevator edges too.
 */
import { Hono } from 'hono';
import { ETH_ARCGIS_BASE, type Place } from '@polyguide/shared';
import { planRoute } from '@polyguide/routing';
import { getGraph, getPlace, getPlaceByName, getProfileOptions } from './graphStore';

const ROUTE_URL = `${ETH_ARCGIS_BASE}/Hosted_Public_Network/NAServer/Route`;
type Mode = 'walking' | 'wheelchair';

let travelModes: Record<string, unknown>[] | null = null;
async function travelMode(mode: Mode) {
  if (!travelModes) {
    const res = await fetch(`${ROUTE_URL}?f=json`, { signal: AbortSignal.timeout(20_000) });
    travelModes = ((await res.json()) as { supportedTravelModes: Record<string, unknown>[] }).supportedTravelModes;
  }
  const m = travelModes.find((t) => String(t.name).toLowerCase() === mode);
  if (!m) throw new Error(`ETH travel mode ${mode} not found`);
  return m;
}

async function ethRoute(from: Place, to: Place, mode: Mode) {
  const g = getGraph();
  const stop = (p: Place) => {
    const n = g.node(p.nodeId);
    return { geometry: { x: n.lon, y: n.lat, z: n.z }, attributes: { Name: p.name } };
  };
  const body = new URLSearchParams({
    stops: JSON.stringify({ type: 'features', features: [stop(from), stop(to)], spatialReference: { wkid: 4326 } }),
    travelMode: JSON.stringify(await travelMode(mode)),
    returnDirections: 'true',
    directionsLanguage: 'en',
    directionsStyleName: 'NA Campus',
    directionsLengthUnits: 'esriNAUMeters',
    accumulateAttributeNames: 'Length',
    outSR: '4326',
    returnZ: 'true',
    f: 'json',
  });
  const t0 = performance.now();
  const res = await fetch(`${ROUTE_URL}/solve`, { method: 'POST', body, signal: AbortSignal.timeout(30_000) });
  const d = (await res.json()) as any;
  if (d.error) return { ok: false as const, error: d.error.message ?? JSON.stringify(d.error) };
  const attrs = d.routes?.features?.[0]?.attributes ?? {};
  const dirs: { attributes: { text: string; length?: number } }[] = d.directions?.[0]?.features ?? [];
  const dirLen = dirs.reduce((s, f) => s + (f.attributes.length ?? 0), 0);
  return {
    ok: true as const,
    distanceM: Math.round(attrs.Total_Length ?? dirLen),
    walkTimeMin: attrs.Total_WalkTime != null ? +Number(attrs.Total_WalkTime).toFixed(2) : null,
    latencyMs: Math.round(performance.now() - t0),
    directions: dirs.map((f) => f.attributes.text),
  };
}

function ours(from: Place, to: Place, mode: Mode) {
  const g = getGraph();
  const base = getProfileOptions();
  const overrides = base.overrides ?? { closedEdges: [], edgeMultipliers: {}, notes: {}, seats: [] };
  const options =
    mode === 'walking'
      ? { ...base, overrides: { ...overrides, closedEdges: [...overrides.closedEdges, ...g.json.edges.filter((e) => e.kind === 'elevator').map((e) => e.id)] } }
      : base;
  const r = planRoute(g, { routeId: 'compare', from, to, profile: { needs: mode === 'wheelchair' ? ['wheelchair'] : [] }, options });
  if (!r.ok) return { ok: false as const, error: r.message };
  return { ok: true as const, distanceM: r.totalDistanceM, durationS: r.totalDurationS, summary: r.profileSummary, steps: r.steps.map((s) => s.text) };
}

async function compare(from: Place, to: Place, mode: Mode) {
  const [o, e] = [ours(from, to, mode), await ethRoute(from, to, mode).catch((err) => ({ ok: false as const, error: String(err) }))];
  const diffPct = o.ok && e.ok && e.distanceM > 0 ? +(((o.distanceM - e.distanceM) / e.distanceM) * 100).toFixed(1) : null;
  return { from: from.name, to: to.name, mode, diffPct, withinTolerance: diffPct != null && Math.abs(diffPct) <= 15, ours: o, eth: e };
}

/** Small seeded PRNG so random pairs are reproducible. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

const resolve = (q: string) => getPlace(q) ?? getPlaceByName(q);

export const devRoutes = new Hono();

devRoutes.get('/dev/compare', async (c) => {
  const mode: Mode = c.req.query('mode') === 'wheelchair' ? 'wheelchair' : 'walking';
  const random = Number(c.req.query('random') ?? 0);
  if (random > 0) {
    const rooms = getGraph().places.filter((p) => p.kind === 'room' && /Hörsaal|Seminarraum|Büro|Sitzungszimmer/.test(p.useType ?? ''));
    const next = rng(Number(c.req.query('seed') ?? 1));
    const results = [];
    for (let i = 0; i < Math.min(random, 20); i++) {
      const a = rooms[Math.floor(next() * rooms.length)];
      const b = rooms[Math.floor(next() * rooms.length)];
      results.push(await compare(a, b, mode));
    }
    const ok = results.filter((r) => r.diffPct != null);
    return c.json({
      mode,
      pairs: results.length,
      compared: ok.length,
      withinTolerance: ok.filter((r) => r.withinTolerance).length,
      table: results.map((r) => ({ from: r.from, to: r.to, ours: r.ours.ok ? r.ours.distanceM : r.ours.error, eth: r.eth.ok ? r.eth.distanceM : r.eth.error, diffPct: r.diffPct })),
      results,
    });
  }
  const from = resolve(c.req.query('from') ?? '');
  const to = resolve(c.req.query('to') ?? '');
  if (!from || !to) return c.json({ ok: false, message: 'from and to must be place ids or names (or use ?random=5)' }, 400);
  return c.json(await compare(from, to, mode));
});
