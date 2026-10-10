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
  transitions: { kept: number; foreign: number; endpointSnappedToSegment: number; doors: number; synthetic: number; landings: number; joinedPieces: number; failed: { oid: number; kind: EdgeKind; reason: string }[] };
  droppedEdges: Record<string, number>;
  places: { rooms: number; entrances: number; pois: number; roomsWithoutNode: number; roomsSnappedToDoor: number; roomsNotStepFree: number };
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

/** "Eingang HG Südflügel E" → "South wing entrance, floor E"; "Haupteingang HG E" → "Main entrance, floor E". */
export function entranceLabel(desc: string): string {
  const floor = desc.match(/\s([A-Z]{1,2})$/)?.[1];
  const where = /haupteingang/i.test(desc) ? 'Main entrance'
    : /polyterrasse/i.test(desc) ? 'Polyterrasse entrance'
    : /garage/i.test(desc) ? 'Garage entrance'
    : /südflügel/i.test(desc) ? 'South wing entrance'
    : /nordflügel/i.test(desc) ? 'North wing entrance'
    : /süd/i.test(desc) ? 'South entrance'
    : /nord/i.test(desc) ? 'North entrance'
    : 'Entrance';
  return floor ? `${where}, floor ${floor}` : where;
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
  /** Created by (or merged with) a pathway vertex. Transition endpoints may only land on these. */
  fromPathway?: boolean;
  door?: boolean;
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
  synthetic?: boolean;
}

/* ───────────── Build ───────────── */

