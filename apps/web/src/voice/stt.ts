import { WhisperRecognition, whisperSupported } from './whisper';

interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResultLike>;
}

export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => RecognitionLike;

/** null until the server has answered whether Whisper speech to text is on (it needs an OpenAI key). */
let whisperEnabled: boolean | null = null;
const availabilityListeners = new Set<() => void>();

if (typeof window !== 'undefined' && typeof fetch === 'function') {
  fetch('/api/stt', { headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { enabled?: boolean } | null) => { whisperEnabled = Boolean(body?.enabled); })
    .catch(() => { whisperEnabled = false; })
    .finally(() => availabilityListeners.forEach((listener) => listener()));
}

function browserRecognition(): RecognitionConstructor | undefined {
  const host = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

/** localStorage['polyguide.stt'] = 'browser' keeps the browser's recognizer (for comparing, and its tests). */
function whisperWanted(): boolean {
  try {
    if (localStorage.getItem('polyguide.stt') === 'browser') return false;
  } catch {
    // Storage blocked: use the default.
  }
  return Boolean(whisperEnabled) && whisperSupported();
}

/** Whisper when the server offers it and the browser can record; otherwise the browser's own recognizer. */
export function createRecognition(): RecognitionLike | null {
  if (typeof window === 'undefined') return null;
  const Constructor: RecognitionConstructor | undefined = whisperWanted() ? WhisperRecognition : browserRecognition();
  if (!Constructor) return null;
  const recognition = new Constructor();
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.lang = 'en-US';
  return recognition;
}

export function speechInputAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(whisperWanted() || browserRecognition());
}

/** Called once the server has said whether Whisper is on (availability may change then). */
export function onSpeechInputChange(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}
