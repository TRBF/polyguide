import { describe, expect, it } from 'vitest';
import type { Intent } from '@polyguide/shared';
import { answerForScreen, parseAppCommand, parseCommand } from './commands';

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

describe('local fallback (works without the AI model)', () => {
  const nav = (said: string) => parseCommand(said);
  it('understands natural ways of asking for a place', () => {
    expect(nav('Where is the Audimax?')).toMatchObject({ type: 'navigate_to', target: 'audimax' });
    expect(nav('I want to go to F 30 please')).toMatchObject({ type: 'navigate_to', target: 'f 30' });
    expect(nav('how do I get to the library')).toMatchObject({ type: 'navigate_to', target: 'library' });
    expect(nav('find HG E 41')).toMatchObject({ type: 'navigate_to', target: 'hg e 41' });
  });
  it('maps needs to the nearest place', () => {
    expect(nav('I need the toilet')).toMatchObject({ type: 'navigate_to', target: 'nearest toilet' });
    expect(nav('bathroom')).toMatchObject({ type: 'navigate_to', target: 'nearest toilet' });
    expect(nav('way out')).toMatchObject({ type: 'navigate_to', target: 'nearest exit' });
    expect(nav('the nearest lift')).toMatchObject({ type: 'navigate_to', target: 'nearest elevator' });
  });
  it('still answers "where am I" as a question, not a destination', () => {
    expect(nav('where am I')).toMatchObject({ type: 'where_am_i' });
  });
  it('accepts bare option numbers', () => {
    expect(nav('two')).toMatchObject({ type: 'choose_option', option: 2 });
    expect(nav('3')).toMatchObject({ type: 'choose_option', option: 3 });
    expect(nav('the second one')).toMatchObject({ type: 'choose_option', option: 2 });
    expect(nav('number 1')).toMatchObject({ type: 'choose_option', option: 1 });
  });
});

describe('parseAppCommand', () => {
  it('recognises emergencies', () => {
    expect(parseAppCommand('Emergency!')).toEqual({ type: 'emergency' });
    expect(parseAppCommand('call an ambulance')).toEqual({ type: 'emergency' });
    expect(parseAppCommand('I fell')).toEqual({ type: 'emergency' });
  });
  it('recognises a broken elevator in many phrasings', () => {
    for (const said of ['the elevator is not working', 'lift broken', 'elevator out of order', 'this elevator does not work', 'no elevator']) {
      expect(parseAppCommand(said)).toEqual({ type: 'elevator_broken' });
    }
  });
  it('does not treat ordinary commands as app commands', () => {
    for (const said of ['next', 'take me to the elevator', 'help', 'where am i']) expect(parseAppCommand(said)).toBeNull();
  });
  it('yes / no / slower', () => {
    expect(parseAppCommand('yes please')).toEqual({ type: 'yes' });
    expect(parseAppCommand('no thanks')).toEqual({ type: 'no' });
    expect(parseAppCommand('too fast')).toEqual({ type: 'repeat_slower' });
  });
});
