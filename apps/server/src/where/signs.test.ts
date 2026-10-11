import { beforeAll, describe, expect, it } from 'vitest';
import { getPlace, loadGraph } from '../graphStore';
import { interpretSign, parseSign, priorFrom } from './signs';

describe('parseSign', () => {
  it('splits floor letter, number and sub-room, however the camera spells it', () => {
    expect(parseSign('HG F 33.2')).toEqual({ floor: 'F', number: 33, sub: '2', partial: false });
    expect(parseSign('f33,2')).toEqual({ floor: 'F', number: 33, sub: '2', partial: false });
    expect(parseSign('FO 21')).toEqual({ floor: 'FO', number: 21, sub: null, partial: false });
    expect(parseSign('33.2')).toEqual({ floor: null, number: 33, sub: '2', partial: false });
    expect(parseSign('F 3?')).toEqual({ floor: 'F', number: 3, sub: null, partial: true });
    expect(parseSign('Audimax')).toBeNull();
  });
});

describe('interpretSign (real HG data)', () => {
  beforeAll(() => { loadGraph(); });
  const at = (placeId: string, floorStrength: 'strong' | 'weak' = 'strong') => priorFrom({ nodeId: getPlace(placeId)!.nodeId }, floorStrength);

  it('reads an exact sign as itself', () => {
    expect(interpretSign('HG F 33.2', at('pl_hg_f_30'))[0].place.name).toBe('HG F 33.2');
  });

  it('E/F trap: "E 33.2" read on floor F is F 33.2, and says why', () => {
    const [best] = interpretSign('E 33.2', at('pl_hg_f_30'));
    expect(best.place.name).toBe('HG F 33.2');
    expect(best.note).toMatch(/on floor F/);
  });

  it('…but with no idea of the floor, the letter as read wins', () => {
    const best = interpretSign('E 41')[0];
    expect(best.place.name).toBe('HG E 41');
  });

  it('a lost dot: "F 331" is F 33.1', () => {
    expect(interpretSign('F 331', at('pl_hg_f_30'))[0].place.name).toBe('HG F 33.1');
  });

  it('a digit misread (1↔7) resolves to the real room near the user', () => {
    // Near F 30, "F 37" does not exist if it is not a room; the reading falls to plausible neighbours.
    const best = interpretSign('F 31.1', at('pl_hg_f_30'))[0];
    expect(best.place.levelId).toBe('ETH.HG.F');
    expect(best.distM).toBeLessThan(60);
  });

  it('number only (letter unreadable): the same number on the user\'s floor', () => {
    const best = interpretSign('33.2', at('pl_hg_f_30'))[0];
    expect(best.place.name).toBe('HG F 33.2');
  });

  it('a partial reading narrows to rooms starting with what was read, near the user', () => {
    const best = interpretSign('F 3?', at('pl_hg_f_30'))[0];
    expect(best.place.name).toMatch(/^HG F 3/);
  });

  it('a weak floor prior lets a clear letter move the user to another floor', () => {
    const strong = interpretSign('G 5', at('pl_hg_f_30', 'strong'))[0];
    const weak = interpretSign('G 5', at('pl_hg_f_30', 'weak'))[0];
    expect(weak.place.levelId).toBe('ETH.HG.G');
    expect(strong.probability).toBeLessThanOrEqual(1);
  });

  it('probabilities are a distribution', () => {
    const all = interpretSign('E 33', at('pl_hg_f_30'), 10);
    const sum = all.reduce((s, c) => s + c.probability, 0);
    expect(sum).toBeLessThanOrEqual(1.001);
    expect(all[0].probability).toBeGreaterThan(all.at(-1)!.probability);
  });
});
