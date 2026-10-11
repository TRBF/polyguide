/**
 * System check: every part of the app tested live, with timings, in one sheet. Each warning says what still works
 * without that part, because the app is built to degrade, not to break. Opened from settings or by saying
 * "system check"; the summary is spoken.
 */
import { useEffect, useRef, useState } from 'react';
import { API, type AgentResponse, type RouteResult } from '@polyguide/shared';
import { altimeter } from './guidance/altimeter';
import { isCameraActive, startCamera } from './guidance/camera';
import type { LiveSensors } from './realtime/liveSensors';

type Status = 'pending' | 'ok' | 'warn' | 'fail';

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  ms?: number;
}

interface Props {
  cameraGranted: boolean;
  sensors: LiveSensors;
  /** Realtime voice status: 'off' | 'connecting' | 'listening' | … | 'error'. */
  liveVoice: string;
  onClose: () => void;
  onSummary: (spoken: string) => void;
}

const MAIN_ENTRANCE = 'pl_lm_137';
const AUDIMAX = 'pl_hg_f_30';

async function timed<T>(fn: () => Promise<T>, timeoutMs = 8000): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await Promise.race([fn(), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('timed out')), timeoutMs))]);
  return { value, ms: Math.round(performance.now() - t0) };
}

const json = (url: string, body?: unknown) =>
  fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const CHECKS: { id: string; label: string }[] = [
  { id: 'server', label: 'Server and HG map' },
  { id: 'route', label: 'Step-free routing' },
  { id: 'agent', label: 'Voice agent (AI)' },
  { id: 'stt', label: 'Speech to text' },
  { id: 'live', label: 'Conversational voice' },
  { id: 'camera', label: 'Camera' },
  { id: 'mic', label: 'Microphone' },
  { id: 'motion', label: 'Compass and motion' },
  { id: 'floor', label: 'Floor sensor' },
];

