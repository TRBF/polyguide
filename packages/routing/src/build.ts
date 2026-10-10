/**
 * Graph build (SPEC §4.1). Pure: takes the parsed ETH GeoJSON snapshot, returns GraphJson + a report.
 * File I/O lives in scripts/build-graph.ts.
 */
import {
  ETH_TYPE_TO_KIND,
  type EdgeKind,
  type GraphEdge,
  type GraphJson,
  type GraphNode,
  type Level,
  type Place,
} from '@polyguide/shared';
import { bearingDeg, dist2D, dist3D, makeProjection, normalize180, pointSegment, type Projection, type XYZ } from './geo';

/* ───────────── Input types (subset of the ETH GeoJSON we rely on) ───────────── */

export interface GeoFeature<G = any> {
  type: 'Feature';
  geometry: G | null;
  properties: Record<string, any>;
}
export interface GeoFC<G = any> {
  type: 'FeatureCollection';
  features: GeoFeature<G>[];
}
type Line = { type: 'LineString'; coordinates: number[][] };
type Poly = { type: 'Polygon' | 'MultiPolygon'; coordinates: any };
type Pt = { type: 'Point'; coordinates: number[] };

export interface BuildInput {
  pathways: GeoFC<Line>;
  transitions: GeoFC<Line>;
  landmarks: GeoFC<Pt>;
  units: GeoFC<Poly>;
  levels: GeoFC;
  pois: GeoFC<Pt>;
  facility: string; // "HG"
  dataSnapshotAt: string;
}

export interface BuildReport {
  nodes: number;
  edges: number;
  components: number[]; // sizes (nodes), largest first
  droppedNodes: number;
  edgeKindsPerLevel: Record<string, Partial<Record<EdgeKind, number>>>;
  transitions: { kept: number; foreign: number; endpointSnappedToSegment: number; failed: { oid: number; kind: EdgeKind; reason: string }[] };
  droppedEdges: Record<string, number>;
  places: { rooms: number; entrances: number; pois: number; roomsWithoutNode: number; roomsSnappedToDoor: number };
  lengthScaling: { scaled: number; unscaled: number; suspicious: number };
}

/* ───────────── Constants ───────────── */

const XY_Q = 0.25; // node merge quantum (m)
const Z_Q = 1.0;
// Transition endpoint → pathway segment snap radius (m). ETH stair endpoints are often ~2 m off the corridor line.
const SEG_SNAP_XY = 2.5;
const SNAP_Z = 0.75;
const DOOR_RADIUS_M = 3;
const DROP_KINDS = new Set<EdgeKind>(['freight_lift', 'shuttle']);

/** Room use types that are never useful destinations. */
const ROOM_EXCLUDE = new Set(['Betriebsraum', 'Schrank', 'Gang', 'Treppe', 'Aufzug', 'Lager', 'Leitungsschacht']);

/** POI use types we expose, with English labels + aliases. */
const POI_TYPES: Record<string, { label: string; aliases: string[] }> = {
  'WC Damen': { label: "Women's toilet", aliases: ['toilet', 'wc', 'restroom', "women's toilet", 'ladies'] },
  'WC Herren': { label: "Men's toilet", aliases: ['toilet', 'wc', 'restroom', "men's toilet", 'gents'] },
  WC: { label: 'Toilet', aliases: ['toilet', 'wc', 'restroom'] },
  'WC Geschlechtsneutral': { label: 'All-gender toilet', aliases: ['toilet', 'wc', 'restroom', 'all gender toilet'] },
  'WC Geschlechtsneutral Barrierefrei': {
    label: 'Accessible toilet',
    aliases: ['toilet', 'wc', 'restroom', 'accessible toilet', 'wheelchair toilet', 'disabled toilet'],
  },
  'WC und Dusche Geschlechtsneutral': { label: 'Toilet and shower', aliases: ['toilet', 'wc', 'shower'] },
  Verpflegung: { label: 'Food and drink', aliases: ['cafe', 'cafeteria', 'coffee', 'food', 'mensa'] },
  Bibliothek: { label: 'Library', aliases: ['library'] },
  'Drucken und Kopieren': { label: 'Printing and copying', aliases: ['printer', 'printing', 'copy'] },
  Information: { label: 'Information desk', aliases: ['information', 'info desk', 'help desk'] },
  Aufenthaltsraum: { label: 'Lounge', aliases: ['lounge', 'common room'] },
  Rückzugsraum: { label: 'Quiet room', aliases: ['quiet room', 'rest room', 'retreat'] },
  Garderobe: { label: 'Cloakroom', aliases: ['cloakroom', 'wardrobe'] },
  'Garderobe Geschlechtsneutral': { label: 'Changing room', aliases: ['changing room', 'cloakroom'] },
  Aufzug: { label: 'Elevator', aliases: ['elevator', 'lift'] },
  'Eingang und Ausgang': { label: 'Entrance', aliases: ['entrance', 'exit'] },
};

