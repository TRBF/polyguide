import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { createRecognition, type RecognitionLike } from './voice/stt';
import { speechRecentlyActive } from './voice/tts';

interface VoiceBarProps {
  voiceFirst: boolean;
  continuous: boolean;
  language: 'en' | 'de';
  onCommand: (text: string) => void;
}

export interface VoiceBarHandle {
  startContinuous(): void;
}

export const VoiceBar = forwardRef<VoiceBarHandle, VoiceBarProps>(function VoiceBar({ voiceFirst, continuous, language, onCommand }, ref) {
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const onCommandRef = useRef(onCommand);
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceError, setVoiceError] = useState('');
  /** True while continuous listening should survive the browser ending a session after silence. */
  const keepAlive = useRef(false);

  onCommandRef.current = onCommand;

  useImperativeHandle(ref, () => ({
    startContinuous() {
      const recognition = recognitionRef.current;
      if (!recognition || listening) return;
      try {
        recognition.lang = language === 'de' ? 'de-CH' : 'en-US';
        recognition.continuous = true;
        recognition.interimResults = false;
        setVoiceError('');
        keepAlive.current = true;
        recognition.start();
        setListening(true);
      } catch {
        setVoiceError('Voice input could not start. Type the same command below.');
      }
    },
  }), [language, listening]);

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
      setListening(false);
    };
    recognition.onend = () => {
      if (keepAlive.current) {
        window.setTimeout(() => {
          if (!keepAlive.current) return;
          try { recognition.start(); setListening(true); } catch { setListening(false); }
        }, 300);
        return;
      }
      setListening(false);
    };
    return () => {
      keepAlive.current = false;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, []);

  function toggleListening(): void {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      keepAlive.current = false;
      recognition.stop();
      setListening(false);
      return;
    }
    try {
      recognition.lang = language === 'de' ? 'de-CH' : 'en-US';
      recognition.continuous = continuous;
      recognition.interimResults = false;
      keepAlive.current = continuous;
      setTranscript('');
      setVoiceError('');
      recognition.start();
      setListening(true);
    } catch {
      setVoiceError('Voice input could not start. Type the same command below.');
    }
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
