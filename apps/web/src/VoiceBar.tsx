import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { createRecognition, type RecognitionLike } from './voice/stt';
import { isSpeaking, onSpeakingChange, setMicActive, speechRecentlyActive } from './voice/tts';

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
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const onCommandRef = useRef(onCommand);
  const languageRef = useRef(language);
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceError, setVoiceError] = useState('');
  /** True while hands-free listening is on; it survives pauses for the app voice and browser timeouts. */
  const keepAlive = useRef(false);
  /** True between recognition.start() and its onend. */
  const running = useRef(false);
  const resumeTimer = useRef<number | null>(null);

  onCommandRef.current = onCommand;
  languageRef.current = language;

  function startRecognition(recognition: RecognitionLike, keepListening: boolean): boolean {
    if (running.current) return true;
    try {
      recognition.lang = languageRef.current === 'de' ? 'de-CH' : 'en-US';
      recognition.continuous = keepListening;
      recognition.interimResults = false;
      recognition.start();
      running.current = true;
      setMicActive(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Hands-free: (re)open the mic, but only while the app is not talking. */
  function scheduleResume(delayMs: number): void {
    if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      resumeTimer.current = null;
      const recognition = recognitionRef.current;
      if (!recognition || !keepAlive.current || running.current || isSpeaking()) return;
      if (!startRecognition(recognition, true)) scheduleResume(1000);
    }, delayMs);
  }

  useImperativeHandle(ref, () => ({
    startContinuous() {
      const recognition = recognitionRef.current;
      if (!recognition || keepAlive.current) return;
      keepAlive.current = true;
      setVoiceError('');
      setListening(true);
      // Started at once (inside the user's tap: iOS needs that, and it raises the mic prompt);
      // if the app is talking, the speaking listener pauses it again right away.
      if (!startRecognition(recognition, true)) scheduleResume(500);
      else if (isSpeaking()) recognition.abort();
    },
    stopContinuous() {
      const recognition = recognitionRef.current;
      if (!recognition || !keepAlive.current) return;
      keepAlive.current = false;
      if (running.current) recognition.stop();
      setListening(false);
    },
  }), []);

  useEffect(() => {
    const recognition = createRecognition();
    recognitionRef.current = recognition;
    setAvailable(Boolean(recognition));
    if (!recognition) return;
    recognition.onresult = (event) => {
      const words: string[] = [];
      // Only results added since the last event; continuous sessions accumulate the whole history.
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal && result[0]?.transcript) words.push(result[0].transcript.trim());
      }
      const phrase = words.join(' ');
      // Ignore what the app's own voice just said.
      if (phrase && !speechRecentlyActive()) {
        setTranscript(phrase);
        setVoiceError('');
        onCommandRef.current(phrase);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') keepAlive.current = false;
      setVoiceError(event.error === 'not-allowed' ? 'Microphone access was denied. Type the same command below.' : 'Voice input stopped. Type the same command below.');
      if (!keepAlive.current) setListening(false);
    };
    recognition.onend = () => {
      running.current = false;
      setMicActive(false);
      if (keepAlive.current) scheduleResume(300);
      else setListening(false);
    };
    const unsubscribe = onSpeakingChange((speaking) => {
      if (!keepAlive.current) return;
      if (speaking) {
        if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
        resumeTimer.current = null;
        if (running.current) recognition.abort();
      } else scheduleResume(300);
    });
    return () => {
      unsubscribe();
      keepAlive.current = false;
      if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
      recognition.abort();
      recognitionRef.current = null;
    };
  }, []);

  function toggleListening(): void {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      keepAlive.current = false;
      if (running.current) recognition.stop();
      setListening(false);
      return;
    }
    keepAlive.current = continuous;
    setTranscript('');
    setVoiceError('');
    if (startRecognition(recognition, continuous)) setListening(true);
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
      <div className="voice-bar-heading">
        <strong>{listening ? 'Listening' : 'Use voice or type a command'}</strong>
        {continuous && available && <span>Continuous listening is available when started</span>}
      </div>
      <div className="voice-controls">
        {available && (
          <button className="button button-mic" type="button" onClick={toggleListening} aria-pressed={listening}>
            <span aria-hidden="true">{listening ? '■' : '🎙'}</span>
            <span>{listening ? 'Stop listening' : continuous ? 'Start continuous listening' : 'Push to talk'}</span>
          </button>
        )}
        <form className="command-form" onSubmit={submitText}>
          <label className="sr-only" htmlFor="voice-command">Type a voice command</label>
          <input id="voice-command" name="command" type="text" autoComplete="off" placeholder="Try: take me to HG F 30" />
          <button className="button button-command" type="submit">Send</button>
        </form>
      </div>
      {transcript && <p className="transcript" aria-live="polite">Heard: {transcript}</p>}
      {voiceError && <p className="form-error" role="status">{voiceError}</p>}
      {!available && <p className="voice-help">Speech recognition is unavailable here. Type any command in the field.</p>}
    </section>
  );
});
