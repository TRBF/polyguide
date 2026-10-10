/**
 * Track B owns the sensor implementation in guidance/sensors.ts. Keep this
 * permission-only fallback until that module is available to the app shell.
 * TODO(track-B): delegate to guidance/sensors.ts requestSensorPermissions().
 */
export async function requestSensorPermissions(): Promise<string[]> {
  const granted: string[] = [];
  const orientation = (typeof DeviceOrientationEvent === 'undefined' ? undefined : DeviceOrientationEvent) as
    | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> })
    | undefined;
  const motion = (typeof DeviceMotionEvent === 'undefined' ? undefined : DeviceMotionEvent) as
    | (typeof DeviceMotionEvent & { requestPermission?: () => Promise<PermissionState> })
    | undefined;
  // Both requests start in the same tick so neither loses the user gesture on iOS.
  const ask = (api: typeof orientation | typeof motion, name: string) =>
    !api
      ? Promise.resolve()
      : api.requestPermission
        ? api.requestPermission().then((r) => { if (r === 'granted') granted.push(name); }).catch(() => undefined)
        : Promise.resolve().then(() => { granted.push(name); });
  await Promise.all([ask(orientation, 'orientation'), ask(motion, 'motion')]);
  return granted;
}
