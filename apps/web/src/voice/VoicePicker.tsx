import { useEffect, useState } from 'react';
import { activeVoiceName, availableVoices, onVoicesChanged, speak } from './tts';

const SAMPLE = 'Turn left. Then go about twenty metres to the elevator.';

/** Settings control: choose the app voice (or automatic) and hear a sample. */
export function VoicePicker({ value, onChange }: { value: string | null; onChange: (name: string | null) => void }) {
  const [, setTick] = useState(0);
  useEffect(() => onVoicesChanged(() => setTick((t) => t + 1)), []);
  const voices = availableVoices();
  const active = activeVoiceName();

  return (
    <div className="setting-control">
      <label htmlFor="voice-select">
        <span>
          <strong>App voice</strong>
          <small>{active ? `Using ${active}` : 'Using the browser default voice'}</small>
        </span>
      </label>
      <select id="voice-select" value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Automatic (best installed voice)</option>
        {voices.map((v) => (
          <option key={`${v.name}|${v.lang}`} value={v.name}>
            {v.name} ({v.lang})
          </option>
        ))}
      </select>
      <button className="button button-secondary" type="button" onClick={() => speak(SAMPLE, 'instruction')}>
        Test voice
      </button>
      {voices.length === 0 && <small>No voices reported by this browser yet.</small>}
    </div>
  );
}
