/**
 * In-memory rate limits for the paid AI endpoints. The app can sit behind a public tunnel, so
 * every OpenAI-backed route gets a per-client budget plus a global ceiling (protects the key even
 * if many clients appear). Sliding one-minute window; resets on server restart, which is fine here.
 */
import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Requests per client per minute. */
  perClient: number;
  /** Requests across all clients per minute. */
  global: number;
  /** Body returned with 429 (shaped like the route's normal error response). */
  body: (retryAfterS: number) => unknown;
}

const WINDOW_MS = 60_000;

/** Behind ngrok + the Vite proxy the socket peer is always localhost; the tunnel sets X-Forwarded-For. */
function clientKey(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (fwd) return fwd;
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  let all: number[] = [];

  const prune = (list: number[], now: number) => {
    let i = 0;
    while (i < list.length && list[i] <= now - WINDOW_MS) i++;
    return i ? list.slice(i) : list;
  };

  return async (c, next) => {
    const now = Date.now();
    const key = clientKey(c);
    const mine = prune(hits.get(key) ?? [], now);
    all = prune(all, now);
    const blocked = mine.length >= opts.perClient ? mine : all.length >= opts.global ? all : null;
    if (blocked) {
      const retryAfterS = Math.max(1, Math.ceil((blocked[0] + WINDOW_MS - now) / 1000));
      hits.set(key, mine);
      c.header('Retry-After', String(retryAfterS));
      return c.json(opts.body(retryAfterS) as object, 429);
    }
    mine.push(now);
    all.push(now);
    hits.set(key, mine);
    // Keep the map from growing without bound under many distinct clients.
    if (hits.size > 5000) for (const [k, v] of hits) if (!prune(v, now).length) hits.delete(k);
    await next();
  };
}
