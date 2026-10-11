/**
 * The camera half of "where am I" (pure, unit-tested): a prompt that reads every sign, names the kinds of
 * landmark in view, and writes a short visual fingerprint of the spot. The fingerprint is embedded and compared
 * with reference fingerprints captured on site (refs.ts), so photos are matched without storing any photo.
 */
import { splitRoomRanges } from '../ai/visionPrompt';

export const LANDMARK_KINDS = [
  'elevator', 'stairs', 'escalator', 'ramp', 'entrance_doors', 'glass_door', 'main_hall', 'light_court',
  'lecture_hall_doors', 'toilet_sign', 'cafeteria', 'library', 'cloakroom', 'information_desk', 'corridor',
  'window_to_outside', 'courtyard', 'terrace',
] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

export const LOCALIZE_SYSTEM_PROMPT = `You help a blind or low-vision person find out where they are inside the ETH Zürich main building (HG). You get one phone photo, often tilted, blurred, dark or showing only part of a wall. Never ask for another photo or a better angle: work with this one.

Fill the JSON:
- roomSigns: every room identifier you can read, exactly as printed ("HG F 33", "F 33.2", "E 41"). Room signs sit beside doors. A range sign "K 30.1 - K 33" gives both ends. Only identifiers whose characters you can actually see; a partly hidden one may end with "?" (e.g. "F 3?").
- floorText: a floor letter shown on its own (on a stair landing, an elevator panel or a floor sign: "F", "E", "Stockwerk F"), else "".
- readText: other legible text, verbatim (department names excluded), at most 8 items.
- landmarks: the kinds of things clearly in view, from the allowed list.
- fingerprint: at most 45 words describing the place itself so the same spot can be recognised again later: layout (corridor, hall, stair landing), shape and width, floor and wall materials, doors and their kind, windows and their direction, columns, arches, railings, lights, colours, any signs and where they hang. No people, no temporary objects (bags, posters, chairs that move), no guesses about where it is.
- confidence: 0 to 1, how sure you are of the room signs you listed (0 when none).
Never describe or identify people.`;

export const LOCALIZE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['roomSigns', 'floorText', 'readText', 'landmarks', 'fingerprint', 'confidence'],
  properties: {
    roomSigns: { type: 'array', items: { type: 'string' } },
    floorText: { type: 'string' },
    readText: { type: 'array', items: { type: 'string' } },
    landmarks: { type: 'array', items: { type: 'string', enum: LANDMARK_KINDS } },
    fingerprint: { type: 'string' },
    confidence: { type: 'number' },
  },
} as const;

export interface LocalizeObservation {
  roomSigns: string[];
  /** Signs read only in part ("F 3?"): weaker evidence. */
  partialSigns: string[];
  floorLetter: string | null;
  readText: string[];
  landmarks: LandmarkKind[];
  fingerprint: string;
  confidence: number;
}

const FLOORS = new Set(['B', 'C', 'D', 'DO', 'E', 'EO', 'F', 'FO', 'G', 'GO', 'H', 'J', 'JO', 'K', 'KO']);
const strs = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, 60)).slice(0, max) : [];

/** Normalise raw model JSON (never trusted as-is). */
export function parseObservation(raw: unknown): LocalizeObservation {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const signs = splitRoomRanges(strs(r.roomSigns, 10));
  const floorMatch = typeof r.floorText === 'string' ? r.floorText.toUpperCase().match(/\b([B-K]O?)\b/) : null;
  const floorLetter = floorMatch && FLOORS.has(floorMatch[1]) ? floorMatch[1] : null;
  const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0;
  return {
    roomSigns: signs.filter((s) => !s.includes('?')),
    partialSigns: signs.filter((s) => s.includes('?')).map((s) => s.replace(/\?+/g, '').trim()).filter((s) => s.length >= 2),
    floorLetter,
    readText: strs(r.readText, 8),
    landmarks: strs(r.landmarks, 8).filter((l): l is LandmarkKind => (LANDMARK_KINDS as readonly string[]).includes(l)),
    fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint.replace(/\s+/g, ' ').trim().split(' ').slice(0, 60).join(' ') : '',
    confidence,
  };
}
