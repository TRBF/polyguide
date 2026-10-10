/**
 * Profiles = composable cost modifiers (SPEC §4.3). Cost unit: seconds. Infinity = forbidden.
 * edgeCost = baseTime(edge, speed) × Π multipliers + Σ penalties.
 */
import type { CostContext, CostModifier, EdgeId, GraphEdge, GraphNode, LatLon, Need, Overrides, Profile } from '@polyguide/shared';
import { dist2D } from './geo';
import type { Graph } from './graph';

export const BASE_SPEED_MPS = 1.3;
export const STAIRS_SPEED_MPS = 0.5;
export const ELEVATOR_WAIT_S = 25;
export const ELEVATOR_S_PER_FLOOR = 3;
const FLOOR_HEIGHT_M = 3.5;

/** Context passed to modifiers. Extends the shared CostContext with the node we leave from. */
export interface RoutingContext extends CostContext {
  fromNode: GraphNode;
}

const rankMult = (r2: number, r3: number) => (e: GraphEdge) => (e.rank === 3 ? r3 : e.rank === 2 ? r2 : 1);
const forbid = (kinds: GraphEdge['kind'][]) => (e: GraphEdge) => (kinds.includes(e.kind) ? Infinity : 1);

export const wheelchair: CostModifier = {
  need: 'wheelchair',
  speedMps: 1.0,
  multiplier: (e) => {
    if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'steep') return Infinity;
    return (e.kind === 'ramp' ? 1.2 : 1) * rankMult(1.1, 1.3)(e);
  },
};

function visual(need: 'blind' | 'lowVision', stairsMult: number): CostModifier {
  return {
    need,
    speedMps: 0.9,
    multiplier: (e) =>
      forbid(['escalator', 'moving_walkway'])(e) *
      (e.kind === 'stairs' ? stairsMult : 1) *
      (e.indoor ? 1 : 1.3) *
      rankMult(1.25, 1.6)(e),
    // Fewer, simpler turns: every decision point costs 6 s.
    penaltyS: (_e, ctx) => (ctx.toNode.isDecisionPoint ? 6 : 0),
  };
}
export const blind = visual('blind', 1.5);
export const lowVision = visual('lowVision', 1);

/** Stub: penalty grows with distance from the nearest seat (overrides.json seats[]). */
export function lowStamina(seats: (LatLon & { x?: number; y?: number; levelId: string })[] = []): CostModifier {
  return {
    need: 'lowStamina',
    speedMps: 0.8,
    multiplier: (e) => (e.kind === 'stairs' ? 3 : 1),
    penaltyS: (e, ctx) => {
      const onLevel = seats.filter((s) => s.levelId === ctx.toNode.levelId && s.x != null && s.y != null);
      if (!onLevel.length) return 0;
      const d = Math.min(...onLevel.map((s) => dist2D(ctx.toNode, { x: s.x!, y: s.y! })));
      return e.lengthM * 0.01 * Math.min(d, 100); // up to +100 % beyond 100 m from a seat
    },
  };
}

/** Stub: hourly crowd weights per edge (data/hg/crowd.json). Default 1.0. */
export function avoidCrowds(crowd: Record<EdgeId, number[]> = {}): CostModifier {
  return {
    need: 'avoidCrowds',
    multiplier: (e, ctx) => Math.max(1, crowd[e.id]?.[ctx.now.getHours()] ?? 1),
  };
}

export const avoidStairsModifier: CostModifier = { need: 'avoidStairs', multiplier: forbid(['stairs']) };

export interface ProfileOptions {
  overrides?: Overrides;
  seats?: Parameters<typeof lowStamina>[0];
  crowd?: Record<EdgeId, number[]>;
}

export function modifiersFor(profile: Profile, opts: ProfileOptions = {}): CostModifier[] {
  const byNeed: Record<Need, () => CostModifier> = {
    wheelchair: () => wheelchair,
    blind: () => blind,
    lowVision: () => lowVision,
    lowStamina: () => lowStamina(opts.seats),
    avoidCrowds: () => avoidCrowds(opts.crowd),
  };
  const mods = [...new Set(profile.needs)].map((n) => byNeed[n]());
  if (profile.avoidStairs) mods.push(avoidStairsModifier);
  return mods;
}

export interface CostModel {
  speedMps: number;
  /** Lower bound on seconds per metre of straight-line distance (for the A* heuristic). */
  minSecondsPerMetre: number;
  edgeCost(edge: GraphEdge, ctx: RoutingContext): number;
  /** Pure travel time (no penalties/multipliers): what we show the user. */
  travelTime(edge: GraphEdge, ctx: RoutingContext): number;
}

export function costModel(graph: Graph, profile: Profile, opts: ProfileOptions = {}): CostModel {
  const mods = modifiersFor(profile, opts);
  const speedMps = profile.speedMps ?? Math.min(BASE_SPEED_MPS, ...mods.map((m) => m.speedMps ?? Infinity));
  const closed = new Set(opts.overrides?.closedEdges ?? []);
  const edgeMult = opts.overrides?.edgeMultipliers ?? {};

  const travelTime = (e: GraphEdge, ctx: RoutingContext): number => {
    switch (e.kind) {
      case 'elevator': {
        const floors = Math.abs(ctx.toNode.z - ctx.fromNode.z) / FLOOR_HEIGHT_M;
        const wait = ctx.prevEdge?.kind === 'elevator' ? 0 : ELEVATOR_WAIT_S;
        return wait + Math.max(1, ELEVATOR_S_PER_FLOOR * floors);
      }
      case 'stairs':
        return e.lengthM / Math.min(speedMps, STAIRS_SPEED_MPS);
      default:
        return e.lengthM / speedMps;
    }
  };

  return {
    speedMps,
    // lengthM may be scaled down to ≥ 0.5× the geometric length (build.ts), so halve to stay admissible.
    minSecondsPerMetre: 0.5 / Math.max(speedMps, BASE_SPEED_MPS),
    travelTime,
    edgeCost(e, ctx) {
      if (closed.has(e.id)) return Infinity;
      let mult = edgeMult[e.id] ?? 1;
      let pen = 0;
      for (const m of mods) {
        mult *= m.multiplier?.(e, ctx) ?? 1;
        pen += m.penaltyS?.(e, ctx) ?? 0;
        if (mult === Infinity || pen === Infinity) return Infinity;
      }
      return travelTime(e, ctx) * mult + pen;
    },
  };
}
