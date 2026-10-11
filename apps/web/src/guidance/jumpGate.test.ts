import { describe, expect, it } from 'vitest';
import { JumpGate, metresBetween, type GateCurrent, type GatePoint } from './jumpGate';

// ~1 m in latitude ≈ 0.000009°
const here: GateCurrent = { lat: 47.3764, lon: 8.548, levelId: 'ETH.HG.F', confidence: 'medium' };
const at = (northM: number, levelId = 'ETH.HG.F', label = 'HG F 41'): GatePoint => ({ lat: here.lat + northM * 0.000009047, lon: here.lon, levelId, label });

describe('JumpGate', () => {
  it('lets one good reading nudge the estimate a little', () => {
    expect(new JumpGate().decide(at(12), 'sign', here)).toEqual({ action: 'accept', reason: 'small_move' });
  });

  it('holds a single reading that would jump far, and asks', () => {
    const d = new JumpGate().decide(at(40), 'sign', here);
    expect(d.action).toBe('hold');
    if (d.action === 'hold') {
      expect(d.question).toMatch(/Are you near HG F 41/);
      expect(d.jumpM).toBeGreaterThan(35);
    }
  });

  it('holds a floor change the camera alone claims', () => {
    const d = new JumpGate().decide(at(3, 'ETH.HG.E', 'HG E 41'), 'sign', here);
    expect(d.action).toBe('hold');
    if (d.action === 'hold') expect(d.question).toMatch(/floor E.*floor F/);
  });

  it('accepts the far jump once a second, independent reading agrees', () => {
    const gate = new JumpGate();
    expect(gate.decide(at(40), 'sign', here, [], 1000).action).toBe('hold');
    expect(gate.decide(at(44), 'where', here, [], 4000)).toEqual({ action: 'accept', reason: 'second_witness' });
  });

  it('the same frame twice is not a second witness', () => {
    const gate = new JumpGate();
    gate.decide(at(40), 'sign', here, [], 1000);
    expect(gate.decide(at(40), 'sign', here, [], 1200).action).toBe('hold');
  });

  it('a disagreeing second reading does not confirm the first', () => {
    const gate = new JumpGate();
    gate.decide(at(40), 'sign', here, [], 1000);
    expect(gate.decide(at(-45), 'sign', here, [], 5000).action).toBe('hold');
  });

  it('a floor the route itself is taking the user to is not suspicious', () => {
    expect(new JumpGate().decide(at(5, 'ETH.HG.G', 'HG G 5'), 'sign', here, ['ETH.HG.F', 'ETH.HG.G'])).toEqual({ action: 'accept', reason: 'route_floor' });
  });

  it('the user\'s word always passes', () => {
    expect(new JumpGate().decide(at(120, 'ETH.HG.E'), 'user', here)).toEqual({ action: 'accept', reason: 'user' });
  });

  it('with no estimate at all, the first reading is the estimate', () => {
    expect(new JumpGate().decide(at(200), 'sign', null).action).toBe('accept');
  });

  it('"yes" confirms the held reading; "no" forgets it', () => {
    const gate = new JumpGate();
    gate.decide(at(40), 'sign', here, [], 1000);
    expect(gate.confirm(2000)?.label).toBe('HG F 41');
    gate.decide(at(40), 'sign', here, [], 3000);
    gate.clear();
    expect(gate.confirm(4000)).toBeNull();
  });

  it('a held reading expires', () => {
    const gate = new JumpGate();
    gate.decide(at(40), 'sign', here, [], 0);
    expect(gate.confirm(120_000)).toBeNull();
  });

  it('measures metres sensibly', () => {
    expect(metresBetween(here, at(40))).toBeCloseTo(40, 0);
  });
});
