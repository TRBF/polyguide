import { useState, type FormEvent } from 'react';
import type { AgentStatus } from './RealtimeAgent';

const label: Record<AgentStatus, string> = {
  off: 'Voice off',
  connecting: 'Connecting voice…',
  listening: 'Listening… tap to pause',
  hearing: 'Hearing you…',
  thinking: 'Thinking…',
  speaking: 'Speaking… tap to interrupt',
  error: 'Voice unavailable',
};

/** The dock while the realtime voice is on: always listening; one big button pauses or interrupts it. */
export function RealtimeDock({ status, muted, voiceFirst, onToggleMute, onInterrupt, onText }: {
  status: AgentStatus;
  muted: boolean;
  voiceFirst: boolean;
  onToggleMute: () => void;
  onInterrupt: () => void;
  onText: (text: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const speaking = status === 'speaking' || status === 'thinking';

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get('command') ?? '').trim();
    if (!text) return;
    // Dismiss the phone keyboard before an AI response renders the confirmation buttons.
    setTyping(false);
    (form.elements.namedItem('command') as HTMLInputElement | null)?.blur();
    onText(text);
    form.reset();
  }

  return (
    <section className={`voice-bar${voiceFirst ? ' voice-bar-first' : ''}${!muted ? ' is-listening' : ''}`} aria-label="Voice assistant">
      <div className="voice-controls">
        <button
          className="button button-mic"
          type="button"
          aria-pressed={!muted}
          onClick={() => (speaking && !muted ? onInterrupt() : onToggleMute())}
        >
          <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            {muted && <path d="M4 4l16 16" />}
          </svg>
          <span role="status" aria-live="polite">{muted ? 'Paused, tap to talk' : label[status]}</span>
        </button>
        <button className="button button-keyboard" type="button" aria-expanded={typing} aria-controls="rt-command-form" onClick={() => setTyping((open) => !open)}>
          <span aria-hidden="true">⌨</span>
          <span className="sr-only">Type instead</span>
        </button>
      </div>
      <form id="rt-command-form" className="command-form" onSubmit={submit} hidden={!typing}>
        <label className="sr-only" htmlFor="rt-command">Type a message</label>
        <input id="rt-command" name="command" type="text" autoComplete="off" placeholder="Where am I? Take me to F 30" />
        <button className="button button-command" type="submit">Send</button>
      </form>
    </section>
  );
}
