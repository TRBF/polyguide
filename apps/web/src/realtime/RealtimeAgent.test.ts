import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeAgent } from './RealtimeAgent';

/** An agent with a fake open event channel; returns the texts it asked the model to read aloud. */
function agent() {
  const sent: Record<string, unknown>[] = [];
  const a = new RealtimeAgent({ language: 'en', liveState: () => '[Live state]', runTool: async () => ({ output: {} }) });
  (a as unknown as { dc: unknown }).dc = { readyState: 'open', send: (s: string) => sent.push(JSON.parse(s)) };
  const spoken = () =>
    sent
      .filter((e) => e.type === 'response.create' && e.response)
      .map((e) => ((e.response as { input: { content: { text: string }[] }[] }).input[0].content[0].text));
  const done = () => (a as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'response.done', response: { status: 'completed', output: [], metadata: { kind: 'announce' } } });
  return { a, spoken, done };
}

afterEach(() => vi.useRealTimers());

describe('RealtimeAgent announcements', () => {
  it('speaks a heading nudge when the voice is idle', () => {
    const { a, spoken } = agent();
    a.announce('Turn left', { droppable: true });
    expect(spoken()).toEqual(['Turn left']);
  });

  it('skips a nudge while something is being said, instead of queueing it', () => {
    const { a, spoken, done } = agent();
    a.announce('Turn left, then go 20 metres.');
    a.announce('Turn right', { droppable: true });
    a.announce('Turn right', { droppable: true });
    done();
    expect(spoken()).toEqual(['Turn left, then go 20 metres.']);
  });

  it('an instruction removes a waiting nudge; queued instructions are read together', () => {
    const { a, spoken, done } = agent();
    a.announce('Starting.');
    // Simulate a nudge that slipped into the queue just before.
    (a as unknown as { queue: unknown[] }).queue.push({ kind: 'announce', text: 'Turn around', droppable: true, at: Date.now() });
    a.announce('Go 10 metres.');
    a.announce('Then the elevator.');
    done();
    expect(spoken()).toEqual(['Starting.', 'Go 10 metres. Then the elevator.']);
  });

  it('drops a stale nudge rather than reading it late', () => {
    vi.useFakeTimers();
    const { a, spoken, done } = agent();
    a.announce('Starting.');
    (a as unknown as { queue: unknown[] }).queue.push({ kind: 'announce', text: 'Turn around', droppable: true, at: Date.now() });
    vi.advanceTimersByTime(5000);
    done();
    expect(spoken()).toEqual(['Starting.']);
  });
});