export function buildGraph(input: BuildInput): { graph: GraphJson; report: BuildReport } {
  const report: BuildReport = {
    nodes: 0,
    edges: 0,
    components: [],
    droppedNodes: 0,
    edgeKindsPerLevel: {},
    transitions: { kept: 0, foreign: 0, endpointSnappedToSegment: 0, doors: 0, synthetic: 0, landings: 0, joinedPieces: 0, failed: [] },
    droppedEdges: {},
    places: { rooms: 0, entrances: 0, pois: 0, roomsWithoutNode: 0, roomsSnappedToDoor: 0, roomsNotStepFree: 0 },
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
  function findNode(p: XYZ, pathwayOnly = false): number | undefined {
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
            if (pathwayOnly && !q.fromPathway) continue;
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
      q.fromPathway ||= attrs.fromPathway;
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
    /** Transitions: every segment of one flight/shaft carries the flight's own from→to levels, so a flight is
     *  one vertical step (not "continue straight 1 m" in mid-flight, nor a level borrowed from a neighbour). */
    wholeLevels = false,
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
        levelFrom: wholeLevels || i === 0 ? base.levelFrom : nodes[a].levelId ?? base.levelFrom,
        levelTo: wholeLevels || i + 2 === nodeIdx.length ? base.levelTo : nodes[b].levelId ?? base.levelTo,
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
    const idx = pts.map((pt) => addNode(pt, { levelId, verticalOrder: p.VERTICAL_ORDER ?? null, indoor, fromPathway: true }));
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

  let splitSeq = 0;
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
      { levelId: A.levelId, verticalOrder: A.verticalOrder, indoor: A.indoor, fromPathway: true },
    );
    // Split edge: shorten the original, append the second half.
    const e = edges[seg.edgeIdx];
    const second: WorkEdge = { ...e, id: `${e.id}s${splitSeq++}`, from: mid, to: e.to, lengthM: e.lengthM * (1 - t) };
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
  const knownLevels = new Set(input.levels.features.map((f) => String(f.properties.LEVEL_ID)));
  /** ETH's declared floor for a transition end ("EO" → "ETH.HG.EO"), when it is a real HG level. */
  const declaredLevel = (name: unknown): string | null => {
    const id = name ? `${hgFacility}.${name}` : null;
    return id && knownLevels.has(id) ? id : null;
  };
  /** Would this point reach a corridor (without changing the graph)? */
  const reachesCorridor = (p: XYZ) =>
    findNode(p, true) !== undefined ||
    pathwaySegs.some((seg) => {
      const A = nodes[seg.a];
      const B = nodes[seg.b];
      const { d, t } = pointSegment(p, A, B);
      return d <= SEG_SNAP_XY && Math.abs(A.z + t * (B.z - A.z) - p.z) <= SNAP_Z;
    });

  /* ETH sometimes splits one flight into pieces: (1) pieces meeting at a landing that is not on a corridor
     (J→K), (2) pieces of the same declared flight with a small gap between them (E→EO, E→F). Landings become
     shared nodes; gapped pieces are joined into one flight. */
  type TFeat = { properties: Record<string, any>; coords: number[][] };
  const tFeats: TFeat[] = input.transitions.features
    .filter((f) => (f.geometry?.coordinates?.length ?? 0) >= 2)
    .map((f) => ({ properties: f.properties, coords: f.geometry!.coordinates }));
  const near = (u: XYZ, v: XYZ, xy: number, z: number) => dist2D(u, v) <= xy && Math.abs(u.z - v.z) <= z;
  const ends = (t: TFeat) => [toXYZ(t.coords[0]), toXYZ(t.coords[t.coords.length - 1])] as const;
  // Only HG's own transitions (other buildings in the bbox are not ours to repair).
  const ownFeats = tFeats.filter((t) => t.properties.FACILITY_ID === hgFacility);
  for (const t of ownFeats) {
    if (!edgeKind(t.properties.TRANSITION_TYPE) || t.properties.EMERGENCY === 1) continue;
    for (const [k, pt] of ends(t).entries()) {
      if (reachesCorridor(pt)) continue;
      const shared = ownFeats.some((o) => o !== t && ends(o).some((q) => near(pt, q, 0.3, 0.3)));
      if (!shared || findNode(pt, true) !== undefined) continue;
      const lvl = declaredLevel(k === 0 ? t.properties.LEVEL_NAME_FROM : t.properties.LEVEL_NAME_TO);
      addNode(pt, { levelId: lvl, verticalOrder: lvl ? Number(input.levels.features.find((f) => f.properties.LEVEL_ID === lvl)?.properties.VERTICAL_ORDER) : null, indoor: true, fromPathway: true });
      report.transitions.landings++;
    }
  }
  const consumed = new Set<TFeat>();
  for (const a of ownFeats) {
    if (consumed.has(a)) continue;
    const aEnd = ends(a)[1];
    if (reachesCorridor(aEnd)) continue;
    const b = ownFeats.find((o) => {
      if (o === a || consumed.has(o) || o.properties.TRANSITION_TYPE !== a.properties.TRANSITION_TYPE) return false;
      if (o.properties.LEVEL_NAME_FROM !== a.properties.LEVEL_NAME_FROM || o.properties.LEVEL_NAME_TO !== a.properties.LEVEL_NAME_TO) return false;
      const bStart = ends(o)[0];
      return !reachesCorridor(bStart) && dist2D(aEnd, bStart) <= 3 && bStart.z - aEnd.z >= -0.5 && bStart.z - aEnd.z <= 2.5;
    });
    if (!b) continue;
    a.coords = [...a.coords, ...b.coords];
    a.properties = { ...a.properties, LENGTH_3D: undefined };
    consumed.add(b);
    report.transitions.joinedPieces++;
  }

  for (const f of tFeats.filter((t) => !consumed.has(t)).map((t) => ({ properties: t.properties, geometry: { coordinates: t.coords } }))) {
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
    // Endpoints land on corridor (pathway) nodes only, never on another transition's interior nodes.
    const a = findNode(first, true) ?? snapToSegment(first);
    const b = findNode(last, true) ?? snapToSegment(last);
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
    if (a === b) {
      // A short door transition collapses onto one corridor node: keep it as a door, not as nothing.
      if (kind === 'entrance') {
        nodes[a].door = true;
        report.transitions.doors++;
      } else drop('transition collapsed to one node');
      continue;
    }
    // Interior vertices take the level of the nearer end (by height), so no node is left without a floor.
    const [za, zb] = [nodes[a].z, nodes[b].z];
    const interior = pts.slice(1, -1).map((pt) => {
      const end = Math.abs(pt.z - za) <= Math.abs(pt.z - zb) ? nodes[a] : nodes[b];
      return addNode(pt, { levelId: end.levelId, verticalOrder: end.verticalOrder, indoor: true });
    });
    const idx = [a, ...interior, b];
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
        // ETH's declared floors win over the floor of whatever node the end snapped to (t13537 F→G lands on FO),
        // but are matched to the ends by height: some flights are drawn top-down while declared bottom-up.
        ...(() => {
          let [la, lb] = [declaredLevel(p.LEVEL_NAME_FROM) ?? nodes[a].levelId, declaredLevel(p.LEVEL_NAME_TO) ?? nodes[b].levelId];
          const vo = (l: string | null) => (l ? Number(input.levels.features.find((f) => f.properties.LEVEL_ID === l)?.properties.VERTICAL_ORDER) : NaN);
          if (la && lb && vo(la) !== vo(lb) && (vo(la) < vo(lb)) !== (nodes[a].z < nodes[b].z)) [la, lb] = [lb, la];
          return { levelFrom: la, levelTo: lb };
        })(),
      },
      p.LENGTH_3D,
      true,
    );
    report.transitions.kept++;
  }

  /* Elevator shafts in the floor plans but missing from the routing network (e.g. HG "30.0009" on B…J):
     link the corridor stubs that end inside the same shaft on adjacent floors. Flagged synthetic. */
  addMissingElevatorShafts();

  function addMissingElevatorShafts() {
    const lifts = input.units.features.filter((f) => f.geometry && f.properties.USE_TYPE === 'Aufzug' && f.properties.RaumNr);
    // Group the per-floor units of one shaft: same room number, footprints within 3 m.
    const stacks = new Map<string, { levelId: string; vo: number; ring: { x: number; y: number }[]; c: { x: number; y: number } }[]>();
    for (const f of lifts) {
      const ring = (ringsOf(f.geometry!).reduce((x, y) => (y.length > x.length ? y : x)) as number[][]).map((c) => {
        const [x, y] = proj.toXY(c[0], c[1]);
        return { x, y };
      });
      const c = polygonCentroid(ring);
      const key = String(f.properties.RaumNr);
      const list = stacks.get(key) ?? stacks.set(key, []).get(key)!;
      list.push({ levelId: f.properties.LEVEL_ID, vo: Number(f.properties.VERTICAL_ORDER), ring, c });
    }
    const inside = (p: { x: number; y: number }, ring: { x: number; y: number }[], margin: number) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [a, b] = [ring[i], ring[j]];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
      }
      if (hit) return true;
      for (let i = 0; i + 1 < ring.length; i++) if (pointSegment(p, ring[i], ring[i + 1]).d <= margin) return true;
      return false;
    };
    for (const [key, floors] of stacks) {
      if (floors.length < 2) continue;
      const centre = floors[0].c;
      const shaft = floors.filter((u) => dist2D(u.c, centre) <= 3).sort((u, v) => u.vo - v.vo);
      // Corridor node that reaches into the shaft on each floor.
      const nodeOn = shaft.map((u) => {
        let best: number | undefined;
        let bestD = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          const q = nodes[i];
          if (!q.fromPathway || q.levelId !== u.levelId || !inside(q, u.ring, 0.75)) continue;
          const d = dist2D(q, u.c);
          if (d < bestD) {
            best = i;
            bestD = d;
          }
        }
        return best;
      });
      // Already modelled? Then any real elevator edge touches a node inside the shaft.
      const modelled = edges.some(
        (e) => e.kind === 'elevator' && e.source === 'transition' && !e.synthetic && e.levelFrom !== e.levelTo
          && shaft.some((u) => [e.from, e.to].some((i) => nodes[i].levelId === u.levelId && inside(nodes[i], u.ring, 1.5))),
      );
      if (modelled) continue;
      // Floors without a door into the shaft are passed through: link the nearest floors that have one.
      const stops = shaft.map((u, k) => ({ u, node: nodeOn[k] })).filter((s): s is { u: (typeof shaft)[number]; node: number } => s.node !== undefined);
      for (let k = 0; k + 1 < stops.length; k++) {
        const [a, b] = [stops[k].node, stops[k + 1].node];
        if (a === b) continue;
        edges.push({
          id: `e_syn_${slug(key)}_${k}`,
          from: a,
          to: b,
          kind: 'elevator',
          lengthM: Math.max(1, Math.abs(nodes[b].z - nodes[a].z)),
          oneway: 'both',
          rank: 1,
          indoor: true,
          levelFrom: nodes[a].levelId,
          levelTo: nodes[b].levelId,
          source: 'transition',
          sourceOid: 0,
          synthetic: true,
        });
        report.transitions.synthetic++;
      }
    }
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
      ...(q.door ? { door: true } : {}),
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
    ...(e.synthetic ? { synthetic: true } : {}),
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

  const stepFree = stepFreeMainComponent(outNodes, outEdges);
  const places = buildPlaces(input, proj, nodesByLevel, levelOrder, stepFree, report);

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

