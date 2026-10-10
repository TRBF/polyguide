/**
 * Route planning: A* + instructions + summary → RouteResult (SPEC §4.2–4.5). Pure; the server resolves LocationRefs.
 */
import type { NodeId, Overrides, Place, Profile, RouteResult } from '@polyguide/shared';
import { astar } from './astar';
import type { Graph } from './graph';
import { buildSteps } from './instructions';
import { costModel, type ProfileOptions } from './profiles';

export interface PlanInput {
  routeId: string;
  from: Place | { name: string; nodeId: NodeId; levelId: string };
  to: Place;
  profile: Profile;
  options?: ProfileOptions;
  now?: Date;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function planRoute(graph: Graph, input: PlanInput): RouteResult {
  const { from, to, profile, now = new Date() } = input;
  const opts = input.options ?? {};
  const model = costModel(graph, profile, opts);
  const path = astar(graph, from.nodeId, to.nodeId, model, now);
  if (!path) {
    const stepFree = profile.needs.includes('wheelchair') || profile.avoidStairs;
    return {
      ok: false,
      reason: 'no_route',
      message: stepFree
        ? `No step-free route found from ${from.name} to ${to.name}. In the ETH data, some rooms, such as those on half floors, can only be reached by stairs.`
        : `No route found from ${from.name} to ${to.name}.`,
    };
  }
  const steps = buildSteps({ graph, nodes: path.nodes, edges: path.edges, model, to, now });

  const kinds = path.edges.map((e) => e.kind);
  const count = (k: string) => kinds.filter((x) => x === k).length;
  const verticalSteps = (m: string) => steps.filter((s) => s.maneuver.startsWith(m)).length;
  const elevators = verticalSteps('take_elevator');
  const doors = count('entrance');
  const summary: string[] = [];
  summary.push(count('stairs') === 0 ? 'No stairs' : `Includes stairs (${plural(verticalSteps('take_stairs'), 'flight')})`);
  if (elevators) summary.push(`Uses ${plural(elevators, 'elevator')}`);
  if (count('ramp')) summary.push('Includes a ramp');
  if (count('escalator') === 0 && profile.needs.some((n) => n === 'blind' || n === 'lowVision')) summary.push('No escalators');
  if (doors) summary.push(`${plural(doors, 'door')}, widths unknown`);

  const warnings: string[] = [];
  if (profile.needs.includes('wheelchair')) warnings.push('Door widths and automatic doors are not in the ETH data.');
  if (elevators) warnings.push('Elevator status is not live. If an elevator is out of service, ask for a new route.');
  const notes = (opts.overrides as Overrides | undefined)?.notes ?? {};
  for (const e of path.edges) if (notes[e.id]) warnings.push(notes[e.id]);

  const levels: string[] = [];
  for (const s of steps) {
    if (levels[levels.length - 1] !== s.levelId) levels.push(s.levelId);
    if (s.toLevelId && levels[levels.length - 1] !== s.toLevelId) levels.push(s.toLevelId);
  }

  return {
    ok: true,
    routeId: input.routeId,
    from,
    to,
    profile,
    profileSummary: summary,
    totalDistanceM: Math.round(path.edges.reduce((t, e) => t + e.lengthM, 0)),
    totalDurationS: Math.round(steps.reduce((t, s) => t + s.durationS, 0)),
    levels,
    steps,
    warnings: [...new Set(warnings)],
    engine: 'own',
  };
}
