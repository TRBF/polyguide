import { describe, expect, it } from 'vitest';
import type { Maneuver } from '@polyguide/shared';
import { stepPattern } from './haptics';

const pulseCount = (pattern: number[]) => pattern.filter((_, i) => i % 2 === 0).length;

describe('stepPattern', () => {
  it('counts out the direction: 1 straight, 2 left, 3 right, 4 turn around', () => {
    expect(pulseCount(stepPattern('straight'))).toBe(1);
    for (const m of ['slight_left', 'left', 'sharp_left'] as Maneuver[]) expect(pulseCount(stepPattern(m))).toBe(2);
    for (const m of ['slight_right', 'right', 'sharp_right'] as Maneuver[]) expect(pulseCount(stepPattern(m))).toBe(3);
    expect(pulseCount(stepPattern('u_turn'))).toBe(4);
  });

  it('gives floor changes one long buzz, clearly longer than "keep going"', () => {
    for (const m of ['take_elevator', 'take_stairs_up', 'take_stairs_down', 'take_ramp_up', 'take_escalator'] as Maneuver[]) {
      expect(stepPattern(m)).toHaveLength(1);
      expect(stepPattern(m)[0]).toBeGreaterThan(stepPattern('straight')[0] * 2);
    }
  });

  it('makes arrival the longest pattern', () => {
    const total = (p: number[]) => p.reduce((a, b) => a + b, 0);
    const all: Maneuver[] = ['depart', 'straight', 'left', 'right', 'sharp_right', 'u_turn', 'take_elevator', 'enter_building'];
    for (const m of all) expect(total(stepPattern('arrive'))).toBeGreaterThan(total(stepPattern(m)));
  });
});
