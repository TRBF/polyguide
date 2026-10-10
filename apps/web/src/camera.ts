export async function captureRoomSignFrame(maxSide = 1024): Promise<string> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser.');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise<void>((resolve) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      });
    }
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the camera image.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6).split(',')[1] ?? '';
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

let screenWakeLock: WakeLockSentinel | null = null;

export async function requestScreenWakeLock(): Promise<boolean> {
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
  const active = screenWakeLock;
  screenWakeLock = null;
  if (active) void active.release().catch(() => undefined);
}

export async function requestAppPermissions(): Promise<string[]> {
  const granted: string[] = [];
  try {
    const { requestSensorPermissions } = await import('./sensorPermissions');
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
