import { describe, expect, it } from 'vitest';
import { regexIntent } from './intent';
import { buildVisionUserText, postProcessVision, sanitizeUtterance } from './visionPrompt';

describe('sanitizeUtterance', () => {
  it('drops sentences that claim safety', () => {
    expect(sanitizeUtterance('The path is clear. Elevator ahead on the right.')).toBe('Elevator ahead on the right.');
    expect(sanitizeUtterance('It is safe to walk forward.')).toBe('');
    expect(sanitizeUtterance('No obstacles. Door at 2 o\'clock.')).toBe("Door at 2 o'clock.");
    expect(sanitizeUtterance('Room F 33 is clearly visible on your left.')).toBe('Room F 33 is clearly visible on your left.');
  });
  it('caps to 15 words', () => {
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(sanitizeUtterance(long).split(' ')).toHaveLength(15);
  });
});

describe('postProcessVision', () => {
  it('blanks the utterance when unsure and clamps confidence', () => {
    const r = postProcessVision({ utterance: 'Maybe stairs.', confidence: 0.3, detectedRoomNames: ['HG F 33', ''], seen: [{ label: 'x', relativeDirection: 'up' }] }, 1234);
    expect(r.utterance).toBe('');
    expect(r.detectedRoomNames).toEqual(['HG F 33']);
    expect(r.seen[0].relativeDirection).toBe('unknown');
    expect(r.latencyMs).toBe(1234);
    expect(postProcessVision({ confidence: 7 }, 0).confidence).toBe(1);
  });
  it('survives garbage', () => {
    expect(postProcessVision(null, 5)).toMatchObject({ utterance: '', confidence: 0, atExpectedPoint: false });
  });
});

describe('buildVisionUserText', () => {
  it('includes step, landmarks, heading and question', () => {
    const text = buildVisionUserText({
      imageJpegBase64: '',
      trigger: 'approaching_node',
      needs: ['blind'],
      headingDeltaDeg: -70,
      userQuestion: 'Where am I?',
      step: { text: 'Turn right to the elevator', maneuver: 'right', levelId: 'ETH.HG.E', distanceM: 24, expectedLandmarks: [{ label: 'elevator', kind: 'elevator', side: 'ahead', atDistanceM: 24 }] },
    });
    expect(text).toContain('Turn right to the elevator');
    expect(text).toContain('elevator (elevator, ahead, at 24 m)');
    expect(text).toContain("to the user's left");
    expect(text).toContain('User question: Where am I?');
  });
});

describe('regexIntent', () => {
  it.each([
    ['take me to HG F 30', { type: 'navigate_to', target: 'HG F 30' }],
    ["I'm next to the main staircase", { type: 'set_location', target: 'main staircase' }],
    ['go back', { type: 'back' }],
    ['say that again', { type: 'repeat' }],
    ['the second one', { type: 'choose_option', option: 2 }],
    ['number 3', { type: 'choose_option', option: 3 }],
    ["I'm lost", { type: 'where_am_i' }],
    ['what can you see', { type: 'whats_ahead' }],
  ])('%s', (u, expected) => {
    expect(regexIntent(u)).toMatchObject({ ...expected, source: 'regex' });
  });
  it('leaves open phrasing to the model', () => {
    expect(regexIntent('nearest accessible toilet')).toBeNull();
  });
});

describe('hardening', () => {
  it('does not treat chatter as a command', async () => {
    const { regexIntent } = await import('./intent');
    expect(regexIntent('stop by the office tomorrow')).toBeNull();
    expect(regexIntent('back to the lecture notes')).toBeNull();
    expect(regexIntent('stop')?.type).toBe('stop');
    expect(regexIntent("I’m at HG E 41")?.type).toBe('set_location');
  });
  it('strips German safety claims', async () => {
    const { sanitizeUtterance } = await import('./visionPrompt');
    expect(sanitizeUtterance('Der Weg ist frei. Raum F 33 links.')).toBe('Raum F 33 links.');
    expect(sanitizeUtterance('Der Gang ist sicher.')).toBe('');
  });
});
