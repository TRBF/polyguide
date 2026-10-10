/**
 * Client side of the vision loop (SPEC §5.5): single-flight request controller and the fusion
 * rules that turn a VisionResult into tracker input and speech. AI only confirms or corrects;
 * nothing here blocks guidance.
 */
import type { RouteResult, VisionRequest, VisionResponse, VisionResult, VisionTrigger } from '@polyguide/shared';

type Route = Extract<RouteResult, { ok: true }>;

export const VISION_CONFIDENCE = 0.6;
export const FRAME_PX = 640;
export const LOCALIZE_FRAME_PX = 1024;

/* ───────────── Fusion (pure) ───────────── */

/** "HG F 33" / "hg f33" / "F 33." → "HGF33" (same rule as the server's normRoom). */
export const normRoom = (s: string) => s.toUpperCase().replace(/[\s.\-_,]+/g, '');

/** Signs often omit the building prefix: "F 33" matches "HG F 33". */
export function sameRoom(a: string, b: string): boolean {
  const x = normRoom(a);
  const y = normRoom(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 3 && /\d/.test(short) && long.endsWith(short);
}

/** Every room label the route expects to pass, plus origin and destination. */
export function routeRoomLabels(route: Route | null): string[] {
  if (!route) return [];
  const labels = route.steps.flatMap((s) => s.expectedLandmarks.filter((l) => l.kind === 'room_sign').map((l) => l.label));
  return [...labels, route.to.name, route.from.name];
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));

/** Token Jaccard ≥ 0.6 counts as "the same thing said again". */
export function isNearDuplicate(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter) >= 0.6;
}

export interface VisionDecision {
  /** Tracker may advance the step. */
  advance: boolean;
  /** A recognised room that is not on this route → reroute from it. */
  offRouteRoom: string | null;
  /** Utterance to speak, if any. */
  speak: string | null;
}

export function decideVision(result: VisionResult, ctx: { route: Route | null; lastUtterance: string; trigger: VisionTrigger }): VisionDecision {
  const confident = result.confidence >= VISION_CONFIDENCE;
  const advance = result.atExpectedPoint && confident;

  let offRouteRoom: string | null = null;
  if (result.offRouteSuspected && ctx.route) {
    const onRoute = routeRoomLabels(ctx.route);
    offRouteRoom = result.detectedRoomNames.find((n) => !onRoute.some((l) => sameRoom(n, l))) ?? null;
  }

  const u = result.utterance.trim();
  const fresh = ctx.trigger === 'user_query' || !isNearDuplicate(u, ctx.lastUtterance);
  return { advance, offRouteRoom, speak: confident && u && fresh ? u : null };
}

/* ───────────── Single-flight controller ───────────── */

export type VisionRequestBody = Omit<VisionRequest, 'imageJpegBase64'>;

export interface VisionDeps {
  capture(maxPx: number): Promise<string>;
  send(req: VisionRequest): Promise<VisionResponse>;
  /** Fresh context at send time (queued requests use the latest step). null = skip. */
  context(trigger: VisionTrigger, question?: string): VisionRequestBody | null;
  onBusy(busy: boolean): void;
  onResult(res: VisionResponse, req: VisionRequestBody): void;
}

/**
 * Never more than one request in flight. New triggers are dropped while busy, except
 * user_query, which queues exactly one (the latest question wins).
 */
export class VisionController {
  private busy = false;
  private queued: { trigger: VisionTrigger; question?: string } | null = null;
  private disposed = false;

  constructor(private deps: VisionDeps) {}

  get isBusy() {
    return this.busy;
  }

  /** Returns false when the trigger was dropped. */
  trigger(trigger: VisionTrigger, question?: string): boolean {
    if (this.disposed) return false;
    if (this.busy) {
      if (trigger !== 'user_query') return false;
      this.queued = { trigger, question };
      return true;
    }
    void this.run(trigger, question);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.queued = null;
  }

  private async run(trigger: VisionTrigger, question?: string): Promise<void> {
    const body = this.deps.context(trigger, question);
    if (!body) return;
    this.busy = true;
    this.deps.onBusy(true);
    let res: VisionResponse;
    try {
      const imageJpegBase64 = await this.deps.capture(trigger === 'localize' ? LOCALIZE_FRAME_PX : FRAME_PX);
      res = await this.deps.send({ ...body, imageJpegBase64 });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'AbortError';
      res = { ok: false, reason: timeout ? 'timeout' : 'model_error', message: err instanceof Error ? err.message : 'Camera check failed.' };
    }
    this.busy = false;
    if (this.disposed) return;
    this.deps.onBusy(false);
    this.deps.onResult(res, body);
    const next = this.queued;
    this.queued = null;
    if (next) void this.run(next.trigger, next.question);
  }
}
