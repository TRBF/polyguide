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
let queue: SpeechItem[] = [];

function start(item: SpeechItem): void {
  if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.rate = rate;
  currentPriority = item.priority;
  utterance.onend = () => {
    currentPriority = null;
    const next = queue.shift();
    if (next) start(next);
  };
  utterance.onerror = () => {
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
    window.speechSynthesis.cancel();
    currentPriority = null;
    start(item);
    return;
  }

  if (currentPriority && priority[currentPriority] > priority[speechPriority]) return;
  if (window.speechSynthesis.speaking) {
    queue.push(item);
    queue.sort((a, b) => priority[b.priority] - priority[a.priority]);
    return;
  }
  start(item);
}

export function stopSpeech(): void {
  queue = [];
  currentPriority = null;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}
