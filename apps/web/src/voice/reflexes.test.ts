import { describe, expect, it } from 'vitest';
import { ReflexMemory, matchReflex } from './reflexes';

describe('matchReflex (whole utterances)', () => {
  it.each([
    ['Emergency!', 'emergency'], ['I fell', 'emergency'], ['Hilfe', 'emergency'],
    ['Wait', 'silence'], ['be quiet', 'silence'], ['shh', 'silence'],
    ['Stop.', 'stop'], ['stop navigation', 'stop'],
    ['next', 'next'], ["I'm there", 'next'], ['weiter', 'next'],
    ['back', 'back'], ['repeat', 'repeat'], ['Sorry?', 'repeat'],
    ['Yes', 'yes'], ["let's go", 'yes'], ['ja', 'yes'],
    ['No', 'no'], ['nein', 'no'],
  ])('"%s" → %s', (said, reflex) => {
    expect(matchReflex(said)).toBe(reflex);
  });

  it('leaves real requests to the AI', () => {
    expect(matchReflex('take me to the nearest toilet')).toBeNull();
    expect(matchReflex('help me find the toilet')).toBeNull();
    expect(matchReflex('stop at the elevator and wait for me there please')).toBeNull();
    expect(matchReflex('yes but take the stairs')).toBeNull();
  });
});

describe('matchReflex (mid-sentence)', () => {
  it('acts on unambiguous urgent words while the user is still talking', () => {
    expect(matchReflex('emergency', true)).toBe('emergency');
    expect(matchReflex('stop talking', true)).toBe('silence');
  });

  it('never acts on words that could still become a normal request', () => {
    expect(matchReflex('help me', true)).toBeNull(); // "help me find the toilet"
    expect(matchReflex('next', true)).toBeNull(); // "next to the elevator"
    expect(matchReflex('yes', true)).toBeNull(); // "yes but…"
    expect(matchReflex('stop', true)).toBeNull(); // "stop at…"
  });
});

describe('ReflexMemory', () => {
  it('suppresses the same action shortly after, not a different one or a later one', () => {
    const m = new ReflexMemory(4000);
    m.mark('next', 1000);
    expect(m.recently('next', 3000)).toBe(true);
    expect(m.recently('back', 3000)).toBe(false);
    expect(m.recently('next', 6000)).toBe(false);
  });
});
