/**
 * Earcons: tiny sounds that answer before any voice can. A soft tick the moment speech is recognised ("I heard
 * you"), a double tick when the app acted instantly, a low pulse while the AI is still thinking. Quiet and short,
 * so they never compete with instructions. The audio context is unlocked by the start tap (browsers require it).
 */

let ctx: AudioContext | null = null;

/** Call inside a user gesture (the Start tap). */
export function unlockEarcons(): void {
  try {
    if (!ctx) {
      const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      ctx = new Context();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    ctx = null;
  }
}

export type EarconKind = 'heard' | 'done' | 'thinking';

const SHAPES: Record<EarconKind, { f: number; at: number; ms: number }[]> = {
  heard: [{ f: 880, at: 0, ms: 35 }],
  done: [{ f: 1175, at: 0, ms: 35 }, { f: 1568, at: 0.07, ms: 45 }],
  thinking: [{ f: 440, at: 0, ms: 90 }],
};

export function earcon(kind: EarconKind, volume = 0.12): void {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + 0.01;
  for (const { f, at, ms } of SHAPES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    const start = t0 + at;
    const end = start + ms / 1000;
    // A quick fade in and out: no clicks.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
