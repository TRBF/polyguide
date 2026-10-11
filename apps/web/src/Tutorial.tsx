/**
 * The first-run guide: four short steps on how PolyGuide works, each with a small picture made of the app's own
 * elements (the trip card, a room sign, the vibration patterns, the voice commands) rather than decoration.
 *
 * Built for blind users too: every step is read aloud, "next", "back" and "skip" work by voice, and saying a real
 * command (a trip) closes the guide and does it. Reopened from settings or by saying "how does it work".
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';

export interface TutorialCard {
  id: 'trip' | 'camera' | 'haptics' | 'voice';
  title: string;
  body: string;
  /** Read aloud (plain words, no symbols). */
  spoken: string;
}

export const TUTORIAL: TutorialCard[] = [
  {
    id: 'trip',
    title: 'Say the whole trip in one sentence',
    body: 'Where you are and where you want to go. PolyGuide knows every room in the main building, repeats the trip back and waits for your yes.',
    spoken: 'Say the whole trip in one sentence: where you are and where you want to go. For example: I am in F 7, take me to F 30. I repeat it back, and start when you say yes.',
  },
  {
    id: 'camera',
    title: 'Ask “where am I?” whenever you are unsure',
    body: 'Hold the phone in front of you. The camera reads the room sign next to a door and tells you your floor, the room and the nearest elevator.',
    spoken: 'Whenever you are unsure, ask: where am I. Hold the phone in front of you; the camera reads the room sign beside a door and tells you your floor, the room, and the nearest elevator.',
  },
  {
    id: 'haptics',
    title: 'Every turn is felt, not only heard',
    body: 'Each new step vibrates its own pattern. Elevator rides and stairs are measured, so the app knows when you reach the right floor.',
    spoken: 'Every new step vibrates its own pattern: one buzz to keep going, two for left, three for right, one long buzz for a floor change. Elevator rides and stairs are measured, so I know when you reach the right floor.',
  },
  {
    id: 'voice',
    title: 'Everything works by voice',
    body: 'Settings, a new route or help, any time. PolyGuide supports your cane or guide dog. It does not detect obstacles.',
    spoken: 'Everything works by voice, any time: speak slower, turn off vibration, new route, or emergency. PolyGuide supports your cane or guide dog. It does not detect obstacles.',
  },
];

/* ───── Small pictures built from the app's own elements ───── */

function TripArt() {
  return (
    <div className="g-art g-art-trip" aria-hidden="true">
      <p className="g-bubble">I’m in F 7, take me to F 30</p>
      <div className="g-trip">
        <div className="g-trip-row"><span className="g-dot g-dot-from" /><span><small>From</small>HG F 7</span></div>
        <div className="g-trip-row"><span className="g-dot g-dot-to" /><span><small>To</small>HG F 30 · Audimax</span></div>
      </div>
      <div className="g-confirm"><span className="g-btn g-btn-yes">Yes, start</span><span className="g-btn">No</span></div>
    </div>
  );
}

function CameraArt() {
  return (
    <div className="g-art g-art-camera" aria-hidden="true">
      <div className="g-viewfinder">
        <span className="g-corner g-tl" /><span className="g-corner g-tr" /><span className="g-corner g-bl" /><span className="g-corner g-br" />
        <div className="g-door" />
        <div className="g-sign"><strong>HG F 33.2</strong><small>Seminarraum</small></div>
      </div>
      <p className="g-answer">Floor F, at HG F 33.2. Elevator 25 m.</p>
    </div>
  );
}

function HapticsArt() {
  const rows: [string, number, boolean][] = [['Keep going', 1, false], ['Turn left', 2, false], ['Turn right', 3, false], ['Floor change', 1, true]];
  return (
    <div className="g-art g-art-haptics" aria-hidden="true">
      {rows.map(([label, n, long]) => (
        <div key={label} className="g-pattern">
          <span className="g-pattern-label">{label}</span>
          <span className="g-pulses">{Array.from({ length: n }, (_, i) => <i key={i} className={long ? 'is-long' : ''} />)}</span>
        </div>
      ))}
    </div>
  );
}

function VoiceArt() {
  return (
    <div className="g-art g-art-voice" aria-hidden="true">
      {['Speak slower', 'Bigger text', 'Where am I?', 'New route', 'Turn off vibration'].map((c) => <span key={c} className="g-chip">{c}</span>)}
      <span className="g-chip g-chip-danger">Emergency</span>
    </div>
  );
}

const ART: Record<TutorialCard['id'], () => ReactElement> = { trip: TripArt, camera: CameraArt, haptics: HapticsArt, voice: VoiceArt };

interface Props {
  index: number;
  onIndex: (index: number) => void;
  onDone: () => void;
}

export function Tutorial({ index, onIndex, onDone: finish }: Props) {
  const card = TUTORIAL[index];
  // Leaving fades out (0.2 s) instead of vanishing, so the trip screen is revealed, not swapped in.
  const [leaving, setLeaving] = useState(false);
  const onDone = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(finish, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
  };
  const Art = ART[card.id];
  const last = index === TUTORIAL.length - 1;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Each step takes focus, so a screen reader reads it; arrow keys move, Escape skips.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [index]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const onIndexRef = useRef(onIndex);
  onIndexRef.current = onIndex;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDoneRef.current();
      else if (event.key === 'ArrowRight') {
        if (indexRef.current < TUTORIAL.length - 1) onIndexRef.current(indexRef.current + 1);
        else onDoneRef.current();
      } else if (event.key === 'ArrowLeft' && indexRef.current > 0) onIndexRef.current(indexRef.current - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`guide${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-body">
      <header className="guide-top">
        <ol className="guide-progress" aria-label={`Step ${index + 1} of ${TUTORIAL.length}`}>
          {TUTORIAL.map((c, i) => <li key={c.id} className={i < index ? 'is-done' : i === index ? 'is-current' : ''} />)}
        </ol>
        <button type="button" className="guide-skip" onClick={onDone}>Skip</button>
      </header>

      <div className="guide-main" key={card.id}>
        <Art />
        <p className="guide-count">{index + 1} / {TUTORIAL.length}</p>
        <h2 id="guide-title" ref={headingRef} tabIndex={-1}>{card.title}</h2>
        <p id="guide-body" className="guide-body">{card.body}</p>
      </div>

      <footer className={`guide-actions${index === 0 ? ' is-first' : ''}`}>
        {index > 0 && <button type="button" className="button button-ghost" onClick={() => onIndex(index - 1)}>Back</button>}
        <button type="button" className="button button-accent" onClick={() => (last ? onDone() : onIndex(index + 1))}>
          {last ? 'Get started' : 'Next'}
        </button>
        <p className="guide-voice">Or say “next”, “back” or “skip”.</p>
      </footer>
    </div>
  );
}
