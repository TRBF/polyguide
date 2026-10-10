import type { EdgeId, GraphEdge, GraphJson, GraphNode, Level, NodeId, Place } from '@polyguide/shared';

export interface Arc {
  edge: GraphEdge;
  to: NodeId;
}

/** In-memory graph with directed adjacency (respects oneway). */
export class Graph {
  readonly nodes = new Map<NodeId, GraphNode>();
  readonly edges = new Map<EdgeId, GraphEdge>();
  readonly adj = new Map<NodeId, Arc[]>();
  readonly levels: Level[];
  readonly levelOrder: Map<string, number>;
  readonly places: Place[];

  constructor(readonly json: GraphJson) {
    for (const n of json.nodes) {
      this.nodes.set(n.id, n);
      this.adj.set(n.id, []);
    }
    for (const e of json.edges) {
      this.edges.set(e.id, e);
      if (e.oneway !== 'backward') this.adj.get(e.from)?.push({ edge: e, to: e.to });
      if (e.oneway !== 'forward') this.adj.get(e.to)?.push({ edge: e, to: e.from });
    }
    this.levels = json.levels;
    this.levelOrder = new Map(json.levels.map((l) => [l.id, l.verticalOrder]));
    this.places = json.places;
  }

  node(id: NodeId): GraphNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  /** The other end of `edge` when arriving at/leaving from `id`. */
  other(edge: GraphEdge, id: NodeId): NodeId {
    return edge.from === id ? edge.to : edge.from;
  }
}