/** Well-known friendly names (SPEC §4.1 aliases). */
const FRIENDLY: Record<string, string> = { 'HG F 30': 'Audimax' };

/* ───────────── Helpers ───────────── */

function edgeKind(code: unknown): EdgeKind | undefined {
  return ETH_TYPE_TO_KIND[Number(code)];
}

function onewayOf(code: unknown): GraphEdge['oneway'] {
  return code === 2 ? 'forward' : code === 3 ? 'backward' : 'both';
}

function rankOf(code: unknown): GraphEdge['rank'] {
  const r = Number(code);
  return r === 2 || r === 3 ? r : 1;
}

/** "HG F 30" → ["hg f 30", "f 30", "f30", "hgf30"]. */
export function roomAliases(name: string, label?: string): string[] {
  const lower = name.toLowerCase().trim();
  const parts = lower.split(/\s+/);
  const out = new Set([lower, lower.replace(/\s+/g, '')]);
  if (parts.length >= 3) {
    const rest = parts.slice(1).join(' ');
    out.add(rest);
    out.add(rest.replace(/\s+/g, ''));
  }
  if (label) out.add(label.toLowerCase());
  return [...out];
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

interface WorkNode extends XYZ {
  levelId: string | null;
  verticalOrder: number | null;
  indoor: boolean;
}

interface WorkEdge {
  id: string;
  from: number;
  to: number;
  kind: EdgeKind;
  lengthM: number;
  oneway: GraphEdge['oneway'];
  rank: GraphEdge['rank'];
  indoor: boolean;
  levelFrom: string | null;
  levelTo: string | null;
  source: GraphEdge['source'];
  sourceOid: number;
}

/* ───────────── Build ───────────── */

export function buildGraph(input: BuildInput): { graph: GraphJson; report: BuildReport } {
  const report: BuildReport = {
    nodes: 0,
    edges: 0,
    components: [],
    droppedNodes: 0,
    edgeKindsPerLevel: {},
    transitions: { kept: 0, foreign: 0, endpointSnappedToSegment: 0, failed: [] },
    droppedEdges: {},
    places: { rooms: 0, entrances: 0, pois: 0, roomsWithoutNode: 0, roomsSnappedToDoor: 0 },
    lengthScaling: { scaled: 0, unscaled: 0, suspicious: 0 },
  };
  const drop = (why: string) => (report.droppedEdges[why] = (report.droppedEdges[why] ?? 0) + 1);

  // Origin = centroid of all pathway vertices.
  let sLon = 0;
  let sLat = 0;
  let n = 0;
  for (const f of input.pathways.features)
    for (const c of f.geometry?.coordinates ?? []) {
      sLon += c[0];
      sLat += c[1];
      n++;
    }
  const proj: Projection = makeProjection({ lat: sLat / n, lon: sLon / n });

  const nodes: WorkNode[] = [];
  const grid = new Map<string, number[]>();
  const cellKey = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;

  /** Find an existing node within one merge quantum (checks neighbouring cells, so bucket edges don't split nodes). */
  function findNode(p: XYZ): number | undefined {
    const ix = Math.round(p.x / XY_Q);
    const iy = Math.round(p.y / XY_Q);
    const iz = Math.round(p.z / Z_Q);
    let best: number | undefined;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const i of grid.get(cellKey(ix + dx, iy + dy, iz + dz)) ?? []) {
            const q = nodes[i];
            const d = dist2D(p, q);
            if (d <= XY_Q && Math.abs(q.z - p.z) <= Z_Q / 2 && d < bestD) {
              best = i;
              bestD = d;
            }
          }
    return best;
  }

  function addNode(p: XYZ, attrs: Omit<WorkNode, keyof XYZ>): number {
    const found = findNode(p);
    if (found !== undefined) {
      const q = nodes[found];
      if (q.levelId == null && attrs.levelId != null) {
        q.levelId = attrs.levelId;
        q.verticalOrder = attrs.verticalOrder;
      }
      q.indoor ||= attrs.indoor;
      return found;
    }
    const i = nodes.push({ ...p, ...attrs }) - 1;
    const k = cellKey(Math.round(p.x / XY_Q), Math.round(p.y / XY_Q), Math.round(p.z / Z_Q));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    return i;
  }

  const toXYZ = (c: number[]): XYZ => {
    const [x, y] = proj.toXY(c[0], c[1]);
    return { x, y, z: c[2] ?? 0 };
  };

  const edges: WorkEdge[] = [];

  /** Turn one polyline feature into per-segment edges, scaled so they sum to LENGTH_3D when sane. */
  function addPolyline(
    nodeIdx: number[],
    pts: XYZ[],
    base: Omit<WorkEdge, 'id' | 'from' | 'to' | 'lengthM' | 'levelFrom' | 'levelTo'> & { levelFrom: string | null; levelTo: string | null },
    length3d: unknown,
  ) {
    const segLens = pts.slice(1).map((p, i) => dist3D(pts[i], p));
    const total = segLens.reduce((a, b) => a + b, 0);
    const l3d = Number(length3d);
    let scale = 1;
    if (Number.isFinite(l3d) && l3d > 0 && l3d !== 9999 && total > 0) {
      const ratio = l3d / total;
      if (ratio > 0.5 && ratio < 2) {
        scale = ratio;
        report.lengthScaling.scaled++;
      } else report.lengthScaling.suspicious++;
    } else report.lengthScaling.unscaled++;
    for (let i = 0; i + 1 < nodeIdx.length; i++) {
      const [a, b] = [nodeIdx[i], nodeIdx[i + 1]];
      if (a === b) continue;
      edges.push({
        ...base,
        id: `e_${base.source[0]}${base.sourceOid}_${i}`,
        from: a,
        to: b,
        lengthM: Math.max(0.01, segLens[i] * scale),
        // Vertical edges: the level changes along the transition polyline.
        levelFrom: i === 0 ? base.levelFrom : nodes[a].levelId ?? base.levelFrom,
        levelTo: i + 2 === nodeIdx.length ? base.levelTo : nodes[b].levelId ?? base.levelTo,
      });
    }
  }

  /* Pathways (horizontal) */
  const pathwaySegs: { a: number; b: number; edgeIdx: number }[] = [];
  for (const f of input.pathways.features) {
    const p = f.properties;
    const kind = edgeKind(p.PATHWAY_TYPE);
    if (!f.geometry || f.geometry.coordinates.length < 2) {
      drop('no geometry');
      continue;
    }
    if (!kind) {
      drop(`unknown type ${p.PATHWAY_TYPE}`);
      continue;
    }
    if (p.EMERGENCY === 1) {
      drop('emergency');
      continue;
    }
    if (DROP_KINDS.has(kind)) {
      drop(kind);
      continue;
    }
    const levelId: string = p.LEVEL_ID;
    const indoor = p.LOCATION !== 1;
    const pts = f.geometry.coordinates.map(toXYZ);
    const idx = pts.map((pt) => addNode(pt, { levelId, verticalOrder: p.VERTICAL_ORDER ?? null, indoor }));
    const before = edges.length;
    addPolyline(
      idx,
      pts,
      {
        kind,
        oneway: onewayOf(p.TRAVEL_DIRECTION),
        rank: rankOf(p.PATHWAY_RANK),
        indoor,
        source: 'pathway',
        sourceOid: p.OBJECTID,
        levelFrom: levelId,
        levelTo: levelId,
      },
      p.LENGTH_3D,
    );
    for (let e = before; e < edges.length; e++) pathwaySegs.push({ a: edges[e].from, b: edges[e].to, edgeIdx: e });
  }

  /** Snap a transition endpoint onto the interior of a pathway segment, splitting it. */
  function snapToSegment(p: XYZ): number | undefined {
    let best: { seg: (typeof pathwaySegs)[number]; t: number; d: number } | undefined;
    for (const seg of pathwaySegs) {
      const A = nodes[seg.a];
      const B = nodes[seg.b];
      if (Math.abs(A.z - p.z) > SNAP_Z * 2 && Math.abs(B.z - p.z) > SNAP_Z * 2) continue;
      const { d, t } = pointSegment(p, A, B);
      const z = A.z + t * (B.z - A.z);
      if (d <= SEG_SNAP_XY && Math.abs(z - p.z) <= SNAP_Z && (!best || d < best.d)) best = { seg, t, d };
    }
    if (!best) return undefined;
    const { seg, t } = best;
    const A = nodes[seg.a];
    const B = nodes[seg.b];
    if (t < 0.02) return seg.a;
    if (t > 0.98) return seg.b;
    const mid = addNode(
      { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y), z: A.z + t * (B.z - A.z) },
      { levelId: A.levelId, verticalOrder: A.verticalOrder, indoor: A.indoor },
    );
    // Split edge: shorten the original, append the second half.
    const e = edges[seg.edgeIdx];
    const second: WorkEdge = { ...e, id: `${e.id}b`, from: mid, to: e.to, lengthM: e.lengthM * (1 - t) };
    e.to = mid;
    e.lengthM *= t;
    edges.push(second);
    seg.b = mid;
    pathwaySegs.push({ a: mid, b: second.to, edgeIdx: edges.length - 1 });
    report.transitions.endpointSnappedToSegment++;
    return mid;
  }

  /* Transitions (vertical): keep only those whose two endpoints land on HG pathway nodes. */
  const hgFacility = `ETH.${input.facility}`;
  for (const f of input.transitions.features) {
    const p = f.properties;
    const kind = edgeKind(p.TRANSITION_TYPE);
    const coords = f.geometry?.coordinates ?? [];
    if (!kind || coords.length < 2) {
      drop('transition without kind/geometry');
      continue;
    }
    if (p.EMERGENCY === 1) {
      drop('emergency');
      continue;
    }
    if (DROP_KINDS.has(kind)) {
      drop(kind);
      continue;
    }
    const pts = coords.map(toXYZ);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const a = findNode(first) ?? snapToSegment(first);
    const b = findNode(last) ?? snapToSegment(last);
    if (a === undefined || b === undefined) {
      if (p.FACILITY_ID !== hgFacility && a === undefined && b === undefined) report.transitions.foreign++;
      else
        report.transitions.failed.push({
          oid: p.OBJECTID,
          kind,
          reason: `${p.FACILITY_ID} ${p.LEVEL_NAME_FROM}→${p.LEVEL_NAME_TO}: ${a === undefined ? 'from' : ''}${a === undefined && b === undefined ? '+' : ''}${b === undefined ? 'to' : ''} endpoint not on a pathway`,
        });
      continue;
    }
    const idx = [a, ...pts.slice(1, -1).map((pt) => addNode(pt, { levelId: null, verticalOrder: null, indoor: true })), b];
    addPolyline(
      idx,
      [nodes[a], ...pts.slice(1, -1), nodes[b]],
      {
        kind,
        oneway: onewayOf(p.TRAVEL_DIRECTION),
        rank: rankOf(p.TRANSITION_RANK),
        indoor: nodes[a].indoor || nodes[b].indoor,
        source: 'transition',
        sourceOid: p.OBJECTID,
        levelFrom: nodes[a].levelId,
        levelTo: nodes[b].levelId,
      },
      p.LENGTH_3D,
    );
    report.transitions.kept++;
  }

  /* Largest connected component (undirected). */
  const uf = new UnionFind(nodes.length);
  const used = new Set<number>();
  for (const e of edges) {
    uf.union(e.from, e.to);
    used.add(e.from);
    used.add(e.to);
  }
  const compSize = new Map<number, number>();
  for (const i of used) compSize.set(uf.find(i), (compSize.get(uf.find(i)) ?? 0) + 1);
  const sorted = [...compSize.entries()].sort((x, y) => y[1] - x[1]);
  report.components = sorted.map(([, s]) => s);
  const mainRoot = sorted[0]?.[0];
  const keepNode = (i: number) => used.has(i) && uf.find(i) === mainRoot;

  const remap = new Map<number, string>();
  for (let i = 0; i < nodes.length; i++) if (keepNode(i)) remap.set(i, `n${remap.size}`);
  report.droppedNodes = nodes.length - remap.size;

  // Transition-interior nodes: inherit level from the nearest end of their transition (better than null for display).
  const keptEdges = edges.filter((e) => keepNode(e.from) && keepNode(e.to));

  /* Degree + decision points. */
  const nbrs = new Map<number, Set<number>>();
  for (const e of keptEdges) {
    (nbrs.get(e.from) ?? nbrs.set(e.from, new Set()).get(e.from)!).add(e.to);
    (nbrs.get(e.to) ?? nbrs.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const outNodes: GraphNode[] = [];
  const nodeIndexById = new Map<string, number>();
  for (const [i, id] of remap) {
    const q = nodes[i];
    const nb = [...(nbrs.get(i) ?? [])];
    let decision = nb.length >= 3;
    if (nb.length === 2) {
      const [u, v] = nb.map((j) => nodes[j]);
      if (dist2D(u, q) > 0.1 && dist2D(q, v) > 0.1) {
        const turn = Math.abs(normalize180(bearingDeg(q, v) - bearingDeg(u, q)));
        decision = turn > 30;
      }
    }
    const [lon, lat] = proj.toLonLat(q.x, q.y);
    nodeIndexById.set(id, outNodes.length);
    outNodes.push({
      id,
      lat: +lat.toFixed(8),
      lon: +lon.toFixed(8),
      x: +q.x.toFixed(3),
      y: +q.y.toFixed(3),
      z: +q.z.toFixed(3),
      levelId: q.levelId,
      verticalOrder: q.verticalOrder,
      degree: nb.length,
      isDecisionPoint: decision,
      indoor: q.indoor,
    });
  }

  const outEdges: GraphEdge[] = keptEdges.map((e) => ({
    id: e.id,
    from: remap.get(e.from)!,
    to: remap.get(e.to)!,
    kind: e.kind,
    lengthM: +e.lengthM.toFixed(3),
    oneway: e.oneway,
    rank: e.rank,
    indoor: e.indoor,
    levelFrom: e.levelFrom,
    levelTo: e.levelTo,
    source: e.source,
    sourceOid: e.sourceOid,
  }));
  for (const e of outEdges) {
    const lvl = e.levelFrom === e.levelTo ? e.levelFrom ?? '?' : `${e.levelFrom}→${e.levelTo}`;
    const bucket = (report.edgeKindsPerLevel[lvl] ??= {});
    bucket[e.kind] = (bucket[e.kind] ?? 0) + 1;
  }
  report.nodes = outNodes.length;
  report.edges = outEdges.length;

  /* Levels */
  const levels: Level[] = input.levels.features
    .map((f) => ({
      id: f.properties.LEVEL_ID as string,
      name: (f.properties.NAME_SHORT ?? f.properties.NAME) as string,
      verticalOrder: Number(f.properties.VERTICAL_ORDER),
      facility: input.facility,
    }))
    .sort((a, b) => a.verticalOrder - b.verticalOrder);
  const levelOrder = new Map(levels.map((l) => [l.id, l.verticalOrder]));

  /* Places */
  const nodesByLevel = new Map<string, GraphNode[]>();
  for (const nd of outNodes) if (nd.levelId) (nodesByLevel.get(nd.levelId) ?? nodesByLevel.set(nd.levelId, []).get(nd.levelId)!).push(nd);

  const places = buildPlaces(input, proj, nodesByLevel, levelOrder, report);

  const graph: GraphJson = {
    builtAt: new Date().toISOString(),
    dataSnapshotAt: input.dataSnapshotAt,
    facility: input.facility,
    origin: { lat: +proj.origin.lat.toFixed(8), lon: +proj.origin.lon.toFixed(8) },
    nodes: outNodes,
    edges: outEdges,
    places,
    levels,
  };
  return { graph, report };
}

/* ───────────── Places (SPEC §4.1 step 9) ───────────── */

function ringsOf(g: Poly): number[][][] {
  return g.type === 'Polygon' ? g.coordinates : (g.coordinates as number[][][][]).flat();
}

function polygonCentroid(ring: { x: number; y: number }[]): { x: number; y: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    a += f;
    cx += (ring[j].x + ring[i].x) * f;
    cy += (ring[j].y + ring[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length || 1;
    return { x: ring.reduce((s, p) => s + p.x, 0) / n, y: ring.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function nearestNode(nodes: GraphNode[] | undefined, p: { x: number; y: number }): GraphNode | undefined {
  let best: GraphNode | undefined;
  let bestD = Infinity;
  for (const nd of nodes ?? []) {
    const d = dist2D(nd, p);
    if (d < bestD) {
      best = nd;
      bestD = d;
    }
  }
  return best;
}

function buildPlaces(
  input: BuildInput,
  proj: Projection,
  nodesByLevel: Map<string, GraphNode[]>,
  levelOrder: Map<string, number>,
  report: BuildReport,
): Place[] {
  const places: Place[] = [];
  const roomByName = new Map<string, Place>();
  const prefix = `ETH.${input.facility}.`;
  const xy = (c: number[]) => {
    const [x, y] = proj.toXY(c[0], c[1]);
    return { x, y };
  };
  const lonLat = (p: { x: number; y: number }) => {
    const [lon, lat] = proj.toLonLat(p.x, p.y);
    return { lon: +lon.toFixed(7), lat: +lat.toFixed(7) };
  };

  /* Rooms: skip sub-units ("HG F 30.0078") and service rooms. */
  for (const f of input.units.features) {
    const p = f.properties;
    const name: string = (p.NAME ?? '').trim();
    if (!f.geometry || !/^\S+ [A-Z]+ \d+(\.\d{1,2})?$/.test(name) || ROOM_EXCLUDE.has(p.USE_TYPE)) continue;
    const levelId: string = p.LEVEL_ID;
    const rings = ringsOf(f.geometry).map((r) => r.map(xy));
    const outer = rings.reduce((a, b) => (b.length > a.length ? b : a));
    const c = polygonCentroid(outer);

    // Prefer nodes within DOOR_RADIUS_M of the polygon boundary (≈ the door), closest to the centroid.
    const cands = nodesByLevel.get(levelId) ?? [];
    let door: GraphNode | undefined;
    let doorD = Infinity;
    const xs = outer.map((q) => q.x);
    const ys = outer.map((q) => q.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - DOOR_RADIUS_M, Math.max(...xs) + DOOR_RADIUS_M, Math.min(...ys) - DOOR_RADIUS_M, Math.max(...ys) + DOOR_RADIUS_M];
    for (const nd of cands) {
      if (nd.x < minX || nd.x > maxX || nd.y < minY || nd.y > maxY) continue;
      let bd = Infinity;
      for (const ring of rings)
        for (let i = 0; i + 1 < ring.length; i++) bd = Math.min(bd, pointSegment(nd, ring[i], ring[i + 1]).d);
      if (bd <= DOOR_RADIUS_M) {
        const d = dist2D(nd, c);
        if (d < doorD) {
          door = nd;
          doorD = d;
        }
      }
    }
    const node = door ?? nearestNode(cands, c);
    if (!node) {
      report.places.roomsWithoutNode++;
      continue;
    }
    if (door) report.places.roomsSnappedToDoor++;
    const label = FRIENDLY[name];
    const place: Place = {
      id: `pl_${slug(name)}`,
      name,
      ...(label ? { label } : {}),
      kind: 'room',
      levelId,
      verticalOrder: levelOrder.get(levelId) ?? p.VERTICAL_ORDER ?? null,
      ...lonLat(c),
      nodeId: node.id,
      useType: p.USE_TYPE ?? undefined,
      aliases: roomAliases(name, label),
    };
    places.push(place);
    roomByName.set(name, place);
    report.places.rooms++;
  }

  /* Entrances from landmarks (HG only). */
  for (const f of input.landmarks.features) {
    const p = f.properties;
    if (!f.geometry || !String(p.LEVEL_ID ?? '').startsWith(prefix)) continue;
    const pt = xy(f.geometry.coordinates);
    const node = nearestNode(nodesByLevel.get(p.LEVEL_ID), pt);
    if (!node) continue;
    const desc: string = p.DESCRIPTION ?? 'Entrance';
    const aliases = new Set([desc.toLowerCase()]);
    if (/haupteingang/i.test(desc)) aliases.add('main entrance');
    if (/nord/i.test(desc)) aliases.add('north entrance');
    if (/süd/i.test(desc)) aliases.add('south entrance');
    if (/polyterrasse/i.test(desc)) aliases.add('polyterrasse entrance');
    aliases.add('entrance');
    places.push({
      id: `pl_lm_${p.OBJECTID}`,
      name: desc,
      kind: 'entrance',
      levelId: p.LEVEL_ID,
      verticalOrder: levelOrder.get(p.LEVEL_ID) ?? p.VERTICAL_ORDER ?? null,
      ...lonLat(pt),
      nodeId: node.id,
      aliases: [...aliases],
    });
    report.places.entrances++;
  }

  /* POIs: whitelisted use types, labelled in English. */
  for (const f of input.pois.features) {
    const p = f.properties;
    const meta = POI_TYPES[p.USE_TYPE];
    if (!meta || !f.geometry || !String(p.LEVEL_ID ?? '').startsWith(prefix)) continue;
    const name: string = (p.NAME ?? '').trim();
    const room = roomByName.get(name);
    const pt = xy(f.geometry.coordinates);
    const node = room ? undefined : nearestNode(nodesByLevel.get(p.LEVEL_ID), pt);
    const nodeId = room?.nodeId ?? node?.id;
    if (!nodeId) continue;
    const levelName = String(p.LEVEL_ID).slice(prefix.length);
    places.push({
      id: `pl_poi_${p.OBJECTID}`,
      name: `${meta.label} (${name})`,
      label: meta.label,
      kind: 'poi',
      levelId: p.LEVEL_ID,
      verticalOrder: levelOrder.get(p.LEVEL_ID) ?? p.VERTICAL_ORDER ?? null,
      ...lonLat(pt),
      nodeId,
      useType: p.USE_TYPE,
      aliases: [...new Set([...meta.aliases, ...meta.aliases.map((a) => `${a} ${levelName.toLowerCase()}`), ...roomAliases(name)])],
    });
    report.places.pois++;
  }
  return places;
}
