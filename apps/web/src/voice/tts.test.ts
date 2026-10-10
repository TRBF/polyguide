import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeUtterance { text: string; rate: number; onend: (() => void) | null; onerror: (() => void) | null }

let spoken: FakeUtterance[];

async function loadTts() {
  vi.resetModules();
  return import('./tts');
}

beforeEach(() => {
  vi.useFakeTimers();
  spoken = [];
  const synth = {
    speaking: false,
    speak: (u: FakeUtterance) => spoken.push(u),
    cancel: () => undefined,
    getVoices: () => [],
    addEventListener: () => undefined,
  };
  vi.stubGlobal('window', { speechSynthesis: synth, setTimeout, clearTimeout });
  vi.stubGlobal('SpeechSynthesisUtterance', function (this: FakeUtterance, text: string) {
    this.text = text; this.rate = 1; this.onend = null; this.onerror = null;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('speech turn-taking with the mic', () => {
  it('reports speaking until the queue drains', async () => {
    const tts = await loadTts();
    const changes: boolean[] = [];
    tts.onSpeakingChange((speaking) => changes.push(speaking));
    tts.speak('one', 'info');
    tts.speak('two', 'info');
    expect(tts.isSpeaking()).toBe(true);
    spoken[0].onend?.();
    expect(tts.isSpeaking()).toBe(true);
    spoken[1].onend?.();
    expect(tts.isSpeaking()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('waits for the mic to release audio before speaking, without dropping queued speech', async () => {
    const tts = await loadTts();
    tts.setMicActive(true);
    tts.speak('first', 'info');
    tts.speak('second', 'info');
    expect(spoken).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(spoken.map((u) => u.text)).toEqual(['first']);
    tts.setMicActive(false);
    spoken[0].onend?.();
    expect(spoken.map((u) => u.text)).toEqual(['first', 'second']);
  });

  it('a watchdog ends speech whose onend never fires, so the mic comes back', async () => {
    const tts = await loadTts();
    tts.speak('Turn left.', 'instruction');
    vi.advanceTimersByTime(50);
    expect(tts.isSpeaking()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(tts.isSpeaking()).toBe(false);
  });

  it('stopSpeech releases the mic', async () => {
    const tts = await loadTts();
    tts.speak('hello', 'info');
    tts.stopSpeech();
    expect(tts.isSpeaking()).toBe(false);
  });
});
