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
  const [typing, setTyping] = useState(false);
  /** True while hands-free listening is on; it survives pauses for the app voice and browser timeouts. */
  const keepAlive = useRef(false);
  const resumeTimer = useRef<number | null>(null);
  /** Sessions stopped gracefully (not aborted): a command they already heard is still delivered. */
  const draining = useRef(new Set<RecognitionLike>());
  /** Consecutive network failures; hands-free backs off instead of retrying (and beeping) forever offline. */
  const networkErrors = useRef(0);

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

  /** Detaches the current session. 'abort' drops anything it heard; 'stop' still delivers a finished command. */
  function endSession(how: 'stop' | 'abort'): void {
    const session = sessionRef.current;
    sessionRef.current = null;
    setMicActive(false);
    if (session) {
      if (how === 'stop') draining.current.add(session);
      try { session[how](); } catch { draining.current.delete(session); }
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
      const live = sessionRef.current === session;
      // A session paused for the app's voice still hands over the command it recorded before the pause.
      if (!live && !draining.current.has(session)) return;
      const words: string[] = [];
      // Only results added since the last event; continuous sessions accumulate the whole history.
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal && result[0]?.transcript) words.push(result[0].transcript.trim());
      }
      const phrase = words.join(' ');
      if (!phrase || (live && handsFree && speechRecentlyActive())) return; // the app hearing itself
      networkErrors.current = 0;
      setTranscript(phrase);
      setVoiceError('');
      onCommandRef.current(phrase);
    };
    session.onerror = (event) => {
      if (sessionRef.current !== session) return;
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') keepAlive.current = false;
      if (event.error === 'network') {
        networkErrors.current += 1;
        if (networkErrors.current >= 4) keepAlive.current = false;
        setVoiceError(keepAlive.current ? 'Voice input lost the connection. Retrying…' : 'Voice input needs a connection. Type the command below, or tap the mic to try again.');
        return;
      }
      setVoiceError(event.error === 'not-allowed' ? 'Microphone access was denied. Type the same command below.' : 'Voice input stopped. Type the same command below.');
    };
    session.onend = () => {
      if (draining.current.delete(session)) return;
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      setMicActive(false);
      // Offline: wait longer after each failure (1 s, 2 s, 4 s) instead of a tight retry loop.
      if (keepAlive.current) scheduleResume(networkErrors.current ? 1000 * 2 ** (networkErrors.current - 1) : 300);
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
        // Stop, not abort: a command the user finished just before the app spoke is still transcribed.
        if (sessionRef.current) endSession('stop');
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
    networkErrors.current = 0;
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
    // Do this before dispatching: on mobile the command may take several seconds to resolve,
    // and the virtual keyboard must not cover its confirmation controls while it is pending.
    setTyping(false);
    (form.elements.namedItem('command') as HTMLInputElement | null)?.blur();
    onCommand(command);
    setTranscript(command);
    form.reset();
  }

  return (
    <section className={`voice-bar${voiceFirst ? ' voice-bar-first' : ''}${listening ? ' is-listening' : ''}`} aria-label="Voice and text commands">
      <div className="voice-controls">
        {available && (
          <button className="button button-mic" type="button" onClick={toggleListening} aria-pressed={listening}>
            <MicIcon listening={listening} />
            <span>{listening ? (continuous ? 'Listening… tap to pause' : 'Listening…') : 'Tap to speak'}</span>
          </button>
        )}
        {available && (
          <button className="button button-keyboard" type="button" aria-expanded={typing} aria-controls="command-form" onClick={() => setTyping((open) => !open)}>
            <span aria-hidden="true">⌨</span>
            <span className="sr-only">Type instead</span>
          </button>
        )}
      </div>
      {/* Typing is the fallback: always there when speech input is not, one tap away otherwise. */}
      <form id="command-form" className="command-form" onSubmit={submitText} hidden={available && !typing}>
        <label className="sr-only" htmlFor="voice-command">Type a command</label>
        <input id="voice-command" name="command" type="text" autoComplete="off" placeholder="I'm in F 7, take me to F 30" />
        <button className="button button-command" type="submit">Send</button>
      </form>
      {voiceError && <p className="form-error" role="status">{voiceError}</p>}
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
