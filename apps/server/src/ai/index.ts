/** Track B's server routes. Mounted by apps/server/src/index.ts via app.route('/api', aiRoutes). */
import { Hono } from 'hono';
import { intentRoutes } from './intent';
import { sttRoutes } from './stt';
import { visionRoutes } from './vision';

export const aiRoutes = new Hono();
aiRoutes.route('/', visionRoutes);
aiRoutes.route('/', intentRoutes);
aiRoutes.route('/', sttRoutes);
