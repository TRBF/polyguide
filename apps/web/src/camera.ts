import { captureFrame, stopCamera } from './guidance/camera';
import { requestSensorPermissions } from './sensorPermissions';

/** The camera stream is shared with guidance (one stream only; iOS mutes a second one). */
export function releaseCamera(): void {
  stopCamera();
}

export async function captureRoomSignFrame(maxSide = 1024): Promise<string> {
  return captureFrame(maxSide, 0.6);
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
