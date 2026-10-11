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
  return { a, spoken, done, sent };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RealtimeAgent connection fallback', () => {
  it('times out a microphone prompt that never resolves and reports an error for fallback', async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('document', { createElement: () => ({ autoplay: false, setAttribute: vi.fn(), srcObject: null }) });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, clientSecret: 'ephemeral', model: 'test', expiresAt: 1 }),
    }));
    const a = new RealtimeAgent({ language: 'en', liveState: () => '[Live state]', runTool: async () => ({ output: {} }), onStatus });

    const connecting = a.connect();
    const rejection = expect(connecting).rejects.toThrow('Voice setup timed out');
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(a.connected).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith('error');
  });
});

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

  it('an urgent instruction cuts off what is being said and replaces older queued ones', () => {
    const { a, spoken, done, sent } = agent();
    a.announce('Go 30 metres along the corridor.');
    a.announce('Old instruction.');
    a.announce('Turn left now.', { urgent: true });
    expect(sent.some((e) => e.type === 'response.cancel')).toBe(true);
    expect(sent.some((e) => e.type === 'output_audio_buffer.clear')).toBe(true);
    // The cancelled response ends; only the new instruction follows.
    (a as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'response.done', response: { status: 'cancelled', output: [], metadata: { kind: 'announce' } } });
    expect(spoken()).toEqual(['Go 30 metres along the corridor.', 'Turn left now.']);
    done();
  });

  it('an urgent instruction also stops audio still playing after the model finished', () => {
    const { a, sent } = agent();
    const ev = (e: unknown) => (a as unknown as { onEvent(e: unknown): void }).onEvent(e);
    ev({ type: 'output_audio_buffer.started' });
    a.announce('Turn right now.', { urgent: true });
    expect(sent.some((e) => e.type === 'output_audio_buffer.clear')).toBe(true);
    expect(sent.some((e) => e.type === 'response.cancel')).toBe(false);
  });

  it('a nudge is not spoken over audio that is still playing', () => {
    const { a, spoken } = agent();
    (a as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'output_audio_buffer.started' });
    a.announce('Turn left', { droppable: true });
    expect(spoken()).toEqual([]);
  });

  it('never cuts into a tool call in progress', () => {
    const { a, sent } = agent();
    (a as unknown as { toolsRunning: boolean; responseActive: boolean }).toolsRunning = true;
    (a as unknown as { responseActive: boolean }).responseActive = true;
    a.announce('Turn left now.', { urgent: true });
    expect(sent.some((e) => e.type === 'response.cancel')).toBe(false);
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
