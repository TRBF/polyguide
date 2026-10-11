/**
 * Reading an HG room sign the way a careful person would, not the way a camera spells it.
 *
 * Measured on our HG data (580 rooms):
 *  - the number is a map coordinate: rooms 1–2 numbers apart are ~16 m apart, >10 apart ~87 m;
 *  - the number is the position, the letter the floor: the same number on another floor sits ~11 m away
 *    horizontally (61 % within 15 m, random pairs 68 m);
 *  - E and F are the camera's most dangerous confusion: 45 of 74 E rooms have an exact F twin almost above them.
 *
 * So a reading is split in two (A): the NUMBER places the user horizontally and is checked against where they
 * probably are; the LETTER claims a floor and is weighed against the floor the route says they are on. Every room
 * that could have produced the reading counts (B): likely misreads (E↔F, 1↔7, 3↔8, a lost dot "331" → 33.1, a lost
 * or extra "O" mezzanine letter) cost a little, and the prior position decides between them.
 */
import type { Place } from '@polyguide/shared';
import { getGraph } from '../graphStore';

export interface SignReading {
  floor: string | null;
  number: number;
  sub: string | null;
  /** Characters were missing ("F 3?"): any room starting with what was read. */
  partial: boolean;
}

export interface SignPrior {
  /** Where the user probably stands (local metres); absent when only the floor is known. */
  x?: number;
  y?: number;
  levelId?: string;
  /** How sure the app is of the floor (route on a level = strong; a stale fix = weak). */
  floorStrength: 'strong' | 'weak';
}

export interface SignCandidate {
  place: Place;
  /** 0..1 among the candidates. */
  probability: number;
  /** How far the reading had to be "corrected" to give this room (0 = read exactly). */
  readingCost: number;
  /** Horizontal metres from the prior, when there is one. */
  distM: number | null;
  /** Spoken explanation when the result is not the literal reading ("read E 33, but you are on floor F"). */
  note?: string;
}

/* ───── Confusions (cost ≈ how readily a camera makes them) ───── */

const FLOOR_CONFUSION: Record<string, Record<string, number>> = {
  E: { F: 0.5 }, F: { E: 0.5 },
  B: { D: 0.9 }, D: { B: 0.9 },
  C: { G: 0.8 }, G: { C: 0.8 },
  H: { K: 0.9 }, K: { H: 0.9 },
};
/** A mezzanine letter ("FO") lost or invented: F ↔ FO. */
const MEZZANINE_COST = 0.6;
const DIGIT_CONFUSION: Record<string, Record<string, number>> = {
  '1': { '7': 0.6, '4': 1.0 }, '7': { '1': 0.6, '2': 0.9 },
  '3': { '8': 0.7, '5': 1.0 }, '8': { '3': 0.7, '6': 0.7, '0': 0.8, '9': 0.9 },
  '6': { '8': 0.7, '5': 0.8, '0': 0.8 }, '5': { '6': 0.8, '3': 1.0 },
  '0': { '8': 0.8, '6': 0.8 }, '9': { '8': 0.9 }, '2': { '7': 0.9 }, '4': { '1': 1.0 },
};
const LOST_DOT_COST = 0.3;
const FLOOR_UNREAD_COST = 0.4;
const SUB_UNREAD_COST = 0.35;

/** "HG F 33.2", "f33.2", "F 33,2", "E 41", "33.2", "F 3?", "331" → parts. */
export function parseSign(text: string): SignReading | null {
  const t = text.toUpperCase().replace(/^\s*HG\s*/, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^([A-K]O?)?\s?(\d{1,4})(?:\s?[.,]\s?(\d{1,2}))?\s?(\?+)?$/);
  if (!m) return null;
  return { floor: m[1] ?? null, number: Number(m[2]), sub: m[3] ?? null, partial: Boolean(m[4]) };
}

/* ───── Room index ───── */

interface Room { place: Place; floor: string; number: number; sub: string | null; x: number; y: number }
let rooms: Room[] | null = null;
let byNumber: Map<number, Room[]> | null = null;
function index(): Map<number, Room[]> {
  if (!byNumber) {
    const g = getGraph();
    rooms = [];
    for (const p of g.places) {
      if (p.kind !== 'room') continue;
      const m = p.name.match(/^HG ([A-K]O?) (\d+)(?:\.(\d+))?$/);
      if (!m) continue;
      const { x, y } = g.xy(p);
      rooms.push({ place: p, floor: m[1], number: Number(m[2]), sub: m[3] ?? null, x, y });
    }
    byNumber = new Map();
    for (const r of rooms) (byNumber.get(r.number) ?? byNumber.set(r.number, []).get(r.number)!).push(r);
  }
  return byNumber;
}