export function SystemCheck({ cameraGranted, sensors, liveVoice, onClose, onSummary }: Props) {
  const [checks, setChecks] = useState<Check[]>(CHECKS.map((c) => ({ ...c, status: 'pending', detail: 'Checking…' })));
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const results = new Map<string, Check>();
    const set = (id: string, status: Status, detail: string, ms?: number) => {
      const label = CHECKS.find((c) => c.id === id)!.label;
      results.set(id, { id, label, status, detail, ms });
      if (!cancelled) setChecks((current) => current.map((c) => (c.id === id ? { ...c, status, detail, ms } : c)));
    };

    const runs: Promise<void>[] = [
      timed(() => json(API.health)).then(({ value, ms }) => {
        const v = value as { ok?: boolean; graph?: { places: number; nodes: number } };
        if (v.ok && v.graph) set('server', 'ok', `${v.graph.places} places, ${v.graph.nodes.toLocaleString()} path points`, ms);
        else set('server', 'fail', 'Server answered without the map.', ms);
      }).catch(() => set('server', 'fail', 'Server not reachable. Navigation of a route already loaded still works.')),

      timed(() => json(API.route, { from: { type: 'place', placeId: MAIN_ENTRANCE }, to: { type: 'place', placeId: AUDIMAX }, profile: { needs: ['wheelchair'] } })).then(({ value, ms }) => {
        const r = value as RouteResult;
        if (r.ok) set('route', 'ok', `Main entrance → Audimax: ${r.steps.length} steps, ${Math.round(r.totalDistanceM)} m, no stairs`, ms);
        else set('route', 'fail', r.message, ms);
      }).catch(() => set('route', 'fail', 'Routing failed.')),

      timed(() => json(API.agent, { utterance: "I'm at the main entrance, take me to the Audimax", context: { phase: 'trip', needs: [] } }), 10_000).then(({ value, ms }) => {
        const r = value as AgentResponse;
        if (r.ok) set('agent', 'ok', r.action === 'set_trip' ? `Understood a full trip in one sentence` : `Answered (${r.action})`, ms);
        else set('agent', 'warn', r.reason === 'disabled' ? 'No AI key: on-device commands still work.' : `AI unavailable (${r.reason}): on-device commands still work.`, ms);
      }).catch(() => set('agent', 'warn', 'AI not reachable: on-device commands still work.')),

      timed(() => json('/api/stt')).then(({ value, ms }) => {
        const r = value as { enabled?: boolean; model?: string };
        if (r.enabled) set('stt', 'ok', `${r.model ?? 'OpenAI'} ready`, ms);
        else set('stt', 'warn', "Off: the phone's own speech recognition is used.", ms);
      }).catch(() => set('stt', 'warn', "Not reachable: the phone's own speech recognition is used.")),

      Promise.resolve().then(() => {
        if (liveVoice === 'error') set('live', 'warn', 'Not available: the regular voice and agent take over.');
        else if (liveVoice === 'off') set('live', 'warn', 'Off: the regular voice and agent are used.');
        else set('live', 'ok', `Connected (${liveVoice})`);
      }),

      (async () => {
        if (!cameraGranted) return set('camera', 'warn', 'Not allowed: the app goes by your steps and what you say.');
        if (isCameraActive()) return set('camera', 'ok', 'Rear camera live');
        try {
          const { ms } = await timed(() => startCamera(), 5000);
          set('camera', 'ok', 'Rear camera live', ms);
        } catch {
          set('camera', 'warn', 'Could not start: the app goes by your steps and what you say.');
        }
      })(),

      (async () => {
        try {
          const state = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (state.state === 'granted') set('mic', 'ok', 'Allowed');
          else if (state.state === 'prompt') set('mic', 'warn', 'Will ask on first use. Typing always works.');
          else set('mic', 'warn', 'Blocked: typing works, and buttons do everything.');
        } catch {
          set('mic', 'warn', 'Unknown on this browser. Typing always works.');
        }
      })(),

      new Promise<void>((resolve) => window.setTimeout(resolve, 1200)).then(() => {
        const s = sensors.sensor;
        if (!s) return set('motion', 'warn', 'No sensor data yet (allow motion). Say next at each step instead.');
        const compass = s.headingDeg != null ? `compass ${Math.round(s.headingDeg)}°${s.headingReliable ? '' : ' (settling)'}` : 'no compass';
        const motion = s.accelMag != null ? 'step counter on' : 'no motion data';
        set('motion', s.headingDeg != null && s.accelMag != null ? 'ok' : 'warn', `${compass}, ${motion}`);
      }),

      Promise.resolve().then(() => {
        if (!altimeter.belief.ready) return set('floor', 'warn', 'Floor heights not loaded yet.');
        const st = altimeter.current;
        set('floor', 'ok', st.levelId && st.probability >= 0.5
          ? `Floor ${st.levelId.split('.').at(-1)} (${Math.round(st.probability * 100)} % sure); elevator rides and stairs measured`
          : 'Ready: calibrates at the start of a route, then measures elevator rides and stairs');
      }),
    ];

    void Promise.allSettled(runs).then(() => {
      if (cancelled) return;
      const all = [...results.values()];
      const ok = all.filter((c) => c.status === 'ok').length;
      const problems = all.filter((c) => c.status !== 'ok').map((c) => `${c.label}: ${c.detail}`);
      onSummary(`System check: ${ok} of ${all.length} ready.${problems.length ? ` ${problems.join(' ')}` : ' Everything is working.'}`);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = checks.every((c) => c.status !== 'pending');
  const ok = checks.filter((c) => c.status === 'ok').length;
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="sheet system-check" role="dialog" aria-modal="true" aria-labelledby="check-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-head">
          <h2 id="check-title">System check</h2>
          <button ref={closeRef} className="button button-ghost" type="button" onClick={onClose}>Close</button>
        </div>
        <p className="check-summary" role="status">{done ? `${ok} of ${checks.length} ready` : 'Testing every part live…'}</p>
        <ul className="check-list">
          {checks.map((c) => (
            <li key={c.id} className={`check check-${c.status}`}>
              <span className="check-icon" aria-hidden="true">{c.status === 'ok' ? '✓' : c.status === 'pending' ? '…' : c.status === 'warn' ? '!' : '✕'}</span>
              <span className="check-text">
                <strong>{c.label}</strong>
                <small>{c.detail}{c.ms != null ? ` · ${c.ms} ms` : ''}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
