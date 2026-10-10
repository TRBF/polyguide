/**
 * Pure pieces of the vision check (SPEC §5.5): static system prompt, per-request user context,
 * JSON schema, and the safety post-filter. No I/O, so they are unit-tested.
 */
import type { VisionRequest, VisionResult } from '@polyguide/shared';

/** Static so the provider can prompt-cache it. Everything dynamic goes in the user message. */
export const VISION_SYSTEM_PROMPT = `You are the camera of PolyGuide, an indoor navigation aid for blind, low-vision and wheelchair users inside ETH Zürich buildings.
You get one photo from the user's phone (rear camera, roughly chest height, often tilted or blurry) plus the current navigation context.
The app already knows the route. You only perceive and phrase; you never decide where to go.

Rules:
1. Describe only. Never say or imply that a path, corridor, floor, door or area is clear, safe, free, open to walk or without obstacles. You cannot guarantee safety; the user relies on a cane or guide dog for that. Good: "I can see a closed glass door ahead."
2. Copy room-sign identifiers exactly as printed into detectedRoomNames, e.g. "HG F 33" or "HG E 41.2". Only room identifiers, no person or department names. Put all other legible text verbatim into readText.
3. utterance: at most 15 words, plain spoken language, no markdown. Use left / right / ahead / behind or clock directions ("at 2 o'clock"). Answer in the requested language.
4. If the image is unclear or you are unsure, set confidence below 0.5 and utterance to "".
5. seen: up to 5 navigation-relevant things (room signs, elevators, stairs, ramps, doors, corridors, entrances, signage). matchesExpected is true when the thing corresponds to one of the expected landmarks. relativeDirection is relative to where the camera points.
6. atExpectedPoint: true only with clear evidence that the user has reached the END of the current step: the landmark whose distance equals the step length (for example the expected elevator, stairs, door or destination room sign), or for elevator/stairs steps a floor label showing the target floor. Passing a landmark earlier in the step is not enough.
7. offRouteSuspected: true only if a room sign you read clearly contradicts the context, for example a different floor letter than the current level.
8. Trigger meaning:
   - localize: the user wants to know where they are. Focus on reading the nearest room sign accurately.
   - approaching_node: confirm whether the landmark at the end of the step is visible.
   - off_heading: the user may be facing the wrong way. If the expected landmark is visible, say where it is.
   - user_query: answer the user's question in utterance.
   - periodic: only give an utterance if something new and useful is visible, otherwise "".
9. confidence (0 to 1) reflects how sure you are about atExpectedPoint and the room names.
10. Mention people only as "a person" or "people". Never describe or identify them.`;

const fmtDelta = (d: number | null | undefined) => {
  if (d == null || !Number.isFinite(d)) return 'unknown (compass unavailable)';
  const r = Math.round(d);
  if (Math.abs(r) < 15) return `${r}° (facing roughly the right way)`;
  return `${r}° (the route direction is to the user's ${r > 0 ? 'right' : 'left'})`;
};

/** Dynamic context for one request, sent as text alongside the image. */
export function buildVisionUserText(req: VisionRequest, currentLevelName?: string): string {
  const lines: string[] = [`Trigger: ${req.trigger}`, `Language: ${req.language === 'de' ? 'German' : 'English'}`];
  lines.push(`User needs: ${req.needs.length ? req.needs.join(', ') : 'none stated'}`);
  if (req.step) {
    const s = req.step;
    lines.push(`Current level: ${currentLevelName ?? s.levelId}`);
    lines.push(`Current step: ${s.text} (maneuver ${s.maneuver}, ${Math.round(s.distanceM)} m long${s.toLevelId ? `, to level ${s.toLevelId}` : ''})`);
    if (s.expectedLandmarks.length) {
      lines.push('Expected landmarks on this step:');
      for (const l of s.expectedLandmarks) {
        const side = !l.side ? '' : l.side === 'ahead' ? ', ahead' : `, on the ${l.side}`;
        lines.push(`- ${l.label} (${l.kind}${side}, at ${Math.round(l.atDistanceM)} m)`);
      }
    } else {
      lines.push('Expected landmarks on this step: none known');
    }
  } else {
    lines.push('No active route step.');
  }
  if (req.nextStepText) lines.push(`Next maneuver: ${req.nextStepText}`);
  lines.push(`Heading delta: ${fmtDelta(req.headingDeltaDeg)}`);
  if (req.userQuestion) lines.push(`User question: ${req.userQuestion}`);
  return lines.join('\n');
}

