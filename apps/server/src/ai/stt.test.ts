import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './stt';

describe('cleanTranscript', () => {
  it('keeps real commands, tidied', () => {
    expect(cleanTranscript('  Take me to HG F 30. ')).toBe('Take me to HG F 30.');
    expect(cleanTranscript('Next.')).toBe('Next.');
  });

  it("drops Whisper's inventions on silence", () => {
    for (const text of ['', ' . ', 'Thank you.', 'Thanks for watching!', 'you', 'Subtitles by the Amara.org community', 'Vielen Dank.']) {
      expect(cleanTranscript(text)).toBe('');
    }
  });

  it('drops a recital of the vocabulary prompt (what Whisper returns for silence)', () => {
    expect(cleanTranscript('I am at HG E 41. Next. Where am I? What is ahead? Number 2. I am blind.')).toBe('');
    expect(cleanTranscript('Next. Repeat.')).toBe('');
    expect(cleanTranscript('Number 1. Number 2. Number 3. Number 4. Number 5.')).toBe('');
    expect(cleanTranscript('Okay. Take me to HG F 30.')).toBe('Okay. Take me to HG F 30.');
    // A single command that happens to match a prompt sentence is real.
    expect(cleanTranscript('Where am I?')).toBe('Where am I?');
  });
});
