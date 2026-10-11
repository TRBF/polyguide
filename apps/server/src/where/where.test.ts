import { beforeAll, describe, expect, it } from 'vitest';
import { getGraph, getPlace, loadGraph } from '../graphStore';
import { fuse, PHOTO_MIN_SIMILARITY, type FuseInput } from './fuse';
import { describeSpot, walkDistances } from './graphNear';
import { parseObservation } from './localizePrompt';
import { cosine } from './refs';

const empty = (over: Partial<FuseInput> = {}): FuseInput => ({ signs: [], partialSigns: [], photos: [], landmarks: [], floorLevelId: null, prior: null, ...over });

describe('fuse', () => {
  it('a fully read sign wins and says so', () => {
    const r = fuse(empty({ signs: [{ nodeId: 'a', levelId: 'ETH.HG.F', label: 'HG F 33.2', confidence: 1 }] }));
    expect(r.best?.nodeId).toBe('a');
    expect(r.method).toBe('sign');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('without any evidence the route position is trusted, not nothing', () => {
    const r = fuse(empty({ prior: { nodeId: 'p', levelId: 'ETH.HG.F', distances: new Map([['p', 0]]) } }));
    expect(r.best?.nodeId).toBe('p');
    expect(r.method).toBe('route');
  });

  it('prefers the plausible sign near the route over an equally good one across the building', () => {
    const prior = { nodeId: 'p', levelId: 'ETH.HG.F', distances: new Map([['p', 0], ['near', 20]]) };
    const r = fuse(empty({
      signs: [
        { nodeId: 'far', levelId: 'ETH.HG.F', label: 'HG F 33', confidence: 0.9 },
        { nodeId: 'near', levelId: 'ETH.HG.F', label: 'HG F 3', confidence: 0.9 },
      ],
      prior,
    }));
    expect(r.best?.nodeId).toBe('near');
  });

  it('a floor letter in view demotes candidates on other floors', () => {
    const r = fuse(empty({
      photos: [
        { nodeId: 'onE', levelId: 'ETH.HG.E', similarity: 0.8, refId: 'r1' },
        { nodeId: 'onF', levelId: 'ETH.HG.F', similarity: 0.75, refId: 'r2' },
      ],
      floorLevelId: 'ETH.HG.F',
    }));
    expect(r.best?.nodeId).toBe('onF');
  });

  it('weak photo similarity is not evidence', () => {
    const r = fuse(empty({ photos: [{ nodeId: 'x', levelId: 'ETH.HG.F', similarity: PHOTO_MIN_SIMILARITY - 0.01, refId: 'r' }] }));
    expect(r.best).toBeNull();
  });
});

describe('parseObservation', () => {
  it('splits partial signs, keeps only real floor letters and allowed landmarks', () => {
    const o = parseObservation({
      roomSigns: ['HG F 33.2', 'F 3?', 'K 30.1 - K 33'],
      floorText: 'Stockwerk F',
      readText: ['Notausgang'],
      landmarks: ['elevator', 'spaceship'],
      fingerprint: '  Long   corridor with arches. ',
      confidence: 3,
    });
    expect(o.roomSigns).toEqual(['HG F 33.2', 'K 30.1', 'K 33']);
    expect(o.partialSigns).toEqual(['F 3']);
    expect(o.floorLetter).toBe('F');
    expect(o.landmarks).toEqual(['elevator']);
    expect(o.fingerprint).toBe('Long corridor with arches.');
    expect(o.confidence).toBe(1);
  });

  it('survives garbage', () => {
    const o = parseObservation('nope');
    expect(o.roomSigns).toEqual([]);
    expect(o.floorLetter).toBeNull();
    expect(o.confidence).toBe(0);
  });
});

describe('graph descriptions (real HG data)', () => {
  beforeAll(() => { loadGraph(); });
  const nodeOf = (placeId: string) => getPlace(placeId)!.nodeId;

  it('names the Audimax and the floor at its door', () => {
    const d = describeSpot(nodeOf('pl_hg_f_30'));
    expect(d.text).toMatch(/^You are on floor F, at HG F 30, the Audimax\./);
  });

  it('says "at the main entrance" when standing there', () => {
    expect(describeSpot(nodeOf('pl_lm_137')).text).toMatch(/at the main entrance/);
  });

  it('never names the same kind of facility twice', () => {
    const d = describeSpot(nodeOf('pl_hg_e_41'));
    const kinds = d.nearby.map((n) => (n.place.label ?? n.place.name).toLowerCase().includes('entrance'));
    expect(kinds.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it('walking distance grows along the graph and stays within the limit', () => {
    const start = nodeOf('pl_hg_f_30');
    const d = walkDistances(start, 50);
    expect(d.get(start)).toBe(0);
    for (const m of d.values()) expect(m).toBeLessThanOrEqual(50);
    expect(d.size).toBeGreaterThan(5);
    expect(getGraph().nodes.size).toBeGreaterThan(d.size);
  });
});

describe('cosine', () => {
  it('is 1 for the same direction and 0 for orthogonal', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});
