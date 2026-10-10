import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera, sensors, mic and wake lock on phones (SPEC §3).
// `pnpm dev:http` serves plain HTTP on :5174 for desktop testing: localhost is already a secure
// context, and browsers without the self-signed cert exception (e.g. embedded previews) can load it.
const plainHttp = process.env.npm_lifecycle_event === 'dev:http';

// Tunnel hostnames are allowed by suffix only: `allowedHosts: true` would switch off Vite's DNS-rebinding
// protection. Add another with VITE_ALLOWED_HOSTS=.example.org (comma-separated).
const allowedHosts = [
  '.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.trycloudflare.com', '.loca.lt',
  ...(process.env.VITE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
];

// /api is proxied to the Hono server so the app runs on one origin.
// The shared and routing packages live outside this root, and Vite does not reliably watch them: after a
// merge it kept serving the old @polyguide/shared (API.realtimeSession was undefined on phones). Watch them.
const watchWorkspacePackages: Plugin = {
  name: 'watch-workspace-packages',
  configureServer(server) {
    server.watcher.add(fileURLToPath(new URL('../../packages', import.meta.url)));
  },
};

export default defineConfig({
  plugins: plainHttp ? [react(), watchWorkspacePackages] : [react(), basicSsl(), watchWorkspacePackages],
  server: {
    host: true,
    port: plainHttp ? 5174 : 5173,
    allowedHosts,
    // The dev server may be reachable from a phone or a tunnel: serve only the app, the shared package and
    // dependencies, never the rest of the monorepo (apps/server/.env holds the OpenAI key).
    fs: { strict: true, allow: ['.', '../../packages/shared', '../../packages/routing', '../../node_modules'] },
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
    },
    // API_PORT lets a second checkout (e.g. a worktree) run its own server next to the main one.
    // xfwd: the API sees each phone's address (for per-client rate limits) instead of only this proxy's.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}`, xfwd: true } },
  },
  preview: { allowedHosts },
});
