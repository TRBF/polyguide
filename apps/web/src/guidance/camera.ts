/**
 * The app's single rear-camera stream (SPEC §5.5), shared by the vision loop and "Scan a room
 * sign" (../camera.ts delegates here). iOS mutes an older stream when a second one opens, so there
 * must be only one. Navigation holds it open; otherwise it closes after 20 s idle. It restarts
 * itself if the track was ended or muted.
 */

/** Short: a camera light that stays on after navigation feels like being watched. */
const IDLE_MS = 20_000;
/** First frames after play() are often black while auto-exposure settles. */
const WARMUP_MS = 350;

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let starting: Promise<MediaStream> | null = null;
let held = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const clearIdle = () => {
  if (idleTimer != null) clearTimeout(idleTimer);
  idleTimer = null;
};

/** Keep the camera open (navigation) or let it close when idle. */
export function holdCamera(on: boolean): void {
  held = on;
  clearIdle();
  if (!on && stream) idleTimer = setTimeout(stopCamera, IDLE_MS);
}

const live = () => {
  const track = stream?.getVideoTracks()[0];
  return !!track && track.readyState === 'live' && !track.muted && !!video && video.videoWidth > 0;
};

export function isCameraActive(): boolean {
  return live();
}

/** The live stream, e.g. for a small preview element. */
export function getCameraStream(): MediaStream | null {
  return live() ? stream : null;
}

export async function startCamera(): Promise<MediaStream> {
  if (live()) return stream!;
  if (starting) return starting;
  starting = (async () => {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is not available in this browser.');
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.srcObject = s;
    try {
      await v.play();
      if (!v.videoWidth) await new Promise<void>((r) => v.addEventListener('loadedmetadata', () => r(), { once: true }));
      await new Promise((r) => setTimeout(r, WARMUP_MS));
    } catch (error) {
      // Never leave a camera running that nothing can reach (the light would stay on).
      s.getTracks().forEach((t) => t.stop());
      throw error;
    }
    stream = s;
    video = v;
    // Navigation may have ended while the camera was starting: start the idle countdown now.
    if (!held) holdCamera(false);
    return s;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export function stopCamera(): void {
  clearIdle();
  stream?.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
  stream = null;
  video = null;
}

/**
 * Grab one frame as base64 JPEG (no data-URL prefix), longest side ≤ maxPx.
 * Starts the camera if needed; leaves it running for the next frame.
 */
export async function captureFrame(maxPx = 640, quality = 0.6): Promise<string> {
  await startCamera();
  if (!held) holdCamera(false); // restart the idle countdown
  const v = video!;
  const scale = Math.min(1, maxPx / Math.max(v.videoWidth, v.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(v.videoWidth * scale);
  canvas.height = Math.round(v.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the camera image.');
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
}
