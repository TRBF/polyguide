/**
 * Deterministic turn-by-turn instructions from an edge path (SPEC §4.5). No AI.
 */
import type { EdgeKind, ExpectedLandmark, GraphEdge, GraphNode, Maneuver, NodeId, Place, RouteStep, Side } from '@polyguide/shared';
import { bearingDeg, dist2D, normalize180, pointSegment } from './geo';
import type { Graph } from './graph';
import type { CostModel } from './profiles';
import { capitalize, floorName, speakFloor, speakMetres, speakRoom } from './speech';

const COLLAPSE_DEG = 25;
const DRIFT_DEG = 45; // gradual curves: break once the heading has drifted this far from the step's start
const MIN_SEG_M = 0.5; // ignore bearings of tiny segments
const TINY_STEP_M = 5; // horizontal steps shorter than this are folded into a neighbour (lobby zig-zags)
const CHORD_M = 8; // horizontal step bearings are measured over this distance
const LANDMARK_RADIUS_M = 6;
const MAX_LANDMARKS = 6;

interface Leg {
  edge: GraphEdge;
  a: GraphNode;
  b: GraphNode;
  vertical: boolean;
  bearing: number | null;
  durationS: number;
}

interface RawStep {
  legs: Leg[];
  vertical: boolean;
  kind: EdgeKind;
  levelId: string;
  firstBearing: number | null;
  lastBearing: number | null;
}

const isVertical = (e: GraphEdge) => e.source === 'transition' && e.kind !== 'entrance' && e.levelFrom !== e.levelTo;

export function classifyTurn(deltaDeg: number): Maneuver {
  const a = Math.abs(deltaDeg);
  const right = deltaDeg > 0;
  if (a < 25) return 'straight';
  if (a < 60) return right ? 'slight_right' : 'slight_left';
  if (a <= 135) return right ? 'right' : 'left';
  if (a >= 160) return 'u_turn';
  return right ? 'sharp_right' : 'sharp_left';
}

const TURN_TEXT: Partial<Record<Maneuver, string>> = {
  straight: 'Continue straight',
  slight_left: 'Bear left',
  slight_right: 'Bear right',
  left: 'Turn left',
  right: 'Turn right',
  sharp_left: 'Turn sharply left',
  sharp_right: 'Turn sharply right',
  u_turn: 'Turn around',
};

/** Signed side of point p relative to the directed segment a→b. */
function sideOf(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): Side {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return cross > 0 ? 'left' : 'right';
}

export interface InstructionInput {
  graph: Graph;
  nodes: NodeId[];
  edges: GraphEdge[];
  model: CostModel;
  to: Place;
  now?: Date;
}

