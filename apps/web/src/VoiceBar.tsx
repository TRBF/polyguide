import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { createRecognition, onSpeechInputChange, speechInputAvailable, type RecognitionLike } from './voice/stt';
import { isSpeaking, onSpeakingChange, setMicActive, speechRecentlyActive, stopSpeech } from './voice/tts';

interface VoiceBarProps {
  voiceFirst: boolean;
  continuous: boolean;
  language: 'en' | 'de';
  onCommand: (text: string) => void;
}

export interface VoiceBarHandle {
  startContinuous(): void;
  /** Ends hands-free listening; a push-to-talk session is left alone. */
  stopContinuous(): void;
}

export const VoiceBar = forwardRef<VoiceBarHandle, VoiceBarProps>(function VoiceBar({ voiceFirst, continuous, language, onCommand }, ref) {
  /** The live listening session. A new recognizer per session, so a late or missing onend from an
   *  aborted one (Chrome can skip it when aborted right after start) never wedges the mic. */
  const sessionRef = useRef<RecognitionLike | null>(null);
  const onCommandRef = useRef(onCommand);
  const languageRef = useRef(language);
  const [available, setAvailable] = useState(speechInputAvailable);
  // Whisper becomes available once the server confirms it (it also covers browsers with no recognizer).
  useEffect(() => onSpeechInputChange(() => setAvailable(speechInputAvailable())), []);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceError, setVoiceError] = useState('');
  /** True while hands-free listening is on; it survives pauses for the app voice and browser timeouts. */
  const keepAlive = useRef(false);
  const resumeTimer = useRef<number | null>(null);

  onCommandRef.current = onCommand;
  languageRef.current = language;

  function clearResume(): void {
    if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
  }

  // The echo of what was heard is a confirmation, not content: let it fade.
  useEffect(() => {
    if (!transcript) return;
    const timer = window.setTimeout(() => setTranscript(''), 4000);
    return () => window.clearTimeout(timer);
  }, [transcript]);

  /** Drops the current session; its later events are ignored. */
  function endSession(how: 'stop' | 'abort'): void {
    const session = sessionRef.current;
    sessionRef.current = null;
    setMicActive(false);
    if (session) {
      try { session[how](); } catch { /* already ended */ }
    }
  }

  /** Opens a new session. Hands-free sessions filter out the app's own voice; push-to-talk ones need
   *  not, because pressing the button silences the app first. */
  function startSession(handsFree: boolean): boolean {
    endSession('abort');
    const session = createRecognition();
    if (!session) return false;
    session.lang = languageRef.current === 'de' ? 'de-CH' : 'en-US';
    session.continuous = handsFree;
    session.interimResults = false;
    session.onresult = (event) => {
      if (sessionRef.current !== session) return;
      const words: string[] = [];
      // Only results added since the last event; continuous sessions accumulate the whole history.
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal && result[0]?.transcript) words.push(result[0].transcript.trim());
      }
      const phrase = words.join(' ');
      if (!phrase || (handsFree && speechRecentlyActive())) return; // the app hearing itself
      setTranscript(phrase);
      setVoiceError('');
      onCommandRef.current(phrase);
    };
    session.onerror = (event) => {
      if (sessionRef.current !== session) return;
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') keepAlive.current = false;
      setVoiceError(event.error === 'not-allowed' ? 'Microphone access was denied. Type the same command below.' : 'Voice input stopped. Type the same command below.');
    };
    session.onend = () => {
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      setMicActive(false);
      if (keepAlive.current) scheduleResume(300);
      else setListening(false);
    };
    try {
      session.start();
    } catch {
      return false;
    }
    sessionRef.current = session;
    setMicActive(true);
    return true;
  }

  /** Hands-free: reopen the mic, but only while the app is not talking. */
  function scheduleResume(delayMs: number): void {
    clearResume();
    resumeTimer.current = window.setTimeout(() => {
      resumeTimer.current = null;
      if (!keepAlive.current || sessionRef.current || isSpeaking()) return;
      if (!startSession(true)) scheduleResume(1000);
    }, delayMs);
  }

  useImperativeHandle(ref, () => ({
    startContinuous() {
      if (!available || keepAlive.current) return;
      keepAlive.current = true;
      setVoiceError('');
      setListening(true);
      // Started at once (inside the user's tap: iOS needs that, and it raises the mic prompt);
      // if the app is talking, it pauses again right away and resumes when the app is quiet.
      if (!startSession(true)) scheduleResume(500);
      else if (isSpeaking()) endSession('abort');
    },
    stopContinuous() {
      if (!keepAlive.current) return;
      keepAlive.current = false;
      clearResume();
      endSession('stop');
      setListening(false);
    },
  }));

  useEffect(() => {
    const unsubscribe = onSpeakingChange((speaking) => {
      if (!keepAlive.current) return;
      if (speaking) {
        clearResume();
        if (sessionRef.current) endSession('abort');
      } else scheduleResume(300);
    });
    return () => {
      unsubscribe();
      keepAlive.current = false;
      clearResume();
      endSession('abort');
    };
  }, []);

  function toggleListening(): void {
    if (!available) return;
    if (listening) {
      keepAlive.current = false;
      clearResume();
      endSession('stop');
      setListening(false);
      return;
    }
    // Pressing the mic interrupts the app (barge-in); Android would mute it while the mic is open anyway.
    stopSpeech();
    keepAlive.current = continuous;
    setTranscript('');
    setVoiceError('');
    if (startSession(continuous)) setListening(true);
    else setVoiceError('Voice input could not start. Type the same command below.');
  }

  function submitText(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const command = String(data.get('command') ?? '').trim();
    if (!command) return;
    onCommand(command);
    setTranscript(command);
    form.reset();
  }

  return (
    <section className={`voice-bar${voiceFirst ? ' voice-bar-first' : ''}`} aria-label="Voice and text commands">
      <div className="voice-controls">
        {available && (
          <button
            className="button button-mic"
            type="button"
            onClick={toggleListening}
            aria-pressed={listening}
            aria-label={voiceFirst ? undefined : listening ? 'Stop listening' : continuous ? 'Start continuous listening' : 'Push to talk'}
          >
            <MicIcon listening={listening} />
            {voiceFirst && <span>{listening ? 'Stop listening' : 'Tap and speak'}</span>}
          </button>
        )}
        <form className="command-form" onSubmit={submitText}>
          <label className="sr-only" htmlFor="voice-command">Type a command</label>
          <input id="voice-command" name="command" type="text" autoComplete="off" placeholder={listening ? 'Listening…' : 'Say or type: take me to HG F 30'} />
          <button className="button button-command" type="submit">Send</button>
        </form>
      </div>
      {transcript && <p className="transcript" aria-live="polite">Heard “{transcript}”</p>}
      {voiceError && <p className="form-error" role="status">{voiceError}</p>}
      {!available && voiceFirst && <p className="voice-help">Speech recognition is unavailable here. Type any command in the field.</p>}
    </section>
  );
});

function MicIcon({ listening }: { listening: boolean }) {
  return listening ? (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
  ) : (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
