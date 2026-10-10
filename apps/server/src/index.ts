import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { aiRoutes } from './ai';
import { loadGraph } from './graphStore';
import { mockRoutes } from './mock';
import { devRoutes } from './devCompare';
import { apiRoutes } from './routes';

const PORT = Number(process.env.PORT ?? 8787);
const USE_MOCK = process.env.USE_MOCK === '1';

const app = new Hono();
app.use('*', logger());
// Frames are ~150 KB; reject anything absurd before it reaches the OpenAI call.
app.use('/api/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ ok: false, reason: 'invalid_request', message: 'Request too large.' }, 413) }));

if (USE_MOCK) {
  app.route('/api', mockRoutes);
} else {
  loadGraph();
  app.route('/api', apiRoutes);
  // /dev/compare calls ETH at runtime; keep it off unless explicitly enabled (the app may sit behind a public tunnel).
  if (process.env.ENABLE_DEV_ROUTES === '1') app.route('/api', devRoutes);
  app.route('/api', aiRoutes);
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, reason: 'server_error', message: err.message }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PolyGuide server on http://localhost:${info.port} (mock=${USE_MOCK})`);
});
