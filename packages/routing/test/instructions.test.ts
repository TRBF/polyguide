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
