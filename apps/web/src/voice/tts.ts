import type { SpeechPriority } from '@polyguide/shared';

const priority: Record<SpeechPriority, number> = {
  info: 0,
  heading: 1,
  vision: 2,
  instruction: 3,
};

interface SpeechItem {
  text: string;
  priority: SpeechPriority;
}

let enabled = true;
let rate = 1;
let currentPriority: SpeechPriority | null = null;
let activeUtterance: SpeechSynthesisUtterance | null = null;
let pendingStart: number | null = null;
let queue: SpeechItem[] = [];
let lastEndedAt = 0;
/** True from the moment speech is queued until the queue has drained. */
let busy = false;
let micActive = false;
const busyListeners = new Set<(speaking: boolean) => void>();

function setBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  busyListeners.forEach((listener) => listener(next));
}

/**
 * Android Chrome mutes speechSynthesis while SpeechRecognition holds the mic, so hands-free listening
 * takes turns with the app voice: the mic pauses when this reports true and resumes on false.
 */
export function onSpeakingChange(listener: (speaking: boolean) => void): () => void {
  busyListeners.add(listener);
  return () => busyListeners.delete(listener);
}

export function isSpeaking(): boolean {
  return busy;
}

/** The voice bar reports whether recognition is running, so speech can wait for it to let go of audio. */
export function setMicActive(active: boolean): void {
  micActive = active;
}

/** True while the app voice is talking or finished <ms ago; used to keep the mic from hearing us. */
export function speechRecentlyActive(ms = 1200): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  return busy || window.speechSynthesis.speaking || Date.now() - lastEndedAt < ms;
}

function start(item: SpeechItem): void {
  if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) {
    setBusy(false);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.rate = rate;
  currentPriority = item.priority;
  activeUtterance = utterance;
  const micWasActive = micActive;
  setBusy(true); // listeners stop the mic synchronously, before speak()
  let watchdog = 0;
  const finish = () => {
    if (activeUtterance !== utterance) return; // cancelled/replaced: its late event must not touch the new one
    window.clearTimeout(watchdog);
    activeUtterance = null;
    lastEndedAt = Date.now();
    currentPriority = null;
    const next = queue.shift();
    if (next) start(next);
    else setBusy(false);
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  // Some engines never fire onend; never leave the mic paused forever. ~15 chars/s, with a wide margin.
  watchdog = window.setTimeout(finish, 4000 + (item.text.length * 120) / rate);
  // Give the recognizer a moment to release audio focus, or the start of the sentence is lost.
  if (micWasActive) window.setTimeout(() => { if (activeUtterance === utterance) window.speechSynthesis.speak(utterance); }, 250);
  else window.speechSynthesis.speak(utterance);
}

export function configureSpeech(options: { enabled?: boolean; rate?: number }): void {
  if (typeof options.rate === 'number' && Number.isFinite(options.rate)) {
    rate = Math.min(1.5, Math.max(0.6, options.rate));
  }
  if (typeof options.enabled === 'boolean' && options.enabled !== enabled) {
    enabled = options.enabled;
    if (!enabled) stopSpeech();
  }
}

export function speak(text: string, speechPriority: SpeechPriority): void {
  const cleanText = text.trim();
  if (!cleanText || !enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const item = { text: cleanText, priority: speechPriority };

  if (speechPriority === 'instruction') {
    queue = [];
    activeUtterance = null;
    window.speechSynthesis.cancel();
    currentPriority = null;
    setBusy(true);
    // Some browsers drop a speak() issued in the same tick as cancel().
    if (pendingStart !== null) window.clearTimeout(pendingStart);
    pendingStart = window.setTimeout(() => {
      pendingStart = null;
      start(item);
    }, 50);
    return;
  }

  if (currentPriority && priority[currentPriority] > priority[speechPriority]) return;
  if (pendingStart !== null || busy || window.speechSynthesis.speaking) {
    queue.push(item);
    queue.sort((a, b) => priority[b.priority] - priority[a.priority]);
    return;
  }
  start(item);
}

export function stopSpeech(): void {
  if (pendingStart !== null) window.clearTimeout(pendingStart);
  pendingStart = null;
  queue = [];
  activeUtterance = null;
  currentPriority = null;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  setBusy(false);
}