export function buildSteps({ graph, nodes, edges, model, to, now = new Date() }: InstructionInput): RouteStep[] {
  /* 1. Legs with traversal direction. */
  const legs: Leg[] = edges.map((edge, i) => {
    const a = graph.node(nodes[i]);
    const b = graph.node(nodes[i + 1]);
    const vertical = isVertical(edge);
    return {
      edge,
      a,
      b,
      vertical,
      bearing: !vertical && dist2D(a, b) >= MIN_SEG_M ? bearingDeg(a, b) : null,
      durationS: model.travelTime(edge, { now, prevEdge: edges[i - 1], toNode: b, fromNode: a }),
    };
  });

  /* 2. Collapse into raw steps. */
  const raw: RawStep[] = [];
  let cur: RawStep | undefined;
  for (const leg of legs) {
    const level = leg.vertical ? leg.edge.levelFrom ?? leg.a.levelId ?? '' : leg.a.levelId ?? leg.b.levelId ?? cur?.levelId ?? '';
    const startNew =
      !cur ||
      cur.vertical !== leg.vertical ||
      (leg.vertical ? cur.kind !== leg.edge.kind : cur.kind !== leg.edge.kind && (cur.kind === 'entrance' || leg.edge.kind === 'entrance' || cur.kind === 'stairs' || leg.edge.kind === 'stairs')) ||
      (!leg.vertical && level !== cur.levelId) ||
      (!leg.vertical &&
        leg.bearing != null &&
        cur.lastBearing != null &&
        (Math.abs(normalize180(leg.bearing - cur.lastBearing)) >= COLLAPSE_DEG ||
          Math.abs(normalize180(leg.bearing - (cur.firstBearing ?? leg.bearing))) >= DRIFT_DEG));
    if (startNew) {
      cur = { legs: [], vertical: leg.vertical, kind: leg.edge.kind, levelId: level, firstBearing: null, lastBearing: null };
      raw.push(cur);
    }
    cur!.legs.push(leg);
    if (leg.bearing != null) {
      cur!.firstBearing ??= leg.bearing;
      cur!.lastBearing = leg.bearing;
    }
  }

  /* 2b. Fold tiny horizontal steps into a horizontal neighbour on the same level (keeps the main direction). */
  const len = (s: RawStep) => s.legs.reduce((t, l) => t + l.edge.lengthM, 0);
  const foldable = (a: RawStep | undefined, b: RawStep) => a && !a.vertical && !b.vertical && a.kind === b.kind && a.levelId === b.levelId;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (raw.length < 2 || len(s) >= TINY_STEP_M) continue;
    const nxt = raw[i + 1];
    const prv = raw[i - 1];
    if (nxt && foldable(nxt, s)) {
      nxt.legs = [...s.legs, ...nxt.legs];
      nxt.firstBearing ??= s.firstBearing;
      nxt.lastBearing ??= s.lastBearing;
    } else if (prv && foldable(prv, s)) {
      prv.legs.push(...s.legs);
      prv.lastBearing = s.lastBearing ?? prv.lastBearing;
    } else continue;
    raw.splice(i, 1);
    i--;
  }

  /* Chord bearings: direction over the first/last CHORD_M of a step, so folded zig-zags give a walkable heading. */
  const chordBearings = (st: RawStep) => {
    if (st.vertical) return;
    const pts = [st.legs[0].a, ...st.legs.map((l) => l.b)];
    const total = st.legs.reduce((t, l) => t + dist2D(l.a, l.b), 0);
    if (total < MIN_SEG_M) return;
    const at = (d: number) => {
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const seg = dist2D(pts[k], pts[k + 1]);
        if (acc + seg >= d && seg > 0) {
          const t = (d - acc) / seg;
          return { x: pts[k].x + t * (pts[k + 1].x - pts[k].x), y: pts[k].y + t * (pts[k + 1].y - pts[k].y) };
        }
        acc += seg;
      }
      return pts[pts.length - 1];
    };
    const c = Math.min(CHORD_M, total);
    st.firstBearing = bearingDeg(pts[0], at(c));
    st.lastBearing = bearingDeg(at(total - c), pts[pts.length - 1]);
  };
  raw.forEach(chordBearings);

  /* 2c. Merge steps that continue straight on from a horizontal neighbour (drift splits, folded zig-zags). */
  for (let i = 1; i < raw.length; i++) {
    const [a, b] = [raw[i - 1], raw[i]];
    if (
      foldable(a, b) &&
      a.lastBearing != null &&
      b.firstBearing != null &&
      Math.abs(normalize180(b.firstBearing - a.lastBearing)) < COLLAPSE_DEG
    ) {
      a.legs.push(...b.legs);
      chordBearings(a);
      raw.splice(i, 1);
      i--;
    }
  }

  /* 3. Landmark index: rooms/POIs by level. */
  const placesByLevel = new Map<string, { place: Place; node: GraphNode; c: { x: number; y: number } }[]>();
  for (const p of graph.places) {
    if (p.kind !== 'room' && p.kind !== 'poi') continue;
    const node = graph.nodes.get(p.nodeId);
    if (!node) continue;
    const list = placesByLevel.get(p.levelId) ?? placesByLevel.set(p.levelId, []).get(p.levelId)!;
    list.push({ place: p, node, c: graph.xy(p) });
  }

  const destXY = graph.xy(to);
  const steps: RouteStep[] = [];

  raw.forEach((s, i) => {
    const first = s.legs[0];
    const last = s.legs[s.legs.length - 1];
    const distanceM = s.legs.reduce((t, l) => t + l.edge.lengthM, 0);
    const durationS = s.legs.reduce((t, l) => t + l.durationS, 0);
    const polyline: [number, number][] = [[first.a.lon, first.a.lat], ...s.legs.map((l) => [l.b.lon, l.b.lat] as [number, number])];
    const next = raw[i + 1];
    const prev = raw[i - 1];
    const toLevelId = s.vertical ? last.edge.levelTo ?? last.b.levelId ?? undefined : undefined;

    /* Maneuver */
    let maneuver: Maneuver;
    if (s.vertical) {
      const up = last.b.z > first.a.z;
      maneuver =
        s.kind === 'elevator' ? 'take_elevator'
        : s.kind === 'stairs' ? (up ? 'take_stairs_up' : 'take_stairs_down')
        : s.kind === 'ramp' ? (up ? 'take_ramp_up' : 'take_ramp_down')
        : s.kind === 'escalator' ? 'take_escalator'
        : up ? 'take_stairs_up' : 'take_stairs_down';
    } else if (s.kind === 'entrance') {
      maneuver = last.b.indoor ? 'enter_building' : 'exit_building';
    } else if (i === 0 || prev?.vertical || prev?.lastBearing == null || s.firstBearing == null) {
      maneuver = i === 0 ? 'depart' : 'straight';
      if (i > 0 && prev && !prev.vertical && prev.lastBearing != null && s.firstBearing != null)
        maneuver = classifyTurn(normalize180(s.firstBearing - prev.lastBearing));
    } else {
      maneuver = classifyTurn(normalize180(s.firstBearing - prev.lastBearing));
    }

    /* Expected landmarks */
    const landmarks: ExpectedLandmark[] = [];
    if (!s.vertical) {
      const seen = new Set<string>();
      for (const { place, node, c } of placesByLevel.get(s.levelId) ?? []) {
        let along = 0;
        let best: { d: number; at: number; side: Side } | undefined;
        for (const l of s.legs) {
          const segLen = dist2D(l.a, l.b);
          const { d, t } = pointSegment(node, l.a, l.b);
          if (d <= LANDMARK_RADIUS_M && (!best || d < best.d)) best = { d, at: along + t * l.edge.lengthM, side: segLen > 0.1 ? sideOf(l.a, l.b, c) : 'ahead' };
          along += l.edge.lengthM;
        }
        const label = place.kind === 'poi' ? place.label ?? place.name : place.name;
        if (best && !seen.has(`${label}|${best.side}`)) {
          seen.add(`${label}|${best.side}`);
          landmarks.push({
            label,
            kind: place.kind === 'poi' ? 'poi' : 'room_sign',
            side: best.side,
            atDistanceM: Math.round(best.at),
            placeId: place.id,
          });
        }
      }
      landmarks.sort((a, b) => a.atDistanceM - b.atDistanceM);
      landmarks.splice(MAX_LANDMARKS);
      if (next?.vertical) {
        const k = next.kind === 'elevator' ? 'elevator' : 'stairs';
        landmarks.push({ label: k === 'elevator' ? 'elevator' : 'stairs', kind: k, side: 'ahead', atDistanceM: Math.round(distanceM) });
      }
      if (next?.kind === 'entrance') landmarks.push({ label: 'door', kind: 'entrance', side: 'ahead', atDistanceM: Math.round(distanceM) });
    } else if (toLevelId) {
      landmarks.push({ label: `floor ${floorName(toLevelId)}`, kind: 'other', side: 'ahead', atDistanceM: 0 });
    }

    /* Text + speech */
    const target = !next
      ? { text: ` to ${to.name}`, speech: ` to ${to.kind === 'room' ? speakRoom(to.name) : to.name}` }
      : next.vertical
        ? next.kind === 'elevator' ? { text: ' to the elevator', speech: ' to the elevator' }
        : next.kind === 'ramp' ? { text: ' to the ramp', speech: ' to the ramp' }
        : { text: ' to the stairs', speech: ' to the stairs' }
        : next.kind === 'entrance' ? { text: ' to the door', speech: ' to the door' }
        : { text: '', speech: '' };
    const dm = Math.max(1, Math.round(distanceM));
    let text: string;
    let speech: string;
    if (s.vertical && toLevelId) {
      const dir = last.b.z > first.a.z ? 'up' : 'down';
      const what = s.kind === 'elevator' ? 'elevator' : s.kind === 'ramp' ? 'ramp' : s.kind === 'escalator' ? 'escalator' : 'stairs';
      text = `Take the ${what} ${dir} to floor ${floorName(toLevelId)}`;
      speech = `Take the ${what} ${dir} to ${speakFloor(toLevelId)}.` + (s.kind === 'elevator' ? ' Say "done" when you are out of the elevator.' : '');
    } else if (maneuver === 'enter_building' || maneuver === 'exit_building') {
      const verb = maneuver === 'enter_building' ? 'Enter the building' : 'Leave the building';
      text = `${verb}, then go ${dm} m${target.text}`;
      speech = `${verb}. Then go ${speakMetres(distanceM)}${target.speech}.`;
    } else if (maneuver === 'depart') {
      text = `Go ${dm} m${target.text}`;
      speech = `Go straight ahead for ${speakMetres(distanceM)}${target.speech}.`;
    } else if (maneuver === 'straight') {
      text = `Continue straight ${dm} m${target.text}`;
      speech = `Continue straight for ${speakMetres(distanceM)}${target.speech}.`;
    } else {
      const turn = TURN_TEXT[maneuver]!;
      text = `${turn}, then go ${dm} m${target.text}`;
      speech = `${turn}. Then go ${speakMetres(distanceM)}${target.speech}.`;
    }
    if (!s.vertical && s.legs.some((l) => l.edge.kind === 'stairs')) {
      text += ' (includes steps)';
      speech += ' There are steps on the way.';
    }
    const passRooms = landmarks.filter((l) => l.kind === 'room_sign' && l.side !== 'ahead' && l.placeId !== to.id).slice(0, 2);
    if (passRooms.length && distanceM > 8) {
      const side = passRooms[0].side;
      const same = passRooms.filter((l) => l.side === side);
      speech += ` You will pass ${same.length > 1 ? 'rooms' : 'room'} ${same.map((l) => speakRoom(l.label, false)).join(' and ')} on your ${side}.`;
    }

    steps.push({
      index: steps.length,
      maneuver,
      text,
      speech,
      distanceM: Math.round(distanceM * 10) / 10,
      durationS: Math.round(durationS),
      bearingDeg: s.vertical ? null : s.firstBearing != null ? Math.round(s.firstBearing) : null,
      levelId: s.levelId,
      ...(toLevelId ? { toLevelId } : {}),
      startNodeId: first.a.id,
      endNodeId: last.b.id,
      polyline,
      expectedLandmarks: landmarks,
      edgeKinds: [...new Set(s.legs.map((l) => l.edge.kind))],
    });
  });

  /* 4. Arrive */
  const endNode = legs.length ? legs[legs.length - 1].b : graph.node(to.nodeId);
  const lastHz = [...legs].reverse().find((l) => l.bearing != null);
  let side: Side = 'ahead';
  if (lastHz && dist2D(endNode, destXY) > 0.5) {
    const rel = normalize180(bearingDeg(endNode, destXY) - lastHz.bearing!);
    side = Math.abs(rel) < 30 ? 'ahead' : rel > 0 ? 'right' : 'left';
  }
  const spokenName = to.kind === 'room' ? capitalize(speakRoom(to.name)) : to.name;
  const label = to.label ? ` (${to.label})` : '';
  const sideText = side === 'ahead' ? 'ahead of you' : `on your ${side}`;
  steps.push({
    index: steps.length,
    maneuver: 'arrive',
    text: `Arrived: ${to.name}${label} is ${sideText}`,
    speech: `You have arrived. ${spokenName}${to.label ? `, the ${to.label},` : ''} is ${sideText}.`,
    distanceM: 0,
    durationS: 0,
    bearingDeg: null,
    levelId: endNode.levelId ?? to.levelId,
    startNodeId: endNode.id,
    endNodeId: endNode.id,
    polyline: [
      [endNode.lon, endNode.lat],
      [endNode.lon, endNode.lat],
    ],
    expectedLandmarks: [{ label: to.name, kind: to.kind === 'room' ? 'room_sign' : to.kind === 'entrance' ? 'entrance' : 'poi', side, atDistanceM: 0, placeId: to.id }],
    side,
    edgeKinds: [],
  });
  return steps;
}