/** Structured-output schema: VisionResult minus latencyMs. Strict mode needs every key required. */
export const VISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sceneSummary', 'readText', 'detectedRoomNames', 'seen', 'atExpectedPoint', 'offRouteSuspected', 'notableThings', 'utterance', 'confidence'],
  properties: {
    sceneSummary: { type: 'string', description: 'One short descriptive sentence about the scene.' },
    readText: { type: 'array', items: { type: 'string' }, description: 'All legible text, verbatim.' },
    detectedRoomNames: { type: 'array', items: { type: 'string' }, description: 'Room-sign identifiers exactly as printed.' },
    seen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'matchesExpected', 'relativeDirection'],
        properties: {
          label: { type: 'string' },
          matchesExpected: { type: 'boolean' },
          relativeDirection: { type: 'string', enum: ['left', 'right', 'ahead', 'behind', 'unknown'] },
        },
      },
    },
    atExpectedPoint: { type: 'boolean' },
    offRouteSuspected: { type: 'boolean' },
    notableThings: { type: 'array', items: { type: 'string' }, description: 'Descriptive only, never "path is clear".' },
    utterance: { type: 'string', description: 'At most 15 words; empty if unsure.' },
    confidence: { type: 'number', description: '0 to 1' },
  },
} as const;

/** Phrases that claim safety. The model is told not to use them; we strip them anyway. */
const UNSAFE = /\b(clear|clears|safe|safely|unobstructed|obstacle[- ]free|no obstacles?|nothing (is )?(in|blocking) (the|your) (way|path)|free (path|way|of obstacles)|path is (open|free)|you can (walk|go) (freely|straight through))\b/i;

/** German claims of safety (JS \b is ASCII-only, so use Unicode lookarounds). */
const UNSAFE_DE = /(?<![\p{L}])(frei(e[nrms]?)?|sicher(e[nrms]?)?|ungefährlich|gefahrlos|hindernisfrei|kein(e[nrms]?)? hindernisse?)(?![\p{L}])/iu;

/** Drop any sentence that claims safety, then cap to maxWords. */
export function sanitizeUtterance(text: string, maxWords = 15): string {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s && !UNSAFE.test(s) && !UNSAFE_DE.test(s));
  const words = sentences.join(' ').split(' ').filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ').replace(/[,;:]$/, '') + '.';
}

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const strArr = (v: unknown, max = 20) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()).slice(0, max) : [];
const DIRS = new Set(['left', 'right', 'ahead', 'behind', 'unknown']);

/** Normalise raw model JSON into a safe VisionResult (rule 1 and rule 4 enforced in code). */
export function postProcessVision(raw: unknown, latencyMs: number): VisionResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const confidence = clamp01(r.confidence);
  const seen = Array.isArray(r.seen)
    ? r.seen
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as any).label === 'string')
        .slice(0, 8)
        .map((s) => ({
          label: String(s.label),
          matchesExpected: s.matchesExpected === true,
          relativeDirection: (DIRS.has(String(s.relativeDirection)) ? s.relativeDirection : 'unknown') as VisionResult['seen'][number]['relativeDirection'],
        }))
    : [];
  return {
    sceneSummary: sanitizeUtterance(typeof r.sceneSummary === 'string' ? r.sceneSummary : '', 30),
    readText: strArr(r.readText, 30),
    detectedRoomNames: strArr(r.detectedRoomNames, 10),
    seen,
    atExpectedPoint: r.atExpectedPoint === true,
    offRouteSuspected: r.offRouteSuspected === true,
    notableThings: strArr(r.notableThings, 8).map((t) => sanitizeUtterance(t, 20)).filter(Boolean),
    utterance: confidence < 0.5 ? '' : sanitizeUtterance(typeof r.utterance === 'string' ? r.utterance : ''),
    confidence,
    latencyMs,
  };
}
