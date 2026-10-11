/**
 * Request hygiene for a server that may sit behind a public tunnel: security headers on every response,
 * and API calls only from the app itself (same origin, JSON or audio bodies).
 */
import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

/**
 * Headers for the API and the built app. The camera, mic and motion sensors are allowed for this origin
 * only; nothing may frame the app (a framed copy could trick a user into tapping Start or Emergency).
 */
export const securityHeaders = (): MiddlewareHandler => secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:', 'blob:'],
    mediaSrc: ["'self'", 'blob:', 'mediastream:'],
    // The browser posts its SDP offer directly to this exact endpoint using a short-lived Realtime secret.
    connectSrc: ["'self'", 'https://api.openai.com'],
    manifestSrc: ["'self'"],
    workerSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  permissionsPolicy: {
    camera: ['self'],
    microphone: ['self'],
    accelerometer: ['self'],
    gyroscope: ['self'],
    magnetometer: ['self'],
    geolocation: ['self'],
    screenWakeLock: ['self'],
    payment: [],
    usb: [],
  },
  referrerPolicy: 'no-referrer',
  crossOriginOpenerPolicy: 'same-origin',
  // Phones reach the app over a tunnel or a self-signed LAN certificate; HSTS belongs to a real domain.
  strictTransportSecurity: process.env.ENABLE_HSTS === '1' ? 'max-age=31536000; includeSubDomains' : false,
});

/**
 * Blocks cross-site use of the API. Browsers mark requests from other websites with Sec-Fetch-Site, and a
 * JSON content type cannot be sent cross-site without a CORS preflight (which this server never grants),
 * so a hostile page cannot spend the OpenAI budget through a visitor's browser.
 */
export const sameOriginApi = (): MiddlewareHandler => async (c, next) => {
  if (c.req.header('sec-fetch-site') === 'cross-site') {
    return c.json({ ok: false, reason: 'forbidden', message: 'Cross-site requests are not allowed.' }, 403);
  }
  if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    const audio = c.req.path === '/api/stt';
    if (audio ? !type.startsWith('audio/') : !type.startsWith('application/json')) {
      return c.json({ ok: false, reason: 'invalid_request', message: audio ? 'Send the audio as the request body.' : 'Send JSON.' }, 415);
    }
  }
  await next();
};
