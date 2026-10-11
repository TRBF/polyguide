/**
 * Speech-to-speech voice agent over WebRTC (OpenAI Realtime). The server mints a client secret with the
 * instructions and tools; this class owns the call, the mic, the model's audio and the event channel.
 *
 * Turn flow: the server VAD commits the user's speech but does not reply on its own (create_response off).
 * On commit we add a fresh "[Live state]" system message (and drop the previous one), then ask for the reply,
 * so every answer sees the current position, heading and route. Tool calls run in the app; their results go
 * back as function_call_output (plus a camera photo for `look`) and the model continues.
 *
 * App announcements (step instructions) are spoken by the same voice, word for word, so the user hears one
 * voice and the model knows what the app just said. One response at a time: the rest wait in a queue.
 */
import { API, type RealtimeSessionResponse } from '@polyguide/shared';

export type AgentStatus = 'off' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

export interface ToolResult {
  /** JSON-able result for the model. */
  output: unknown;
  /** Extra conversation content after the output, e.g. the photo for `look`. */
  image?: { jpegBase64: string; caption: string };
}

export interface RealtimeAgentOptions {
  language: 'en' | 'de';
  /** The live state, built fresh at send time. */
  liveState: () => Promise<string> | string;
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onStatus?: (status: AgentStatus) => void;
  onUserTranscript?: (text: string) => void;
  onAssistantTranscript?: (text: string) => void;
  /** Live captions: the text so far, as it streams (user speech and the model's answer). */
  onUserPartial?: (textSoFar: string) => void;
  onAssistantPartial?: (textSoFar: string) => void;
  /** A camera frame to attach to each user turn, so the model always sees what is in front of the phone. */
  frame?: () => Promise<{ jpegBase64: string; caption: string } | null>;
  onError?: (message: string) => void;
}

/** droppable = a heading nudge: worth saying only right now, never queued behind other speech. */
type Pending = { kind: 'reply' } | { kind: 'announce'; text: string; droppable?: boolean; at: number };

/** A queued heading nudge older than this describes a direction the user no longer faces. */
const NUDGE_STALE_MS = 2500;

interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const CONNECT_TIMEOUT_MS = 15_000;

/** A connection "disconnected" this long has dropped (it usually heals within a few seconds). */
const DISCONNECTED_GRACE_MS = 6000;

/**
 * The mic, retried briefly: a recognizer or permission probe that just let go of it can still hold it for a
 * moment, and phones then fail with NotReadableError ("Could not start audio source").
 */
async function openMic(): Promise<MediaStream> {
  const constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  for (const waitMs of [250, 600, 1200]) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (!(err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'AbortError'))) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

export class RealtimeAgent {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private status: AgentStatus = 'off';
  private responseActive = false;
  private queue: Pending[] = [];
  private lastStateId: string | null = null;
  private seq = 0;
  private closed = false;
  private muted = false;
  private dropTimer: number | null = null;
  private announcing: string | null = null;
  /** The model's audio is still playing (it can outlast the response by seconds). */
  private playing = false;
  /** A tool call is being answered: the response slot must not be cut into. */
  private toolsRunning = false;
  private frameIds: string[] = [];
  private partial = new Map<string, string>();
  private connectAbort: AbortController | null = null;

  constructor(private opts: RealtimeAgentOptions) {}

  get connected() {
    return this.dc?.readyState === 'open';
  }

