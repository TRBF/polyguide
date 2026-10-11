/**
 * Graph-side of "where am I": walking distances from a node (the prior: where the route or the user says
 * they are), and a plain spoken description of a spot from the places around it.
 */
import type { NodeId, Place } from '@polyguide/shared';
import { MinHeap } from '@polyguide/routing';
import { getGraph } from '../graphStore';

/** Changing floor is a real effort and a common confusion: count it as this many extra metres. */
const FLOOR_CHANGE_M = 25;

/** Walking distance (metres) from `from` to every node within `maxM`. Ignores one-way rules: people backtrack. */
export function walkDistances(from: NodeId, maxM: number): Map<NodeId, number> {
  const g = getGraph();
  const dist = new Map<NodeId, number>();
  if (!g.nodes.has(from)) return dist;
  const heap = new MinHeap<NodeId>();
  dist.set(from, 0);
  heap.push(from, 0);
  while (heap.size) {
    const id = heap.pop()!;
    const d = dist.get(id)!;
    for (const arc of neighbours(id)) {
      const extra = arc.edge.levelFrom !== arc.edge.levelTo ? FLOOR_CHANGE_M : 0;
      const nd = d + arc.edge.lengthM + extra;
      if (nd > maxM || nd >= (dist.get(arc.to) ?? Infinity)) continue;
      dist.set(arc.to, nd);
      heap.push(arc.to, nd);
    }
  }
  return dist;
}

let undirected: Map<NodeId, { edge: { lengthM: number; levelFrom: string | null; levelTo: string | null }; to: NodeId }[]> | null = null;
function neighbours(id: NodeId) {
  if (!undirected) {
    undirected = new Map();
    for (const e of getGraph().edges.values()) {
      (undirected.get(e.from) ?? undirected.set(e.from, []).get(e.from)!).push({ edge: e, to: e.to });
      (undirected.get(e.to) ?? undirected.set(e.to, []).get(e.to)!).push({ edge: e, to: e.from });
    }
  }
  return undirected.get(id) ?? [];
}

let byNode: Map<NodeId, Place[]> | null = null;
/** Places attached to each graph node (rooms by their door, facilities by their point). */
export function placesAt(id: NodeId): Place[] {
  if (!byNode) {
    byNode = new Map();
    for (const p of getGraph().places) (byNode.get(p.nodeId) ?? byNode.set(p.nodeId, []).get(p.nodeId)!).push(p);
  }
  return byNode.get(id) ?? [];
}

export const floorName = (levelId: string | null | undefined) => (levelId ? levelId.split('.').at(-1) ?? levelId : '');

/** How a place is said aloud: "HG F 30, the Audimax", "the men's toilet", "the main entrance". */
export function spokenPlace(p: Place): string {
  if (p.kind === 'room') return p.label ? `${p.name}, the ${p.label}` : p.name;
  const label = (p.label ?? p.name).replace(/, floor \w+$/i, '');
  const lower = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  // Category labels ("Food and drink", "Printing and copying") read wrong with "the".
  return /\band\b/i.test(label) ? lower : `the ${lower}`;
}

/** Facilities worth naming as orientation points, most useful first (all toilets count as one kind). */
const USEFUL = [/elevator/i, /stair/i, /entrance/i, /toilet/i, /information/i, /food|caf|mensa/i, /cloakroom/i, /library/i];
const usefulRank = (p: Place) => {
  const text = `${p.label ?? ''} ${p.name}`;
  const i = USEFUL.findIndex((re) => re.test(text));
  return i < 0 ? 99 : i;
};

const roundM = (m: number) => (m < 4 ? 'right here' : `about ${m < 20 ? Math.round(m / 2) * 2 : Math.round(m / 5) * 5} metres away`);

export interface SpotDescription {
  /** One or two short spoken sentences. */
  text: string;
  levelId: string;
  /** The room or place the description is anchored on. */
  anchor?: Place;
  nearby: { place: Place; distanceM: number }[];
}

/**
 * "You are on floor F, at HG F 30, the Audimax. The elevator is about 12 metres away, the men's toilet about 20."
 * Anchored on the closest room (or named place), then up to two useful facilities on the same floor.
 */
export function describeSpot(nodeId: NodeId): SpotDescription {
  const g = getGraph();
  const node = g.nodes.get(nodeId);
  const levelId = node?.levelId ?? '';
  const reach = walkDistances(nodeId, 60);
  const around: { place: Place; distanceM: number }[] = [];
  for (const [id, d] of reach) {
    for (const p of placesAt(id)) if (p.levelId === levelId) around.push({ place: p, distanceM: d });
  }
  around.sort((a, b) => a.distanceM - b.distanceM);
  // Standing right at an entrance, elevator or other facility: that is the clearest anchor ("at the main
  // entrance"). Else a named room (the Audimax) when close, else the nearest room door.
  const atFacility = around.find((a) => a.place.kind !== 'room' && a.distanceM < 4 && usefulRank(a.place) < 99);
  const named = around.find((a) => a.place.kind === 'room' && a.place.label);
  const anchor = atFacility ?? (named && named.distanceM < 15 ? named : around.find((a) => a.place.kind === 'room') ?? around[0]);
  // One of each kind (two doors of the same entrance are one entrance), never the anchor's own kind.
  const seen = new Set<number>(anchor ? [usefulRank(anchor.place)] : []);
  const facilities = around
    .filter((a) => a.place.kind !== 'room' && a.place !== anchor?.place && a.distanceM <= 45)
    .sort((a, b) => usefulRank(a.place) - usefulRank(b.place) || a.distanceM - b.distanceM)
    .filter((a) => {
      const rank = usefulRank(a.place);
      if (rank === 99 || seen.has(rank)) return false;
      seen.add(rank);
      return true;
    })
    .slice(0, 2);

  const floor = floorName(levelId);
  const where = anchor
    ? anchor.distanceM < 4 ? `at ${spokenPlace(anchor.place)}` : `near ${spokenPlace(anchor.place)}`
    : 'in a corridor';
  const parts = [`You are on floor ${floor}, ${where}.`];
  if (facilities.length) {
    const said = facilities.map((f, i) => `${i === 0 ? capitalize(spokenPlace(f.place)) : spokenPlace(f.place)} is ${roundM(f.distanceM)}`);
    parts.push(`${said.join(', ')}.`);
  }
  return { text: parts.join(' '), levelId, anchor: anchor?.place, nearby: facilities };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
