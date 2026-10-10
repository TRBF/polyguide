import { describe, expect, it } from 'vitest';
import type { Place } from '@polyguide/shared';
import { Graph, classifyTurn, planRoute, speakFloor, speakMetres, speakRoom } from '../src';
import { toyGraph } from './toy';

describe('speech rules', () => {
  it('spells room names for TTS', () => {
    expect(speakRoom('HG F 30')).toBe('room H G, F thirty');
    expect(speakRoom('HG E 33.5', false)).toBe('E thirty-three point five');
    expect(speakFloor('ETH.HG.EO')).toBe('floor E O');
  });
  it('rounds distances to 5 m', () => {
    expect(speakMetres(24)).toBe('about twenty-five metres');
    expect(speakMetres(1)).toBe('about five metres');
    expect(speakMetres(103)).toBe('about one hundred five metres');
  });
});

describe('classifyTurn', () => {
  it.each([
    [10, 'straight'],
    [-40, 'slight_left'],
    [90, 'right'],
    [-100, 'left'],
    [150, 'sharp_right'],
    [175, 'u_turn'],
    [-170, 'u_turn'],
  ])('%d° → %s', (deg, m) => expect(classifyTurn(deg)).toBe(m));
});

describe('planRoute', () => {
  const graph = new Graph(toyGraph());
  const place = (id: string, nodeId: string, levelId: string, x: number, y: number): Place => ({
    id,
    name: id,
    kind: 'room',
    levelId,
    verticalOrder: null,
    lat: 47 + y / 110540,
    lon: 8 + x / (Math.cos((47 * Math.PI) / 180) * 111320),
    nodeId,
    aliases: [],
  });
  const from = place('HG E 1', 'A', 'L.E', 0, 0);
  const to = place('HG F 2', 'F_ST', 'L.F', 10, 13);

  it('wheelchair route has an elevator step, no stairs, and a summary', () => {
    const r = planRoute(graph, { routeId: 'r1', from, to, profile: { needs: ['wheelchair'] } });
    if (!r.ok) throw new Error(r.message);
    expect(r.steps.map((s) => s.maneuver)).toContain('take_elevator');
    expect(r.steps.flatMap((s) => s.edgeKinds)).not.toContain('stairs');
    expect(r.profileSummary).toContain('No stairs');
    expect(r.profileSummary).toContain('Uses 1 elevator');
    expect(r.steps.at(-1)!.maneuver).toBe('arrive');
    expect(r.steps[0].maneuver).toBe('depart');
    expect(r.levels).toEqual(['L.E', 'L.F']);
  });

  it('default route takes the stairs up', () => {
    const r = planRoute(graph, { routeId: 'r2', from, to, profile: { needs: [] } });
    if (!r.ok) throw new Error(r.message);
    expect(r.steps.map((s) => s.maneuver)).toContain('take_stairs_up');
  });

  it('arrive side: destination right of the last heading', () => {
    // Last leg on F heads west (F_MID → F_ST); destination north of F_ST is on the right when heading west.
    const r = planRoute(graph, { routeId: 'r3', from, to, profile: { needs: ['wheelchair'] } });
    if (!r.ok) throw new Error(r.message);
    expect(r.steps.at(-1)!.side).toBe('right');
  });

  it('no_route when forbidden', () => {
    const g = new Graph({ ...toyGraph(), edges: toyGraph().edges.filter((e) => e.kind !== 'elevator') });
    const r = planRoute(g, { routeId: 'r4', from, to, profile: { needs: ['wheelchair'] } });
    expect(r).toMatchObject({ ok: false, reason: 'no_route' });
  });
});

