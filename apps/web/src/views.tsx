/** Small presentational pieces for the one-screen trip view and the travel HUD. */
import { useEffect, useRef, useState } from 'react';
import type { RouteResult } from '@polyguide/shared';
import { getCameraStream, startCamera } from './guidance/camera';
import { RouteMap } from './RouteMap';

type Route = Extract<RouteResult, { ok: true }>;

/**
 * The rear camera, full-bleed behind the HUD. It shows the same stream the guidance engine sends to the AI
 * (there is only one stream: iOS mutes a second one). Without camera access it stays a plain dark backdrop.
 */
export function CameraBackdrop({ enabled }: { enabled: boolean }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // The engine opens the camera when navigation starts; open it here too in case it has not yet.
    startCamera().catch(() => undefined);
    const attach = () => {
      const stream = getCameraStream();
      const el = video.current;
      if (cancelled || !el) return;
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream;
        void el.play().catch(() => undefined);
      }
      setLive(Boolean(stream));
    };
    attach();
    const timer = window.setInterval(attach, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return (
    <div className="camera-backdrop" aria-hidden="true">
      <video ref={video} muted playsInline autoPlay className={live ? 'is-live' : ''} />
      <div className="camera-shade" />
    </div>
  );
}

/** Small live view of what the voice assistant can see, on the trip screen. Shows nothing until the camera runs. */
export function CameraPeek() {
  const video = useRef<HTMLVideoElement | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const attach = () => {
      const stream = getCameraStream();
      const el = video.current;
      if (!el) return;
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream;
        void el.play().catch(() => undefined);
      }
      setLive(Boolean(stream));
    };
    attach();
    const timer = window.setInterval(attach, 700);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <figure className="camera-peek" hidden={!live} aria-hidden="true">
      <video ref={video} muted playsInline autoPlay />
      <figcaption>Assistant sees</figcaption>
    </figure>
  );
}

/** Map + step list in a sheet over the screen; the only place that scrolls. */
export function RouteSheet({ route, levelId, onLevel, onClose, activeStepIndex }: { route: Route; levelId: string; onLevel: (levelId: string) => void; onClose: () => void; activeStepIndex?: number }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-head">
          <h2 id="sheet-title">Route details</h2>
          <button ref={closeRef} className="button button-ghost" type="button" onClick={onClose}>Close</button>
        </div>
        {route.levels.length > 1 && (
          <div className="floor-tabs" role="group" aria-label="Show floor">
            {route.levels.map((level) => (
              <button key={level} type="button" className="floor-tab" aria-pressed={levelId === level} onClick={() => onLevel(level)}>
                Floor {level.split('.').at(-1)}
              </button>
            ))}
          </div>
        )}
        <RouteMap route={route} levelId={levelId} activeStepIndex={activeStepIndex} compact />
        <ol className="step-list">
          {route.steps.map((step) => (
            <li key={step.index} className={activeStepIndex === step.index ? 'is-current' : ''}>
              <span className="step-index">{step.index + 1}</span>
              <div><strong>{step.text}</strong><small>{step.distanceM ? `${Math.round(step.distanceM)} m, ` : ''}floor {step.levelId.split('.').at(-1)}{step.toLevelId ? ` to ${step.toLevelId.split('.').at(-1)}` : ''}</small></div>
            </li>
          ))}
        </ol>
        {route.warnings.length > 0 && <ul className="sheet-warnings">{route.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      </section>
    </div>
  );
}
