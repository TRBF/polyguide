import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for camera, sensors, mic and wake lock (SPEC §3).
// /api is proxied to the Hono server so the app runs on one origin.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
    // Tunnel hostnames (cloudflared/ngrok) are otherwise rejected by Vite's host check.
    allowedHosts: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
