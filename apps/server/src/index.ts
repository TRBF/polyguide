import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { aiRoutes } from './ai';
import { loadGraph } from './graphStore';
import { mockRoutes } from './mock';
import { devRoutes } from './devCompare';
import { apiRoutes } from './routes';
import { rateLimit } from './rateLimit';
import { sameOriginApi, securityHeaders } from './security';
import { whereRoutes } from './where';

const PORT = Number(process.env.PORT ?? 8787);
// Loopback by default: in development the Vite proxy (and any tunnel) connects locally. Set HOST=0.0.0.0
// only to serve the built app straight to phones on the LAN.
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const USE_MOCK = process.env.USE_MOCK === '1';
/** SERVE_WEB=1 (`pnpm start:app`): also serve the built web app, so the whole app is one origin and one port. */
const WEB_DIST = path.resolve(process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url)));
const serveWeb = process.env.SERVE_WEB === '1' && fs.existsSync(path.join(WEB_DIST, 'index.html'));
if (process.env.SERVE_WEB === '1' && !serveWeb) console.warn(`SERVE_WEB=1 but ${WEB_DIST} has no index.html; run the web build first.`);

const app = new Hono();
app.use('*', logger());
app.use('*', securityHeaders());
// Floor plans are the only large responses; gzip them for phones.
app.use('/api/map/*', compress());
// Frames are ~150 KB; reject anything absurd before it reaches the OpenAI call.
app.use('/api/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ ok: false, reason: 'invalid_request', message: 'Request too large.' }, 413) }));
app.use('/api/*', sameOriginApi());
// Everything else (routes, search, maps) is cheap, but unlimited calls could still evict other users'
// routes from the in-memory store or tie up the CPU. A real user makes a few dozen calls a minute.
app.use('/api/*', rateLimit({
  perClient: Number(process.env.API_RATE_PER_MIN ?? 240),
  global: Number(process.env.API_RATE_GLOBAL_PER_MIN ?? 3000),
  body: (s) => ({ ok: false, reason: 'rate_limited', message: `Too many requests. Try again in ${s} seconds.` }),
}));

if (USE_MOCK) {
  app.route('/api', mockRoutes);
} else {
  loadGraph();
  app.route('/api', apiRoutes);
  // /dev/compare calls ETH at runtime; keep it off unless explicitly enabled (the app may sit behind a public tunnel).
  if (process.env.ENABLE_DEV_ROUTES === '1') app.route('/api', devRoutes);
  // Paid OpenAI calls: a walking user triggers vision every few seconds at most, so these budgets
  // leave room for real use while capping what a stranger with the tunnel URL can spend.
  app.use('/api/vision/*', rateLimit({
    perClient: Number(process.env.VISION_RATE_PER_MIN ?? 30),
    global: Number(process.env.VISION_RATE_GLOBAL_PER_MIN ?? 120),
    body: (s) => ({ ok: false, reason: 'rate_limited', message: `Too many camera checks. Try again in ${s} seconds.` }),
  }));
  app.use('/api/intent', rateLimit({
    perClient: Number(process.env.INTENT_RATE_PER_MIN ?? 30),
    global: Number(process.env.INTENT_RATE_GLOBAL_PER_MIN ?? 120),
    body: () => ({ type: 'unknown', source: 'llm' }),
  }));
  // One spoken command per request; a hands-free user says a few per minute.
  app.use('/api/stt', rateLimit({
    perClient: Number(process.env.STT_RATE_PER_MIN ?? 40),
    global: Number(process.env.STT_RATE_GLOBAL_PER_MIN ?? 150),
    body: (s) => ({ ok: false, reason: 'rate_limited', message: `Too many voice requests. Try again in ${s} seconds.` }),
  }));
  // The voice agent answers every sentence outside the instant commands: a few per minute per user.
  app.use('/api/agent', rateLimit({
    perClient: Number(process.env.AGENT_RATE_PER_MIN ?? 40),
    global: Number(process.env.AGENT_RATE_GLOBAL_PER_MIN ?? 150),
    body: (s) => ({ ok: false, reason: 'rate_limited', message: `Too many requests. Try again in ${s} seconds.` }),
  }));
  // "Where am I?": one camera call (plus an embedding) per question.
  app.use('/api/where', rateLimit({
    perClient: Number(process.env.WHERE_RATE_PER_MIN ?? 20),
    global: Number(process.env.WHERE_RATE_GLOBAL_PER_MIN ?? 100),
    body: (s) => ({ ok: false, reason: 'rate_limited', message: `Too many location checks. Try again in ${s} seconds.` }),
  }));
  // Survey captures (team only, token-locked): a person photographs a few spots a minute.
  app.use('/api/refs', rateLimit({
    perClient: 30,
    global: 60,
    body: (s) => ({ ok: false, reason: 'rate_limited', message: `Too many captures. Try again in ${s} seconds.` }),
  }));
  app.route('/api', aiRoutes);
  app.route('/api', whereRoutes);
}

app.all('/api/*', (c) => c.json({ ok: false, reason: 'not_found', message: 'Unknown API route.' }, 404));

if (serveWeb) {
  // Production: the built app from this same origin, so only this one port needs a tunnel.
  // Loaded only here: importing it eagerly hung the dev server's startup in some environments.
  const { serveStatic } = await import('@hono/node-server/serve-static');
  const root = path.relative(process.cwd(), WEB_DIST) || '.';
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root }));
  // Single-page app: any other path gets the app shell.
  app.get('*', serveStatic({ root, path: 'index.html' }));
} else {
  // The API has no UI of its own in development; point anyone who opens the port to the web app.
  app.get('/', (c) => c.text(`PolyGuide API is running (mock=${USE_MOCK}). Open the app at https://localhost:5173 — health check: /api/health`));
}

app.onError((err, c) => {
  console.error(err);
  // Never send internals (stack, file paths, SDK messages) to the client.
  return c.json({ ok: false, reason: 'server_error', message: 'Something went wrong on the server.' }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`PolyGuide server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${info.port} (mock=${USE_MOCK}${serveWeb ? ', serving the built app' : ''})`);
});
