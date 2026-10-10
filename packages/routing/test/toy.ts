import type { GraphEdge, GraphJson, GraphNode } from '@polyguide/shared';

/**
 * Two floors, 4 m apart.
 *
 *   floor F:          F_ST ─── F_MID ─── F_EL          (y = 10)
 *                      │                   │
 *                    stairs            elevator
 *                      │                   │
 *   floor E:  A ─────── E_ST ──────────── E_EL         (y = 0)
 *             └── oneway shortcut A→E_EL (y = -5) ──┘
 *
 * Stairs are short and near A; the elevator is 60 m away.
 */
const n = (id: string, x: number, y: number, z: number, levelId: string | null, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  x,
  y,
  z,
  lat: 47 + y / 110540,
  lon: 8 + x / 75000,
  levelId,
  verticalOrder: levelId === 'L.F' ? 1 : levelId === 'L.E' ? 0 : null,
  degree: 2,
  isDecisionPoint: false,
  indoor: true,
  ...extra,
});

let k = 0;
const e = (from: string, to: string, kind: GraphEdge['kind'], lengthM: number, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `e${k++}`,
  from,
  to,
  kind,
  lengthM,
  oneway: 'both',
  rank: 1,
  indoor: true,
  levelFrom: null,
  levelTo: null,
  source: kind === 'hallway' ? 'pathway' : 'transition',
  sourceOid: k,
  ...extra,
});

export function toyGraph(): GraphJson {
  k = 0;
  const nodes = [
    n('A', 0, 0, 0, 'L.E'),
    n('E_ST', 10, 0, 0, 'L.E'),
    n('E_EL', 60, 0, 0, 'L.E'),
    n('F_ST', 10, 10, 4, 'L.F'),
    n('F_MID', 35, 10, 4, 'L.F'),
    n('F_EL', 60, 10, 4, 'L.F'),
    n('S', 30, -5, 0, 'L.E'),
  ];
  const edges = [
    e('A', 'E_ST', 'hallway', 10),
    e('E_ST', 'E_EL', 'hallway', 50),
    e('E_ST', 'F_ST', 'stairs', 8, { levelFrom: 'L.E', levelTo: 'L.F' }),
    e('E_EL', 'F_EL', 'elevator', 4, { levelFrom: 'L.E', levelTo: 'L.F' }),
    e('F_ST', 'F_MID', 'hallway', 25),
    e('F_MID', 'F_EL', 'hallway', 25),
    // One-way shortcut A → S → E_EL (usable only in that direction).
    e('A', 'S', 'hallway', 30, { oneway: 'forward' }),
    e('E_EL', 'S', 'hallway', 30, { oneway: 'backward' }),
  ];
  return {
    builtAt: '',
    dataSnapshotAt: '',
    facility: 'TOY',
    origin: { lat: 47, lon: 8 },
    nodes,
    edges,
    places: [],
    levels: [
      { id: 'L.E', name: 'E', verticalOrder: 0, facility: 'TOY' },
      { id: 'L.F', name: 'F', verticalOrder: 1, facility: 'TOY' },
    ],
  };
}