  /**
   * Call from a tap: the mic prompt and audio playback need the user gesture. Resolves once the event channel
   * is open; throws if anything fails (the caller falls back to the old voice pipeline).
   */
  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus('connecting');
    const abort = new AbortController();
    this.connectAbort = abort;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // Inside the gesture: audio element first, so iOS lets it play later.
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    this.audio = audio;
    // Save the stream as soon as permission resolves so a timeout can release it. getUserMedia itself cannot be
    // aborted; if permission arrives after this connection was closed, stop the late stream immediately.
    // openMic() retries briefly while another recognizer still lets go of the mic.
    const micPromise = openMic().then((mic) => {
      if (this.closed) {
        mic.getTracks().forEach((track) => track.stop());
        throw new Error('Voice setup was cancelled.');
      }
      this.mic = mic;
      return mic;
    });
    const sessionPromise = fetch(API.realtimeSession, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: this.opts.language }), signal: abort.signal })
      .then((r) => r.json() as Promise<RealtimeSessionResponse>);
    const setup = (async () => {
      const [mic, session] = await Promise.all([micPromise, sessionPromise]);
      if (this.closed) {
        mic.getTracks().forEach((track) => track.stop());
        throw new Error('Voice setup was cancelled.');
      }
      if (!session.ok) throw new Error(session.message);

      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        void audio.play().catch(() => undefined);
      };
      // Connected without a tap (reload, setting turned on): browsers may block playback until the next one.
      for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, this.unlockAudio, { passive: true });
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'failed' || state === 'closed') this.fail('The voice connection dropped.');
        // "disconnected" can heal by itself (a wifi blip); if it does not, the user must hear that nobody listens.
        if (state === 'disconnected' && this.dropTimer == null) {
          this.dropTimer = window.setTimeout(() => {
            this.dropTimer = null;
            if (pc.connectionState !== 'connected') this.fail('The voice connection dropped.');
          }, DISCONNECTED_GRACE_MS);
        }
      };
      for (const track of mic.getAudioTracks()) {
        // A phone call or another app can take the mic: then nothing is heard any more.
        track.onended = () => this.fail('The microphone stopped.');
        pc.addTrack(track, mic);
      }
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (m) => this.onEvent(JSON.parse(String(m.data)));
      const opened = new Promise<void>((resolve, reject) => {
        dc.onopen = () => resolve();
        dc.onclose = () => {
          if (this.closed) return;
          const error = new Error('The voice connection closed.');
          reject(error);
          this.fail(error.message);
        };
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(CALLS_URL, { method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${session.clientSecret}`, 'Content-Type': 'application/sdp' }, signal: abort.signal });
      if (!res.ok) throw new Error(`Voice call refused (${res.status}).`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      await opened;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Voice setup timed out. Check microphone access or use typed commands.')), CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([setup, timeout]);
      this.setMuted(this.muted);
      this.setStatus('listening');
    } catch (err) {
      abort.abort();
      this.close();
      this.setStatus('error');
      throw err;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (this.connectAbort === abort) this.connectAbort = null;
    }
  }

  private unlockAudio = () => {
    if (this.audio?.srcObject && this.audio.paused) void this.audio.play().catch(() => undefined);
  };

  close() {
    this.closed = true;
    this.connectAbort?.abort();
    this.connectAbort = null;
    if (this.dropTimer != null) window.clearTimeout(this.dropTimer);
    this.dropTimer = null;
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.removeEventListener(ev, this.unlockAudio);
    this.queue = [];
    this.responseActive = false;
    this.playing = false;
    this.toolsRunning = false;
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.audio) this.audio.srcObject = null;
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.setStatus('off');
  }

  /** Pause listening (the mic track is silenced; the call stays up). */
  setMuted(muted: boolean) {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  /** Typed input: same as speech, without the audio. */
  sendText(text: string) {
    if (!this.connected) return;
    this.cancelSpeech();
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    void this.reply(true);
  }

  /** Context for the model without a reply, e.g. "the camera read the sign HG F 33". */
  note(text: string) {
    if (!this.connected) return;
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
  }

  /**
   * Speak an app announcement word for word (queued behind the current reply). A droppable one (heading nudge)
   * is spoken only if nothing else is being said or waiting; otherwise it is skipped, not queued.
   */
  announce(text: string, opts: { droppable?: boolean; urgent?: boolean } = {}) {
    if (!this.connected || !text.trim()) return;
    if (opts.droppable && (this.responseActive || this.playing || this.queue.length)) return;
    if (opts.urgent) {
      // Something new happened (a new step): what was being said or waiting is out of date. Stop it and say this.
      this.queue = this.queue.filter((q) => q.kind !== 'announce');
      this.interrupt();
    } else if (!opts.droppable) {
      // A real instruction makes any waiting nudge obsolete.
      this.queue = this.queue.filter((q) => !(q.kind === 'announce' && q.droppable));
    }
    this.request({ kind: 'announce', text, droppable: opts.droppable, at: Date.now() });
  }

  /** Cut off the current speech, unless a tool call is being answered (that would lose its result). */
  private interrupt() {
    if (this.toolsRunning) return;
    if (this.responseActive) this.send({ type: 'response.cancel' });
    if (this.responseActive || this.playing) this.send({ type: 'output_audio_buffer.clear' });
  }

  /** Stop the model talking (e.g. the user tapped). */
  cancelSpeech() {
    if (!this.responseActive) return;
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }

  /* ───── Internals ───── */

  private send(event: Record<string, unknown>) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  private setStatus(s: AgentStatus) {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private fail(message: string) {
    if (this.closed) return;
    this.opts.onError?.(message);
    this.close();
    this.setStatus('error');
  }

  /** Add the live state (replacing the last one) and, for a user turn, a camera frame; then ask for the reply. */
  private async reply(userTurn = false) {
    await this.pushState(userTurn);
    this.request({ kind: 'reply' });
  }

  private async pushState(withFrame = false) {
    // Both in parallel: the frame must not delay the answer.
    const [state, frame] = await Promise.all([
      Promise.resolve().then(() => this.opts.liveState()).catch(() => '[Live state] unavailable right now.'),
      withFrame && this.opts.frame ? this.opts.frame().catch(() => null) : Promise.resolve(null),
    ]);
    if (frame) {
      const frameId = `cam_${Date.now().toString(36)}_${++this.seq}`;
      this.send({
        type: 'conversation.item.create',
        item: { id: frameId, type: 'message', role: 'user', content: [{ type: 'input_text', text: frame.caption }, { type: 'input_image', image_url: `data:image/jpeg;base64,${frame.jpegBase64}`, detail: 'low' }] },
      });
      // Older frames only cost tokens: keep the last two.
      this.frameIds.push(frameId);
      while (this.frameIds.length > 2) this.send({ type: 'conversation.item.delete', item_id: this.frameIds.shift() });
    }
    const id = `live_${Date.now().toString(36)}_${++this.seq}`;
    if (this.lastStateId) this.send({ type: 'conversation.item.delete', item_id: this.lastStateId });
    this.send({ type: 'conversation.item.create', item: { id, type: 'message', role: 'system', content: [{ type: 'input_text', text: state }] } });
    this.lastStateId = id;
  }

  private request(p: Pending) {
    // A user turn replaces an announcement that has not started yet: they are talking now.
    if (p.kind === 'reply') this.queue = this.queue.filter((q) => q.kind !== 'reply');
    this.queue.push(p);
    this.pump();
  }

  private pump() {
    if (this.responseActive || !this.queue.length) return;
    // Replies first; consecutive announcements are read as one.
    const replyAt = this.queue.findIndex((q) => q.kind === 'reply');
    let next: Pending;
    if (replyAt >= 0) next = this.queue.splice(replyAt, 1)[0];
    else {
      const now = Date.now();
      const texts = this.queue
        .filter((q) => q.kind === 'announce' && !(q.droppable && now - q.at > NUDGE_STALE_MS))
        .map((q) => (q.kind === 'announce' ? q.text : ''))
        .filter(Boolean);
      this.queue = [];
      if (!texts.length) return;
      next = { kind: 'announce', text: texts.join(' '), at: now };
    }
    this.responseActive = true;
    this.setStatus('thinking');
    if (next.kind === 'reply') this.send({ type: 'response.create' });
    else {
      // Out of band, with only the text as input: inside the conversation the model paraphrases instructions
      // from context. The text joins the conversation once spoken (onResponseDone), so the agent knows it.
      this.announcing = next.text;
      this.send({
        type: 'response.create',
        response: {
          conversation: 'none',
          instructions: 'You are a screen reader. Read the given text aloud exactly as written, word for word, in a calm clear voice. Never add, drop or change a word.',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: next.text }] }],
          tool_choice: 'none',
          metadata: { kind: 'announce' },
        },
      });
    }
  }

  private onEvent(e: { type: string; [k: string]: unknown }) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        this.setStatus('hearing');
        return;
      case 'input_audio_buffer.committed':
        void this.reply(true);
        return;
      case 'conversation.item.input_audio_transcription.delta':
      case 'response.output_audio_transcript.delta': {
        const user = e.type.startsWith('conversation');
        const key = `${user ? 'u' : 'a'}:${String(user ? e.item_id : e.response_id)}`;
        const text = (this.partial.get(key) ?? '') + String(e.delta ?? '');
        this.partial.set(key, text);
        if (user) this.opts.onUserPartial?.(text.trim());
        else this.opts.onAssistantPartial?.(text.trim());
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.partial.delete(`u:${String(e.item_id)}`);
        const t = String(e.transcript ?? '').trim();
        if (t) this.opts.onUserTranscript?.(t);
        return;
      }
      case 'output_audio_buffer.started':
        this.playing = true;
        this.setStatus('speaking');
        return;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.playing = false;
        if (!this.responseActive) this.setStatus('listening');
        return;
      case 'response.output_audio_transcript.done': {
        this.partial.delete(`a:${String(e.response_id)}`);
        const t = String(e.transcript ?? '').trim();
        if (t) this.opts.onAssistantTranscript?.(t);
        return;
      }
      case 'response.done':
        void this.onResponseDone(e.response as { status: string; output?: { type: string }[]; metadata?: { kind?: string } | null });
        return;
      case 'error': {
        const err = e.error as { message?: string; code?: string } | undefined;
        // Harmless races (deleting an item already gone, cancelling a finished response).
        if (err?.code && /item_not_found|response_cancel_not_active|no_active_response/.test(err.code)) return;
        console.warn('realtime error', err);
        if (err?.code === 'conversation_already_has_active_response') {
          this.responseActive = true;
          return;
        }
        return;
      }
    }
  }

  private async onResponseDone(r: { status: string; output?: { type: string }[]; metadata?: { kind?: string } | null }) {
    if (r.metadata?.kind === 'announce' && this.announcing) {
      const text = this.announcing;
      this.announcing = null;
      if (r.status === 'completed') this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `(app announcement) ${text}` }] } });
    }
    const calls = r.status === 'completed' && r.metadata?.kind !== 'announce' ? ((r.output ?? []).filter((o) => o.type === 'function_call') as FunctionCallItem[]) : [];
    if (!calls.length) {
      this.responseActive = false;
      this.setStatus(this.status === 'speaking' ? 'speaking' : 'listening');
      this.pump();
      return;
    }
    // Keep the slot while tools run, so nothing else starts a response in between.
    this.toolsRunning = true;
    this.setStatus('thinking');
    const images: ToolResult['image'][] = [];
    for (const call of calls) {
      let result: ToolResult;
      try {
        result = await this.opts.runTool(call.name, JSON.parse(call.arguments || '{}') as Record<string, unknown>);
      } catch (err) {
        result = { output: { ok: false, error: err instanceof Error ? err.message : 'The tool failed.' } };
      }
      if (this.closed) return void (this.toolsRunning = false);
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result.output) } });
      if (result.image) images.push(result.image);
    }
    for (const img of images) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: img!.caption }, { type: 'input_image', image_url: `data:image/jpeg;base64,${img!.jpegBase64}`, detail: 'high' }] },
      });
    }
    // The tool output is new information: the model continues with a fresh live state. The slot stays held
    // until then, so a queued announcement cannot slip in between the tool result and the model's answer.
    await this.pushState();
    this.toolsRunning = false;
    if (this.closed) return;
    this.responseActive = false;
    this.request({ kind: 'reply' });
  }
}
