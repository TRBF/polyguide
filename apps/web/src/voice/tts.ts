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

/** True while the app voice is talking or finished <ms ago; used to keep the mic from hearing us. */
export function speechRecentlyActive(ms = 1200): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  return window.speechSynthesis.speaking || Date.now() - lastEndedAt < ms;
}

function start(item: SpeechItem): void {
  if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.rate = rate;
  currentPriority = item.priority;
  activeUtterance = utterance;
  utterance.onend = () => {
    if (activeUtterance !== utterance) return; // cancelled/replaced: its late event must not touch the new one
    lastEndedAt = Date.now();
    currentPriority = null;
    const next = queue.shift();
    if (next) start(next);
  };
  utterance.onerror = () => {
    if (activeUtterance !== utterance) return;
    lastEndedAt = Date.now();
    currentPriority = null;
    const next = queue.shift();
    if (next) start(next);
  };
  window.speechSynthesis.speak(utterance);
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
    // Some browsers drop a speak() issued in the same tick as cancel().
    if (pendingStart !== null) window.clearTimeout(pendingStart);
    pendingStart = window.setTimeout(() => {
      pendingStart = null;
      start(item);
    }, 50);
    return;
  }

  if (currentPriority && priority[currentPriority] > priority[speechPriority]) return;
  if (pendingStart !== null || window.speechSynthesis.speaking) {
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
}
