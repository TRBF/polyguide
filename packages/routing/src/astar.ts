/** A* over the routing graph (SPEC §4.2). Cost unit: seconds. */
import type { GraphEdge, NodeId } from '@polyguide/shared';
import { dist3D } from './geo';
import type { Graph } from './graph';
import { MinHeap } from './heap';
import type { CostModel } from './profiles';

export interface PathResult {
  nodes: NodeId[];
  edges: GraphEdge[];
  cost: number;
}

export function astar(graph: Graph, start: NodeId, goal: NodeId, model: CostModel, now = new Date()): PathResult | null {
  const goalNode = graph.node(goal);
  const h = (id: NodeId) => dist3D(graph.node(id), goalNode) * model.minSecondsPerMetre;

  const g = new Map<NodeId, number>([[start, 0]]);
  const came = new Map<NodeId, { prev: NodeId; edge: GraphEdge }>();
  const closed = new Set<NodeId>();
  const open = new MinHeap<NodeId>();
  open.push(start, h(start));

  while (open.size) {
    const cur = open.pop()!;
    if (closed.has(cur)) continue;
    if (cur === goal) break;
    closed.add(cur);
    const gCur = g.get(cur)!;
    const fromNode = graph.node(cur);
    const prevEdge = came.get(cur)?.edge;
    for (const { edge, to } of graph.adj.get(cur) ?? []) {
      if (closed.has(to)) continue;
      const toNode = graph.node(to);
      const c = model.edgeCost(edge, { now, prevEdge, toNode, fromNode });
      if (!Number.isFinite(c)) continue;
      const tentative = gCur + c;
      if (tentative < (g.get(to) ?? Infinity)) {
        g.set(to, tentative);
        came.set(to, { prev: cur, edge });
        open.push(to, tentative + h(to));
      }
    }
  }

  if (!g.has(goal)) return null;
  const nodes: NodeId[] = [goal];
  const edges: GraphEdge[] = [];
  for (let id = goal; id !== start; ) {
    const step = came.get(id)!;
    edges.push(step.edge);
    nodes.push(step.prev);
    id = step.prev;
  }
  return { nodes: nodes.reverse(), edges: edges.reverse(), cost: g.get(goal)! };
}

