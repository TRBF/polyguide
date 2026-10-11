/**
 * /debug/sensors — live sensor values for phone testing (PLAN Sync 1: "phone test of sensors on
 * iOS + Android"). Also lets you hear the beacon against a chosen target bearing.
 */
import { useEffect, useRef, useState } from 'react';
import { AudioBeacon, beaconParams, headingDelta } from './heading';
import { requestSensorPermissions, startSensors, type SensorSnapshot } from './sensors';

const fmt = (n: number | null | undefined, digits = 0) => (n == null ? '—' : n.toFixed(digits));

export function SensorDebug() {
  const [granted, setGranted] = useState<string[] | null>(null);
  const [snap, setSnap] = useState<SensorSnapshot | null>(null);
  const [target, setTarget] = useState(0);
  const [beaconOn, setBeaconOn] = useState(false);
  const beacon = useRef<AudioBeacon | null>(null);

  useEffect(() => startSensors({ onChange: setSnap }), []);
  useEffect(() => () => beacon.current?.dispose(), []);

  const delta = headingDelta(target, snap?.headingDeg ?? null);
  useEffect(() => beacon.current?.setDelta(delta), [delta]);

  async function enable() {
    setGranted(await requestSensorPermissions());
  }

  function toggleBeacon() {
    beacon.current ??= new AudioBeacon();
    if (beaconOn) beacon.current.stop();
    else {
      beacon.current.start();
      beacon.current.setDelta(delta);
      beacon.current.test(delta ?? 0);
    }
    setBeaconOn(!beaconOn);
  }

  const rows: [string, string][] = [
    ['Heading', `${fmt(snap?.headingDeg)}°`],
    ['Source', snap?.headingSource ?? '—'],
    ['Reliable', snap ? (snap.headingReliable ? 'yes' : 'no') : '—'],
    ['Jitter', `${fmt(snap?.headingJitterDeg, 1)}°`],
    ['iOS compass accuracy', `${fmt(snap?.compassAccuracyDeg)}°`],
    ['Steps', String(snap?.steps ?? 0)],
    ['Moving', snap ? (snap.moving ? 'yes' : 'no') : '—'],
    ['|acc| incl. gravity', `${fmt(snap?.accelMag, 2)} m/s²`],
    ['Acc variance (1 s)', fmt(snap?.accelVariance, 3)],
    ['Delta to target', delta == null ? '—' : `${fmt(delta)}° (pan ${beaconParams(delta).pan.toFixed(2)})`],
  ];

  return (
    <main className="app-shell sensor-debug-page">
      <h1>Sensor debug</h1>
      <p>
        <button className="button button-primary" type="button" onClick={() => void enable()}>
          Enable motion and orientation
        </button>
      </p>
      {granted && <p role="status">Granted: {granted.length ? granted.join(', ') : 'nothing'}</p>}
      <svg className="sensor-debug-arrow" viewBox="0 0 100 100" aria-hidden="true">
        <text x="50" y="70" textAnchor="middle" transform={`rotate(${delta ?? 0} 50 50)`}>↑</text>
      </svg>
      <table className="sensor-debug-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <label>
          Target bearing: {target}°
          <input className="sensor-debug-range" type="range" min={0} max={359} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
      </p>
      <p className="sensor-debug-actions">
        <button className="button" type="button" onClick={() => setTarget(Math.round(snap?.headingDeg ?? 0))}>
          Set target to current heading
        </button>
        <button className="button" type="button" onClick={toggleBeacon} aria-pressed={beaconOn}>
          {beaconOn ? 'Stop beacon' : 'Play beacon'}
        </button>
      </p>
      <p><a href="/">Back to the app</a></p>
    </main>
  );
}
