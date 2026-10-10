import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera, sensors, mic and wake lock on phones (SPEC §3).
// `pnpm dev:http` serves plain HTTP on :5174 for desktop testing: localhost is already a secure
// context, and browsers without the self-signed cert exception (e.g. embedded previews) can load it.
const plainHttp = process.env.npm_lifecycle_event === 'dev:http';

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
    // Tunnel hostnames (cloudflared/ngrok) are otherwise rejected by Vite's host check.
    allowedHosts: true,
    // API_PORT lets a second checkout (e.g. a worktree) run its own server next to the main one.
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` },
  },
});
