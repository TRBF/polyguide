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
    <main className="app-shell" style={{ padding: 16, maxWidth: 560, margin: '0 auto' }}>
      <h1>Sensor debug</h1>
      <p>
        <button className="button button-primary" type="button" onClick={() => void enable()}>
          Enable motion and orientation
        </button>
      </p>
      {granted && <p role="status">Granted: {granted.length ? granted.join(', ') : 'nothing'}</p>}
      <div aria-hidden="true" style={{ fontSize: 96, textAlign: 'center', transform: `rotate(${delta ?? 0}deg)`, transition: 'transform 120ms linear' }}>
        ↑
      </div>
      <table style={{ width: '100%', fontSize: 18 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" style={{ textAlign: 'left', paddingRight: 12 }}>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <label>
          Target bearing: {target}°
          <input type="range" min={0} max={359} value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: '100%' }} />
        </label>
      </p>
      <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