/** The numbers a camera might have meant, with the cost of each correction (one substitution at most). */
function numberVariants(reading: SignReading): { number: number; sub: string | null; cost: number }[] {
  const out: { number: number; sub: string | null; cost: number }[] = [{ number: reading.number, sub: reading.sub, cost: 0 }];
  const digits = String(reading.number);
  // A lost dot: "331" → 33.1 (HG main numbers are 1–69, subs one digit).
  if (!reading.sub && digits.length >= 2) {
    out.push({ number: Number(digits.slice(0, -1)), sub: digits.slice(-1), cost: LOST_DOT_COST });
  }
  for (let i = 0; i < digits.length; i++) {
    for (const [to, cost] of Object.entries(DIGIT_CONFUSION[digits[i]] ?? {})) {
      out.push({ number: Number(digits.slice(0, i) + to + digits.slice(i + 1)), sub: reading.sub, cost });
    }
  }
  if (reading.sub) {
    for (const [to, cost] of Object.entries(DIGIT_CONFUSION[reading.sub.at(-1)!] ?? {})) {
      out.push({ number: reading.number, sub: reading.sub.slice(0, -1) + to, cost });
    }
  }
  return out;
}

function floorCost(read: string | null, actual: string): number {
  if (!read) return FLOOR_UNREAD_COST;
  if (read === actual) return 0;
  const base = (f: string) => f.replace(/O$/, '');
  if (base(read) === base(actual)) return MEZZANINE_COST;
  const c = FLOOR_CONFUSION[base(read)]?.[base(actual)];
  if (c != null) return c + (read.endsWith('O') !== actual.endsWith('O') ? MEZZANINE_COST : 0);
  return Infinity;
}

const floorOf = (levelId: string | undefined) => levelId?.split('.').at(-1);

/**
 * Every room that could have produced `text`, most likely first. Without a prior the reading itself decides;
 * with one, the floor the user is on and the distance from where they probably stand weigh in.
 */
export function interpretSign(text: string, prior?: SignPrior | null, limit = 5): SignCandidate[] {
  const reading = parseSign(text);
  if (!reading) return [];
  const idx = index();
  const scored = new Map<string, { room: Room; cost: number }>();
  const consider = (room: Room, cost: number) => {
    const prev = scored.get(room.place.id);
    if (!prev || cost < prev.cost) scored.set(room.place.id, { room, cost });
  };

  for (const v of numberVariants(reading)) {
    const sameNumber = reading.partial
      // "F 3?" → 3, 30–39 (the missing characters follow what was read)
      ? [...idx.entries()].filter(([n]) => n === v.number || String(n).startsWith(String(v.number))).flatMap(([, rs]) => rs)
      : idx.get(v.number) ?? [];
    for (const room of sameNumber) {
      const fc = floorCost(reading.floor, room.floor);
      if (!Number.isFinite(fc)) continue;
      let sc = 0;
      if (v.sub && room.sub !== v.sub) continue;
      if (!v.sub && room.sub) sc = SUB_UNREAD_COST; // "F 33" read, the door says F 33.2
      const partialCost = reading.partial && room.number !== v.number ? 0.5 : 0;
      consider(room, v.cost + fc + sc + partialCost);
    }
  }
  if (!scored.size) return [];

  const priorFloor = floorOf(prior?.levelId);
  const results = [...scored.values()].map(({ room, cost }) => {
    let s = Math.exp(-1.5 * cost);
    let distM: number | null = null;
    if (prior?.x != null && prior.y != null) {
      distM = Math.hypot(room.x - prior.x, room.y - prior.y);
      // The number is the horizontal position: near where the user probably is.
      s *= 0.3 + 0.7 * Math.pow(0.5, distM / 35);
    }
    // The letter claims a floor; floors change only by stairs or an elevator.
    if (prior && priorFloor) s *= room.floor === priorFloor ? 1 : prior.floorStrength === 'strong' ? 0.2 : 0.5;
    return { room, cost, distM, s };
  }).sort((a, b) => b.s - a.s);

  const total = results.reduce((sum, r) => sum + r.s, 0);
  return results.slice(0, limit).map(({ room, cost, distM, s }) => {
    const literal = reading.floor === room.floor && reading.number === room.number && (reading.sub ?? null) === room.sub;
    let note: string | undefined;
    if (!literal && cost > 0) {
      const read = `${reading.floor ? `${reading.floor} ` : ''}${reading.number}${reading.sub ? `.${reading.sub}` : ''}`;
      note = reading.floor && reading.floor !== room.floor && priorFloor === room.floor
        ? `The camera read ${read}, but you are on floor ${room.floor}, so it is most likely ${room.place.name}.`
        : `The camera read ${read}; the closest real room is ${room.place.name}.`;
    }
    return { place: room.place, probability: +(s / total).toFixed(3), readingCost: +cost.toFixed(2), distM: distM == null ? null : Math.round(distM), ...(note ? { note } : {}) };
  });
}

/** A prior from a graph node or a lat/lon + level, for interpretSign. */
export function priorFrom(at: { nodeId?: string; lat?: number; lon?: number; levelId?: string } | undefined, floorStrength: SignPrior['floorStrength'] = 'strong'): SignPrior | null {
  if (!at) return null;
  const g = getGraph();
  const node = at.nodeId ? g.nodes.get(at.nodeId) : undefined;
  if (node) {
    const { x, y } = g.xy(node);
    return { x, y, levelId: node.levelId ?? at.levelId, floorStrength };
  }
  if (at.lat != null && at.lon != null) {
    const { x, y } = g.xy({ lat: at.lat, lon: at.lon });
    return { x, y, levelId: at.levelId, floorStrength };
  }
  return at.levelId ? { levelId: at.levelId, floorStrength } : null;
}
