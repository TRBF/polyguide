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

const PORT = Number(process.env.PORT ?? 8787);
const USE_MOCK = process.env.USE_MOCK === '1';

const app = new Hono();
app.use('*', logger());
// Floor plans are the only large responses; gzip them for phones.
app.use('/api/map/*', compress());
// Frames are ~150 KB; reject anything absurd before it reaches the OpenAI call.
app.use('/api/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ ok: false, reason: 'invalid_request', message: 'Request too large.' }, 413) }));

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
  app.route('/api', aiRoutes);
}

// The API has no UI; point anyone who opens the port in a browser to the web app.
app.get('/', (c) => c.text(`PolyGuide API is running (mock=${USE_MOCK}). Open the app at https://localhost:5173 — health check: /api/health`));

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, reason: 'server_error', message: err.message }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PolyGuide server on http://localhost:${info.port} (mock=${USE_MOCK})`);
});
