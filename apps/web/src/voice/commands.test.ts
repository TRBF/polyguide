import { describe, expect, it } from 'vitest';
import type { Intent } from '@polyguide/shared';
import { answerForScreen, parseCommand } from './commands';

const llm = (type: Intent['type'], target: string): Intent => ({ type, target, source: 'llm' });

describe('answerForScreen', () => {
  it('a bare room on "Where are you?" is where the user is, without asking the server', () => {
    expect(answerForScreen('where', 'k30', parseCommand('k30'))).toEqual({ type: 'set_location', target: 'k30', source: 'regex' });
    expect(answerForScreen('where', 'HG E 41', null)).toMatchObject({ type: 'set_location', target: 'HG E 41' });
  });

  it('the model reading a bare place as a destination is corrected on "Where are you?"', () => {
    expect(answerForScreen('where', 'the audimax', llm('navigate_to', 'Audimax'))).toMatchObject({ type: 'set_location', target: 'Audimax' });
  });

  it('an explicit "take me to" on "Where are you?" stays a destination', () => {
    const said = 'take me to hg f 30';
    expect(answerForScreen('where', said, parseCommand(said))).toMatchObject({ type: 'navigate_to', target: 'hg f 30' });
    expect(answerForScreen('where', 'I want to go to the Audimax', llm('navigate_to', 'Audimax'))).toMatchObject({ type: 'navigate_to' });
  });

  it('a bare place on "Where to?" is the destination; "I\'m at" keeps its meaning', () => {
    expect(answerForScreen('destination', 'f30', null)).toMatchObject({ type: 'navigate_to', target: 'f30' });
    expect(answerForScreen('destination', 'audimax', llm('set_location', 'Audimax'))).toMatchObject({ type: 'navigate_to' });
    const said = "i'm at hg e 41";
    expect(answerForScreen('destination', said, parseCommand(said))).toMatchObject({ type: 'set_location' });
  });

  it('a short reply the model could not place is searched as a place', () => {
    const unknown: Intent = { type: 'unknown', source: 'llm' };
    expect(answerForScreen('destination', 'the audimax', unknown)).toMatchObject({ type: 'navigate_to', target: 'audimax' });
    expect(answerForScreen('where', 'main entrance', unknown)).toMatchObject({ type: 'set_location', target: 'main entrance' });
    expect(answerForScreen('where', 'I have no idea what is going on here', unknown)).toEqual(unknown);
  });

  it('leaves tools, numbered choices, chatter and other screens alone', () => {
    expect(answerForScreen('destination', 'scan sign', parseCommand('scan sign'))).toMatchObject({ type: 'set_location', target: 'scan sign' });
    expect(answerForScreen('where', 'number 2', parseCommand('number 2'))).toMatchObject({ type: 'choose_option', option: 2 });
    expect(answerForScreen('where', 'hello there', null)).toBeNull();
    expect(answerForScreen('navigate', 'k30', null)).toBeNull();
  });
});
