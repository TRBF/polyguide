/**
 * Compass, motion and GPS for the whole session, not only while navigating: the voice agent needs to know
 * which way the phone points while the user is still planning, lost, or turning around to look.
 */
import { startSensors, type SensorSnapshot } from '../guidance/sensors';

export interface GpsFix {
  lat: number;
  lon: number;
  accuracyM: number;
  at: number;
}

export class LiveSensors {
  sensor: SensorSnapshot | null = null;
  gps: GpsFix | null = null;
  private stopSensors: (() => void) | null = null;
  private watchId: number | null = null;

  start() {
    this.stopSensors ??= startSensors({ onChange: (s) => (this.sensor = s) });
    if (this.watchId == null && typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (p) => (this.gps = { lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: p.coords.accuracy, at: Date.now() }),
        () => undefined, // denied or unavailable indoors: the agent is told "GPS: none"
        { enableHighAccuracy: true, maximumAge: 5000 },
      );
    }
  }

  stop() {
    this.stopSensors?.();
    this.stopSensors = null;
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  heading(): { deg: number | null; reliable: boolean } {
    return { deg: this.sensor?.headingDeg ?? null, reliable: this.sensor?.headingReliable ?? false };
  }

  /** A fix older than two minutes says nothing about where the user is now. */
  freshGps(now = Date.now()): GpsFix | null {
    return this.gps && now - this.gps.at < 120_000 ? this.gps : null;
  }
}
