import { describe, expect, it } from 'vitest';
import type { VisionRequest, VisionResponse, VisionResult } from '@polyguide/shared';
import { mockRouteWheelchair as route } from '@polyguide/shared/src/fixtures';
import { VisionController, decideVision, isNearDuplicate, sameRoom } from './vision';

const base: VisionResult = {
  sceneSummary: 'A corridor.',
  readText: [],
  detectedRoomNames: [],
  seen: [],
  atExpectedPoint: false,
  offRouteSuspected: false,
  notableThings: [],
  utterance: '',
  confidence: 0.8,
  latencyMs: 100,
};

describe('fusion', () => {
  it('matches room names with or without the building prefix', () => {
    expect(sameRoom('F 33', 'HG F 33')).toBe(true);
    expect(sameRoom('hg f33', 'HG F 33')).toBe(true);
    expect(sameRoom('F 3', 'HG F 33')).toBe(false);
  });

  it('advances only when confident', () => {
    expect(decideVision({ ...base, atExpectedPoint: true }, { route, lastUtterance: '', trigger: 'approaching_node' }).advance).toBe(true);
    expect(decideVision({ ...base, atExpectedPoint: true, confidence: 0.5 }, { route, lastUtterance: '', trigger: 'approaching_node' }).advance).toBe(false);
  });

  it('flags off-route only for a room not on the route', () => {
    const ctx = { route, lastUtterance: '', trigger: 'periodic' as const };
    expect(decideVision({ ...base, offRouteSuspected: true, detectedRoomNames: ['HG G 5'] }, ctx).offRouteRoom).toBe('HG G 5');
    expect(decideVision({ ...base, offRouteSuspected: true, detectedRoomNames: ['F 33'] }, ctx).offRouteRoom).toBeNull();
    expect(decideVision({ ...base, offRouteSuspected: false, detectedRoomNames: ['HG G 5'] }, ctx).offRouteRoom).toBeNull();
  });

  it('speaks confident, non-duplicate utterances; user questions always get an answer', () => {
    const u = 'Elevator doors ahead, slightly right.';
    expect(decideVision({ ...base, utterance: u }, { route, lastUtterance: '', trigger: 'periodic' }).speak).toBe(u);
    expect(decideVision({ ...base, utterance: u }, { route, lastUtterance: 'Elevator doors ahead slightly to the right', trigger: 'periodic' }).speak).toBeNull();
    expect(decideVision({ ...base, utterance: u }, { route, lastUtterance: u, trigger: 'user_query' }).speak).toBe(u);
    expect(decideVision({ ...base, utterance: u, confidence: 0.4 }, { route, lastUtterance: '', trigger: 'user_query' }).speak).toBeNull();
  });

  it('near-duplicate uses token overlap', () => {
    expect(isNearDuplicate('Room F 33 on your right', 'room F 33 on the right')).toBe(true);
    expect(isNearDuplicate('Stairs ahead', 'Elevator on your left')).toBe(false);
  });
});

describe('VisionController', () => {
  function setup() {
    const sent: VisionRequest[] = [];
    const results: string[] = [];
    let release: (() => void)[] = [];
    const c = new VisionController({
      capture: async (px) => `img${px}`,
      send: (req) =>
        new Promise<VisionResponse>((resolve) => {
          sent.push(req);
          release.push(() => resolve({ ok: true, ...base }));
        }),
      context: (trigger, question) => ({ trigger, needs: [], userQuestion: question }),
      onBusy: () => undefined,
      onResult: (_res, req) => results.push(req.trigger),
    });
    const flush = async () => {
      await new Promise((r) => setTimeout(r, 0));
      const r = release;
      release = [];
      r.forEach((f) => f());
      await new Promise((r) => setTimeout(r, 0));
    };
    return { c, sent, results, flush };
  }

  it('keeps one request in flight, drops automatic triggers, queues one user_query', async () => {
    const { c, sent, results, flush } = setup();
    expect(c.trigger('approaching_node')).toBe(true);
    expect(c.trigger('periodic')).toBe(false);
    expect(c.trigger('user_query', 'first')).toBe(true);
    expect(c.trigger('user_query', 'second')).toBe(true);
    await flush();
    expect(results).toEqual(['approaching_node']);
    await flush();
    expect(results).toEqual(['approaching_node', 'user_query']);
    expect(sent.map((s) => s.userQuestion)).toEqual([undefined, 'second']);
  });

  it('uses 1024 px frames for localize, 640 otherwise', async () => {
    const { c, sent, flush } = setup();
    c.trigger('localize');
    await flush();
    c.trigger('periodic');
    await flush();
    expect(sent.map((s) => s.imageJpegBase64)).toEqual(['img1024', 'img640']);
  });
});
