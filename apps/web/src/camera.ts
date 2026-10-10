import { requestSensorPermissions } from './sensorPermissions';

/** One camera stream is reused between checks (avoids repeated iOS prompts and cold-start latency), then released when idle. */
const CAMERA_IDLE_MS = 45_000;
let cameraStream: MediaStream | null = null;
let cameraVideo: HTMLVideoElement | null = null;
let cameraIdleTimer: number | null = null;

export function releaseCamera(): void {
  if (cameraIdleTimer !== null) window.clearTimeout(cameraIdleTimer);
  cameraIdleTimer = null;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraVideo = null;
}

async function openCamera(): Promise<HTMLVideoElement> {
  if (cameraStream && cameraVideo && cameraStream.getVideoTracks().some((t) => t.readyState === 'live')) return cameraVideo;
  releaseCamera();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth || !video.videoHeight) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  }
  // The first frames after play() can be black/auto-exposing; give the sensor a moment.
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  cameraStream = stream;
  cameraVideo = video;
  return video;
}

export async function captureRoomSignFrame(maxSide = 1024): Promise<string> {
  const video = await openCamera();
  if (cameraIdleTimer !== null) window.clearTimeout(cameraIdleTimer);
  cameraIdleTimer = window.setTimeout(releaseCamera, CAMERA_IDLE_MS);
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare the camera image.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6).split(',')[1] ?? '';
}

let screenWakeLock: WakeLockSentinel | null = null;
let wantWakeLock = false;

// The browser drops the lock whenever the page is hidden; take it back when the user returns.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantWakeLock && !screenWakeLock) void requestScreenWakeLock();
  });
}

export async function requestScreenWakeLock(): Promise<boolean> {
  wantWakeLock = true;
  try {
    if (!('wakeLock' in navigator) || !navigator.wakeLock) return false;
    screenWakeLock = await navigator.wakeLock.request('screen');
    screenWakeLock.addEventListener('release', () => { screenWakeLock = null; }, { once: true });
    return true;
  } catch {
    return false;
  }
}

export function releaseScreenWakeLock(): void {
  wantWakeLock = false;
  const active = screenWakeLock;
  screenWakeLock = null;
  if (active) void active.release().catch(() => undefined);
}

export async function requestAppPermissions(): Promise<string[]> {
  const granted: string[] = [];
  try {
    // Called first and synchronously from the click: iOS only honours it while the gesture is fresh.
    granted.push(...(await requestSensorPermissions()));
  } catch {
    // Sensor permissions are best effort; other controls remain usable.
  }
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Media permissions are not supported.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: { ideal: 'environment' } },
    });
    stream.getTracks().forEach((track) => track.stop());
    granted.push('camera', 'microphone');
  } catch {
    // The browser may deny mic/camera; typed commands and touch remain available.
  }
  if (await requestScreenWakeLock()) granted.push('screen wake lock');
  return granted;
}
