import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { mockRoutes } from './mock';

const PORT = Number(process.env.PORT ?? 8787);
const USE_MOCK = process.env.USE_MOCK === '1';

const app = new Hono();
app.use('*', logger());

if (USE_MOCK) {
  app.route('/api', mockRoutes);
} else {
  // Real routes land here (graph store, routing, localize). Until then, fall back to fixtures.
  // TODO(track-B): mount AI routes with app.route('/api', aiRoutes) from ./ai.
  app.route('/api', mockRoutes);
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PolyGuide server on http://localhost:${info.port} (mock=${USE_MOCK})`);
});
