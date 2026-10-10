import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { loadGraph } from './graphStore';
import { mockAiRoutes, mockRoutes } from './mock';
import { devRoutes } from './devCompare';
import { apiRoutes } from './routes';

const PORT = Number(process.env.PORT ?? 8787);
const USE_MOCK = process.env.USE_MOCK === '1';

const app = new Hono();
app.use('*', logger());

if (USE_MOCK) {
  app.route('/api', mockRoutes);
} else {
  loadGraph();
  app.route('/api', apiRoutes);
  app.route('/api', devRoutes);
  // TODO(track-B): replace with app.route('/api', aiRoutes) from ./ai once it lands.
  app.route('/api', mockAiRoutes);
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, reason: 'server_error', message: err.message }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PolyGuide server on http://localhost:${info.port} (mock=${USE_MOCK})`);
});
