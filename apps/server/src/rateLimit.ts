/**
 * In-memory rate limits. The app can sit behind a public tunnel, so every OpenAI-backed route gets a
 * per-client budget plus a global ceiling (protects the key even if many clients appear), and the whole
 * API gets a looser one. Sliding one-minute window; resets on server restart, which is fine here.
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
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Who is asking. Forwarding headers are only trusted when the socket peer is this machine (a tunnel or the
 * Vite proxy); otherwise anyone could rotate a made-up X-Forwarded-For to dodge the per-client limit.
 * Each proxy appends the address it saw, so reading from the right and skipping local hops (tunnel agent →
 * Vite proxy) gives the address the outermost trusted proxy wrote; anything a client wrote sits further left.
 */
export function clientKey(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress ?? 'unknown';
  // TRUST_PROXY=1: deployed behind the VIScon reverse proxy (via Docker), so every request arrives from the proxy.
  // It authenticates users and sets X-User-Id, which is then the user; else the address it appended last.
  // Only safe while the app is reachable through that proxy alone (no open firewall port, login enabled).
  if (process.env.TRUST_PROXY === '1') {
    const user = c.req.header('x-user-id')?.trim();
    if (user) return `user:${user.toLowerCase()}`;
    const last = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    return last ?? peer;
  }
  if (!LOOPBACK.test(peer)) return peer;
  // (Not CF-Connecting-IP: behind ngrok a client could set it freely. cloudflared also appends X-Forwarded-For.)
  const hops = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  return hops.reverse().find((ip) => !LOOPBACK.test(ip)) ?? peer;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  let all: number[] = [];

  const prune = (list: number[], now: number) => {
    let i = 0;
    while (i < list.length && list[i] <= now - WINDOW_MS) i++;
    return i ? list.slice(i) : list;
  };

  // Drop idle clients regularly so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      const kept = prune(v, now);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, WINDOW_MS);
  sweep.unref?.();

  return async (c, next) => {
    const now = Date.now();
    const key = clientKey(c);
    const mine = prune(hits.get(key) ?? [], now);
    all = prune(all, now);
    const blocked = mine.length >= opts.perClient ? mine : all.length >= opts.global ? all : null;
    if (blocked) {
      const retryAfterS = Math.max(1, Math.ceil((blocked[0] + WINDOW_MS - now) / 1000));
      if (mine.length) hits.set(key, mine);
      c.header('Retry-After', String(retryAfterS));
      return c.json(opts.body(retryAfterS) as object, 429);
    }
    mine.push(now);
    all.push(now);
    hits.set(key, mine);
    await next();
  };
}
