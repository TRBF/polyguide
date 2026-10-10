import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera, sensors, mic and wake lock on phones (SPEC §3).
// `pnpm dev:http` serves plain HTTP on :5174 for desktop testing: localhost is already a secure
// context, and browsers without the self-signed cert exception (e.g. embedded previews) can load it.
const plainHttp = process.env.npm_lifecycle_event === 'dev:http';

// /api is proxied to the Hono server so the app runs on one origin.
export default defineConfig({
  plugins: plainHttp ? [react()] : [react(), basicSsl()],
  server: {
    host: true,
    port: plainHttp ? 5174 : 5173,
    // Tunnel hostnames (cloudflared/ngrok) are otherwise rejected by Vite's host check.
    allowedHosts: true,
    // API_PORT lets a second checkout (e.g. a worktree) run its own server next to the main one.
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` },
  },
});
