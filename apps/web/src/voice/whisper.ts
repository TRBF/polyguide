/**
 * Speech to text with OpenAI Whisper (via POST /api/stt), shaped like the browser's SpeechRecognition so
 * VoiceBar treats both the same. The phone records the mic, finds where the user starts and stops talking
 * from the audio level, and uploads each spoken command; silence is never sent (Whisper invents text for it).
 */
import type { RecognitionLike } from './stt';

const TICK_MS = 50;
/** This much sound above the noise floor starts a command… */
const SPEECH_MS = 150;
/** …and this much quiet after it ends one (long enough that a pause mid-sentence does not split it). */
const SILENCE_MS = 1400;
const MAX_COMMAND_MS = 12_000;
/** Push-to-talk gives up when nothing is said. */
const NO_SPEECH_MS = 8000;
/**
 * Hands-free: throw away a recording that stayed silent this long and start a fresh one. Short, so an upload
 * holds the command plus at most a couple of seconds before it, not earlier hallway chatter.
 */
const IDLE_RESTART_MS = 2500;
const MIN_LEVEL = 0.015;

let sharedContext: AudioContext | null = null;

/** One AudioContext for every session: iOS only lets it run if it was first resumed inside a tap. */
function audioContext(): AudioContext {
  if (!sharedContext) {
    const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    sharedContext = new Context();
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => undefined);
  return sharedContext;
}

function recordingType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)) ?? '';
}

export function whisperSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && Boolean(window.AudioContext ?? (window as Window & { webkitAudioContext?: unknown }).webkitAudioContext);
}

type State = 'idle' | 'starting' | 'listening' | 'stopping' | 'ended';

export class WhisperRecognition implements RecognitionLike {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;

  private state: State = 'idle';
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: { rec: MediaRecorder; keep: boolean; startedAt: number } | null = null;
  private timer: number | null = null;
  private listeningSince = 0;
  private loudMs = 0;
  private quietMs = 0;
  private speaking = false;
  private commandStartedAt = 0;
  private noiseFloor = 0.01;
  private uploads = 0;
  private heardSomething = false;

  start(): void {
    if (this.state !== 'idle') throw new DOMException('Already started.', 'InvalidStateError');
    this.state = 'starting';
    const context = audioContext(); // inside the user's tap on the first start
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((stream) => {
        if (this.state !== 'starting') {
          stream.getTracks().forEach((track) => track.stop());
          this.finishIfDone();
          return;
        }
        this.stream = stream;
        this.source = context.createMediaStreamSource(stream);
        this.analyser = context.createAnalyser();
        this.analyser.fftSize = 1024;
        this.source.connect(this.analyser);
        this.state = 'listening';
        this.listeningSince = Date.now();
        this.newRecorder();
        this.timer = window.setInterval(() => this.tick(), TICK_MS);
      })
      .catch((error: unknown) => {
        const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        this.onerror?.({ error: denied ? 'not-allowed' : 'audio-capture' });
        this.state = 'stopping';
        this.finishIfDone();
      });
  }

  /** Ends listening; a command in progress is still transcribed. */
  stop(): void {
    if (this.state === 'idle' || this.state === 'ended' || this.state === 'stopping') return;
    if (this.speaking) this.endCommand();
    this.release();
    this.state = 'stopping';
    this.finishIfDone();
  }

  /** Ends listening and drops anything not yet transcribed. */
  abort(): void {
    if (this.state === 'idle' || this.state === 'ended') return;
    this.uploads = 0;
    this.release();
    this.state = 'stopping';
    this.finishIfDone();
  }

  private level(): number {
    if (!this.analyser) return 0;
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  private tick(): void {
    if (this.state !== 'listening') return;
    const level = this.level();
    const loud = level > Math.max(MIN_LEVEL, this.noiseFloor * 3);
    const now = Date.now();
    if (!this.speaking) {
      if (loud) {
        this.loudMs += TICK_MS;
        if (this.loudMs >= SPEECH_MS) {
          this.speaking = true;
          this.heardSomething = true;
          this.quietMs = 0;
          this.commandStartedAt = now - this.loudMs;
        }
        return;
      }
      this.loudMs = 0;
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      if (!this.continuous && !this.heardSomething && now - this.listeningSince > NO_SPEECH_MS) {
        this.onerror?.({ error: 'no-speech' });
        this.stop();
      } else if (this.continuous && this.recorder && now - this.recorder.startedAt > IDLE_RESTART_MS) {
        this.newRecorder(); // keep recordings short; the old one is silence
      }
      return;
    }
    this.quietMs = loud ? 0 : this.quietMs + TICK_MS;
    if (this.quietMs >= SILENCE_MS || now - this.commandStartedAt > MAX_COMMAND_MS) this.endCommand();
  }

  private newRecorder(): void {
    // A recorder replaced here held only silence: stopped without `keep`, it is never uploaded.
    if (this.recorder && this.recorder.rec.state !== 'inactive') this.recorder.rec.stop();
    if (!this.stream) return;
    const type = recordingType();
    const rec = type ? new MediaRecorder(this.stream, { mimeType: type }) : new MediaRecorder(this.stream);
    const entry = { rec, keep: false, startedAt: Date.now() };
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    rec.onstop = () => {
      if (entry.keep) this.upload(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }));
    };
    rec.start();
    this.recorder = entry;
  }

  /** The user stopped talking: send what was recorded, and keep listening if hands-free. */
  private endCommand(): void {
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
    const current = this.recorder;
    this.recorder = null;
    if (current) {
      current.keep = true;
      this.uploads += 1; // counted now so a stop() right after waits for the transcript
      current.rec.stop();
    }
    if (this.continuous && this.state === 'listening') this.newRecorder();
    else if (this.state === 'listening') {
      this.release();
      this.state = 'stopping';
    }
  }

  private upload(audio: Blob): void {
    if (this.state === 'ended') return; // aborted before the recording finished
    const language = this.lang.toLowerCase().startsWith('de') ? 'de' : 'en';
    fetch(`/api/stt?lang=${language}`, { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { ok?: boolean; text?: string } | null;
        if (this.state === 'ended' || this.uploads === 0) return; // aborted meanwhile
        if (body?.ok && body.text) {
          this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: body.text } }] });
        } else if (!body?.ok) {
          this.onerror?.({ error: 'network' });
        }
      })
      .catch(() => { if (this.state !== 'ended' && this.uploads > 0) this.onerror?.({ error: 'network' }); })
      .finally(() => {
        this.uploads = Math.max(0, this.uploads - 1);
        this.finishIfDone();
      });
  }

  private release(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.recorder && this.recorder.rec.state !== 'inactive') this.recorder.rec.stop();
    this.recorder = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private finishIfDone(): void {
    if (this.state !== 'stopping' || this.uploads > 0) return;
    this.state = 'ended';
    window.setTimeout(() => this.onend?.(), 0);
  }
}
