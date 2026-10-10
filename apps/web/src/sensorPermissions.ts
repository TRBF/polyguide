/**
 * Track B owns the sensor implementation in guidance/sensors.ts. Keep this
 * permission-only fallback until that module is available to the app shell.
 * TODO(track-B): delegate to guidance/sensors.ts requestSensorPermissions().
 */
export async function requestSensorPermissions(): Promise<string[]> {
  const granted: string[] = [];
  const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<PermissionState>;
  };
  const motion = DeviceMotionEvent as typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<PermissionState>;
  };
  try {
    if (orientation.requestPermission) {
      const result = await orientation.requestPermission();
      if (result === 'granted') granted.push('orientation');
    } else if ('DeviceOrientationEvent' in window) {
      granted.push('orientation');
    }
  } catch {
    // Permission is optional; navigation can still be advanced by voice or touch.
  }
  try {
    if (motion.requestPermission) {
      const result = await motion.requestPermission();
      if (result === 'granted') granted.push('motion');
    } else if ('DeviceMotionEvent' in window) {
      granted.push('motion');
    }
  } catch {
    // Permission is optional; navigation can still be advanced by voice or touch.
  }
  return granted;
}