/** Node ids in the largest component reachable without stairs/escalators/steep edges. */
function stepFreeMainComponent(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const uf = new UnionFind(nodes.length);
  for (const e of edges) if (e.kind !== 'stairs' && e.kind !== 'escalator' && e.kind !== 'steep') uf.union(index.get(e.from)!, index.get(e.to)!);
  const size = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) size.set(uf.find(i), (size.get(uf.find(i)) ?? 0) + 1);
  const root = [...size.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return new Set(nodes.filter((_, i) => uf.find(i) === root).map((n) => n.id));
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
  stepFree: Set<string>,
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

    // Prefer nodes within DOOR_RADIUS_M of the polygon boundary (≈ the door), then step-free reachable ones
    // (stepped lecture halls have interior nodes reachable only by stairs), then closest to the centroid.
    const cands = nodesByLevel.get(levelId) ?? [];
    let door: GraphNode | undefined;
    let doorD = Infinity;
    const score = (nd: GraphNode) => dist2D(nd, c) + (stepFree.has(nd.id) ? 0 : 1e6);
    const xs = outer.map((q) => q.x);
    const ys = outer.map((q) => q.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - DOOR_RADIUS_M, Math.max(...xs) + DOOR_RADIUS_M, Math.min(...ys) - DOOR_RADIUS_M, Math.max(...ys) + DOOR_RADIUS_M];
    for (const nd of cands) {
      if (nd.x < minX || nd.x > maxX || nd.y < minY || nd.y > maxY) continue;
      let bd = Infinity;
      for (const ring of rings)
        for (let i = 0; i + 1 < ring.length; i++) bd = Math.min(bd, pointSegment(nd, ring[i], ring[i + 1]).d);
      if (bd <= DOOR_RADIUS_M) {
        const d = score(nd);
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
    if (!stepFree.has(node.id)) report.places.roomsNotStepFree++;
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
    const label = entranceLabel(desc);
    const aliases = new Set([desc.toLowerCase(), label.toLowerCase()]);
    if (/haupteingang/i.test(desc)) aliases.add('main entrance');
    if (/nord/i.test(desc)) aliases.add('north entrance');
    if (/süd/i.test(desc)) aliases.add('south entrance');
    if (/polyterrasse/i.test(desc)) aliases.add('polyterrasse entrance');
    aliases.add('entrance');
    places.push({
      id: `pl_lm_${p.OBJECTID}`,
      name: desc,
      label,
      kind: 'entrance',
      levelId: p.LEVEL_ID,
      verticalOrder: levelOrder.get(p.LEVEL_ID) ?? p.VERTICAL_ORDER ?? null,
      ...lonLat(pt),
      nodeId: node.id,
      aliases: [...aliases],
    });
    report.places.entrances++;
  }

  /* POIs: whitelisted use types, labelled in English. Their NAME is e.g. "WC Herren HG F", so the room is found
     through UNIT_ID → unit NAME ("HG F 31.1"); the POI then shares the room's door node. */
  const unitNameById = new Map<string, string>();
  for (const u of input.units.features) if (u.properties.UNIT_ID && u.properties.NAME) unitNameById.set(u.properties.UNIT_ID, String(u.properties.NAME).trim());
  const roomsByLevel = new Map<string, Place[]>();
  for (const r of places) if (r.kind === 'room') (roomsByLevel.get(r.levelId) ?? roomsByLevel.set(r.levelId, []).get(r.levelId)!).push(r);
  for (const f of input.pois.features) {
    const p = f.properties;
    const meta = POI_TYPES[p.USE_TYPE];
    if (!meta || !f.geometry || !String(p.LEVEL_ID ?? '').startsWith(prefix)) continue;
    const unitName = unitNameById.get(p.UNIT_ID) ?? '';
    const name: string = (p.NAME ?? '').trim();
    const room = roomByName.get(unitName) ?? roomByName.get(name);
    const pt = xy(f.geometry.coordinates);
    const node = room ? undefined : nearestNode(nodesByLevel.get(p.LEVEL_ID), pt);
    const nodeId = room?.nodeId ?? node?.id;
    if (!nodeId) continue;
    const levelName = String(p.LEVEL_ID).slice(prefix.length);
    // Elevators etc. without a room of their own: name them after the nearest room ("Elevator near HG F 33"),
    // so several on one floor can be told apart by voice.
    let nearRoom: Place | undefined;
    if (!room) {
      let bestD = 15;
      for (const r of roomsByLevel.get(p.LEVEL_ID) ?? []) {
        const d = dist2D(xy([r.lon, r.lat]), pt);
        if (d < bestD) {
          bestD = d;
          nearRoom = r;
        }
      }
    }
    places.push({
      id: `pl_poi_${p.OBJECTID}`,
      name: room ? `${meta.label} (${room.name})` : nearRoom ? `${meta.label} near ${nearRoom.name}` : `${meta.label}, floor ${levelName}`,
      label: meta.label,
      kind: 'poi',
      levelId: p.LEVEL_ID,
      verticalOrder: levelOrder.get(p.LEVEL_ID) ?? p.VERTICAL_ORDER ?? null,
      ...lonLat(pt),
      nodeId,
      useType: p.USE_TYPE,
      aliases: [...new Set([...meta.aliases, ...meta.aliases.map((a) => `${a} ${levelName.toLowerCase()}`), ...(room ? roomAliases(room.name) : [])])],
    });
    report.places.pois++;
  }
  return places;
}
