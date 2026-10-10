import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';

const PORT = Number(process.env.PORT ?? 8787);
const USE_MOCK = process.env.USE_MOCK === '1';

const app = new Hono();
app.use('*', logger());

app.get('/api/health', (c) =>
  c.json({ ok: true, mock: USE_MOCK, graph: { nodes: 0, edges: 0, places: 0, dataSnapshotAt: null } }),
);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PolyGuide server on http://localhost:${info.port} (mock=${USE_MOCK})`);
});
