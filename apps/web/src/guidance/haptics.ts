/**
 * Vibration language: every new step buzzes a pattern that says what kind of movement comes next, so a user
 * who cannot hear (or has the sound off) still feels each change. Patterns alternate on/off milliseconds.
 *
 * Android has the Vibration API. iOS Safari has none, but since iOS 18 toggling a native switch control
 * gives a short system haptic tap; we use that as a best-effort fallback (one tap per pulse).
 */
import type { Maneuver } from '@polyguide/shared';

const SHORT = 70;
const GAP = 110;
const pulses = (count: number, on = SHORT): number[] =>
  Array.from({ length: count }, (_, i) => (i ? [GAP, on] : [on])).flat();

/** Learnable by feel: 1 = keep going, 2 = left, 3 = right, 4 = turn around, 1 long = change floor. */
export function stepPattern(maneuver: Maneuver): number[] {
  switch (maneuver) {
    case 'depart':
    case 'straight':
      return [160];
    case 'slight_left':
      return pulses(2, 45);
    case 'left':
      return pulses(2);
    case 'sharp_left':
      return pulses(2, 140);
    case 'slight_right':
      return pulses(3, 45);
    case 'right':
      return pulses(3);
    case 'sharp_right':
      return pulses(3, 140);
    case 'u_turn':
      return pulses(4);
    case 'take_elevator':
    case 'take_stairs_up':
    case 'take_stairs_down':
    case 'take_ramp_up':
    case 'take_ramp_down':
    case 'take_escalator':
      return [450];
    case 'enter_building':
    case 'exit_building':
      return [200, GAP, 200];
    case 'arrive':
      return [250, GAP, 250, GAP, 600];
    default:
      return [160];
  }
}

/** Spoken in settings so users can learn the patterns. */
export const PATTERN_LEGEND = 'One buzz: keep going. Two: turn left. Three: turn right. Four: turn around. One long buzz: change floor. A long rhythm: you have arrived.';

const isIOS = () => typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

let iosSwitch: HTMLLabelElement | null = null;
function iosTap(): void {
  if (typeof document === 'undefined') return;
  if (!iosSwitch) {
    iosSwitch = document.createElement('label');
    iosSwitch.className = 'ios-haptic-switch';
    iosSwitch.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    iosSwitch.appendChild(input);
    document.body.appendChild(iosSwitch);
  }
  iosSwitch.click();
}

let iosTimers: number[] = [];

/** navigator.vibrate, but only after the first tap: before that, browsers block it and log an error. */
export function buzz(pattern: number | number[]): void {
  if (typeof navigator === 'undefined') return;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (activation && !activation.hasBeenActive) return;
  if ('vibrate' in navigator) {
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
    return;
  }
  if (!isIOS()) return;
  // iOS: one system tap at the start of every "on" segment.
  iosTimers.forEach((t) => window.clearTimeout(t));
  iosTimers = [];
  const list = Array.isArray(pattern) ? pattern : [pattern];
  if (!list.some((ms) => ms > 0)) return;
  let at = 0;
  list.forEach((ms, i) => {
    if (i % 2 === 0 && ms > 0) iosTimers.push(window.setTimeout(iosTap, at));
    at += ms;
  });
}
