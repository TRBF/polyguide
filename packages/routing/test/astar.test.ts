import { describe, expect, it } from 'vitest';
import { Graph, MinHeap, astar, costModel } from '../src';
import { toyGraph } from './toy';

const graph = new Graph(toyGraph());
const route = (from: string, to: string, needs: any[] = [], extra = {}) =>
  astar(graph, from, to, costModel(graph, { needs, ...extra }));

describe('MinHeap', () => {
  it('pops in priority order', () => {
    const h = new MinHeap<number>();
    for (const v of [5, 1, 9, 3, 7, 2, 8]) h.push(v, v);
    const out: number[] = [];
    while (h.size) out.push(h.pop()!);
    expect(out).toEqual([1, 2, 3, 5, 7, 8, 9]);
  });
});

describe('astar', () => {
  it('default profile takes the shorter stairs', () => {
    const r = route('A', 'F_ST')!;
    expect(r.edges.map((e) => e.kind)).toContain('stairs');
    expect(r.edges.map((e) => e.kind)).not.toContain('elevator');
  });

  it('wheelchair never uses stairs and takes the elevator', () => {
    const r = route('A', 'F_ST', ['wheelchair'])!;
    const kinds = r.edges.map((e) => e.kind);
    expect(kinds).not.toContain('stairs');
    expect(kinds).toContain('elevator');
  });

  it('avoidStairs forbids stairs for any profile', () => {
    const r = route('A', 'F_ST', [], { avoidStairs: true })!;
    expect(r.edges.map((e) => e.kind)).not.toContain('stairs');
  });

  it('respects one-way edges', () => {
    // A → S is allowed directly.
    expect(route('A', 'S')!.nodes).toEqual(['A', 'S']);
    // S → A may not reverse the one-way A→S edge; it must go round via E_EL and E_ST.
    expect(route('S', 'A')!.nodes).toEqual(['S', 'E_EL', 'E_ST', 'A']);
    // E_EL → S is forbidden (edge only runs S → E_EL); the detour back through A is also one-way.
    expect(route('E_EL', 'S')!.nodes).toEqual(['E_EL', 'E_ST', 'A', 'S']);
  });

  it('returns null when everything is forbidden', () => {
    const g = new Graph({ ...toyGraph(), edges: toyGraph().edges.filter((e) => e.kind !== 'elevator') });
    expect(astar(g, 'A', 'F_ST', costModel(g, { needs: ['wheelchair'] }))).toBeNull();
  });

  it('closed edges from overrides are avoided', () => {
    const stairs = toyGraph().edges.find((e) => e.kind === 'stairs')!;
    const r = astar(graph, 'A', 'F_ST', costModel(graph, { needs: [] }, { overrides: { closedEdges: [stairs.id], edgeMultipliers: {}, notes: {}, seats: [] } }))!;
    expect(r.edges.map((e) => e.kind)).toContain('elevator');
  });

  it('A* cost equals Dijkstra cost (heuristic is admissible)', () => {
    const model = costModel(graph, { needs: ['blind'] });
    const zero = { ...model, minSecondsPerMetre: 0 };
    for (const [a, b] of [['A', 'F_EL'], ['F_MID', 'A'], ['E_EL', 'F_ST']]) {
      expect(astar(graph, a, b, model)!.cost).toBeCloseTo(astar(graph, a, b, zero)!.cost, 6);
    }
  });
});