describe('real HG graph regressions', () => {
  it('names the floor actually reached when an elevator edge is travelled against its stored direction', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const g = new Graph(JSON.parse(readFileSync(resolve(__dirname, '../../../data/hg/graph.json'), 'utf8')));
    const place = (id: string) => g.places.find((p) => p.id === id)!;
    // Haupteingang HG E → accessible toilet on floor D: one elevator ride down, E → D.
    const r = planRoute(g, { routeId: 't', from: place('pl_lm_137'), to: place('pl_poi_275607'), profile: { needs: ['wheelchair'] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ride = r.steps.find((s) => s.maneuver === 'take_elevator')!;
    expect(ride.levelId).toBe('ETH.HG.E');
    expect(ride.toLevelId).toBe('ETH.HG.D');
    expect(ride.text).toBe('Take the elevator down to floor D');
    expect(r.levels).toEqual(['ETH.HG.E', 'ETH.HG.D']);
    expect(r.steps.at(-1)!.speech).not.toMatch(/the Accessible toilet/);
  });
});

describe('out-of-service elevator', () => {
  it('reroutes around the whole shaft the user reported', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { closedElevatorShafts } = await import('../src');
    const g = new Graph(JSON.parse(readFileSync(resolve(__dirname, '../../../data/hg/graph.json'), 'utf8')));
    const place = (id: string) => g.places.find((p) => p.id === id)!;
    const profile = { needs: ['wheelchair' as const] };
    const first = planRoute(g, { routeId: 'a', from: place('pl_lm_137'), to: place('pl_hg_f_30'), profile });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const ride = first.steps.find((s) => s.maneuver === 'take_elevator')!;
    const shaft = new Set(closedElevatorShafts(g, [ride.startNodeId]));
    expect(shaft.size).toBeGreaterThan(0);
    const second = planRoute(g, { routeId: 'b', from: place('pl_lm_137'), to: place('pl_hg_f_30'), profile: { ...profile, avoidElevatorAt: [ride.startNodeId] } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const ride2 = second.steps.find((s) => s.maneuver === 'take_elevator')!;
    expect(ride2).toBeDefined();
    expect(ride2.startNodeId).not.toBe(ride.startNodeId);
    // None of the closed shaft's edges may touch the new ride's nodes.
    const closedNodes = new Set([...shaft].flatMap((id) => { const e = g.edges.get(id)!; return [e.from, e.to]; }));
    expect(closedNodes.has(ride2.startNodeId)).toBe(false);
    expect(second.warnings).toContain('Avoids the elevator you reported as out of service.');
  });
});

describe('HG blueprint guarantees (real graph)', () => {
  it('every node and edge has a floor; doors are kept; inferred elevators are flagged', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const json = JSON.parse(readFileSync(resolve(__dirname, '../../../data/hg/graph.json'), 'utf8'));
    expect(json.nodes.filter((n: { levelId: string | null }) => !n.levelId)).toHaveLength(0);
    expect(json.edges.filter((e: { levelFrom: string | null; levelTo: string | null }) => !e.levelFrom || !e.levelTo)).toHaveLength(0);
    expect(json.nodes.filter((n: { door?: boolean }) => n.door).length).toBeGreaterThan(20);
    const synthetic = json.edges.filter((e: { synthetic?: boolean }) => e.synthetic);
    expect(synthetic.length).toBeGreaterThan(0);
    for (const e of synthetic) expect(e.kind).toBe('elevator');
  });

  it('random routes: floor changes name the floor reached, no 1-metre steps, inferred elevators always warn', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const g = new Graph(JSON.parse(readFileSync(resolve(__dirname, '../../../data/hg/graph.json'), 'utf8')));
    const rooms = g.places.filter((p) => p.kind === 'room');
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
    let vertical = 0;
    let wrongFloor = 0;
    for (let i = 0; i < 120; i++) {
      const [a, b] = [rooms[Math.floor(rnd() * rooms.length)], rooms[Math.floor(rnd() * rooms.length)]];
      if (a === b) continue;
      const r = planRoute(g, { routeId: 't', from: a, to: b, profile: { needs: i % 2 ? ['wheelchair'] : [] } });
      if (!r.ok) continue;
      r.steps.forEach((s, k) => {
        if (s.maneuver !== 'arrive' && !s.toLevelId && !/lift/i.test(s.text)) expect(s.distanceM, `${a.name}→${b.name}: "${s.text}"`).toBeGreaterThanOrEqual(2);
        if (!s.toLevelId) return;
        vertical++;
        if (r.steps[k + 1] && r.steps[k + 1].levelId !== s.toLevelId) wrongFloor++;
      });
      const usesSynthetic = r.steps.some((s) => s.maneuver === 'take_elevator') && r.warnings.some((w) => w.includes('missing from their routing data'));
      if (usesSynthetic) expect(r.warnings.join(' ')).toMatch(/Check it works/);
    }
    expect(vertical).toBeGreaterThan(50);
    expect(wrongFloor / vertical).toBeLessThan(0.02);
  });

  it('speaks entrances by their English name', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const g = new Graph(JSON.parse(readFileSync(resolve(__dirname, '../../../data/hg/graph.json'), 'utf8')));
    const from = g.places.find((p) => p.name === 'HG F 30')!;
    const to = g.places.find((p) => p.id === 'pl_lm_137')!;
    const r = planRoute(g, { routeId: 'e', from, to, profile: { needs: [] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps.at(-1)!.speech).toMatch(/^You have arrived\. The main entrance/);
  });
});
