/**
 * POST /api/vision/locate-room: which room is the user in? Compares one camera frame with ETH Room Information
 * photos (data/hg/room-photos, snapshot by scripts/fetch-room-photos.ts) of a few candidate rooms, chosen by
 * the position estimate (floor, distance) and the room type the voice agent saw. Only teaching, meeting and
 * exhibition rooms have photos; corridors are localized by signs instead.
 * Privacy: the frame is forwarded to the model and dropped, never logged or stored.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import type { LocateRoomResponse, RoomCandidate } from '@polyguide/shared';
import { dist2D } from '@polyguide/routing';
import { getGraph, getPlace, normRoom } from '../graphStore';
import { classifyError, describeError, getOpenAI, reasoningEffort, visionModel, withTimeout } from './openai';

const DATA_DIR = process.env.DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../data');
const PHOTO_DIR = resolve(DATA_DIR, 'hg/room-photos');
const TIMEOUT_MS = 12_000;
const MAX_CANDIDATES = 6;
const PHOTOS_PER_ROOM = 2;
/** Without a position to rank by: every room of the type (or floor), one photo each. */
const MAX_CANDIDATES_WIDE = 20;
const MAX_IMAGE_CHARS = 3_000_000;

interface IndexEntry {
  name: string;
  type: string;
  seats: number | null;
  seating: string;
  floorShape: string;
  floorAreaM2: number | null;
  heightM: number | null;
  photos: string[];
}

interface PhotoRoom extends IndexEntry {
  levelId: string;
  floor: string;
  lat: number;
  lon: number;
  /** The routing place to hand to set_position: the room itself, or the nearest place (foyer exhibition spaces). */
  placeName: string;
}

let rooms: PhotoRoom[] | null = null;

type UnitGeometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Mean of the outer rings' vertices (foyer spaces are often MultiPolygons). */
function centroid(geometry: UnitGeometry): { lat: number; lon: number } {
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((poly) => poly[0]);
  let lat = 0;
  let lon = 0;
  let n = 0;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      lon += x;
      lat += y;
      n++;
    }
  }
  return { lat: lat / n, lon: lon / n };
}

/** Index entries with photos, each placed on the map: the graph place of that name, else the floor-plan unit. */
export function photoRooms(): PhotoRoom[] {
  if (rooms) return rooms;
  const indexPath = resolve(PHOTO_DIR, 'index.json');
  if (!existsSync(indexPath)) return (rooms = []);
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { rooms: IndexEntry[] };
  const g = getGraph();
  const byNorm = new Map(g.places.filter((p) => p.kind === 'room').map((p) => [normRoom(p.name), p]));
  const unitsPath = resolve(DATA_DIR, 'hg/units.geojson');
  const units = existsSync(unitsPath)
    ? (JSON.parse(readFileSync(unitsPath, 'utf8')) as { features: { geometry: UnitGeometry | null; properties: { NAME?: string; LEVEL_ID?: string } }[] }).features
    : [];
  const unitByNorm = new Map(units.filter((u) => u.properties.NAME && u.geometry).map((u) => [normRoom(u.properties.NAME!), u]));
  rooms = [];
  for (const e of index.rooms) {
    if (!e.photos.length) continue;
    const place = byNorm.get(normRoom(e.name));
    if (place) {
      rooms.push({ ...e, levelId: place.levelId, floor: place.levelId.split('.').at(-1)!, lat: place.lat, lon: place.lon, placeName: place.name });
      continue;
    }
    const unit = unitByNorm.get(normRoom(e.name));
    if (!unit?.geometry || !unit.properties.LEVEL_ID) continue;
    const c = centroid(unit.geometry);
    const levelId = unit.properties.LEVEL_ID;
    // A room or entrance to localize to; an elevator or toilet next to a foyer is not where the user is.
    const nearPlace = g.places.filter((p) => p.levelId === levelId && (p.kind === 'room' || p.kind === 'entrance')).sort((a, b) => dist2D(g.xy(a), g.xy(c)) - dist2D(g.xy(b), g.xy(c)))[0];
    rooms.push({ ...e, levelId, floor: levelId.split('.').at(-1)!, ...c, placeName: nearPlace?.name ?? e.name });
  }
  console.log(`room photos: ${rooms.length} rooms with ETH photos`);
  return rooms;
}

const TYPES = ['Lecture hall', 'Seminars / Courses', 'Computer', 'Meeting room', 'Exhibition space', 'Multipurpose room'] as const;

const requestSchema = z.object({
  imageJpegBase64: z.string().min(100).max(MAX_IMAGE_CHARS),
  /** Where the user probably is (any of these narrows the candidates). */
  placeId: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  levelId: z.string().optional(),
  /** What the agent saw: an ETH room type. */
  roomType: z.enum(TYPES).optional(),
  /** Explicit candidate room names, e.g. ["HG F 30", "HG E 7"]. */
  candidates: z.array(z.string()).max(10).optional(),
});

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['inside_a_room', 'scores', 'reason'],
  properties: {
    inside_a_room: { type: 'boolean', description: 'false if the photo shows a corridor, staircase, foyer outside these rooms, or nothing recognisable.' },
    scores: {
      type: 'array',
      description: 'One entry per candidate room, in the order given.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['room', 'score'],
        properties: {
          room: { type: 'string', description: 'Candidate name as given.' },
          score: { type: 'integer', description: '0-100: how sure the photo was taken in this room. Score high only for features this room has and the others lack (windows, wall panels, ceiling, room shape, board layout). Same furniture alone is not evidence: ETH rooms of one type share furniture.' },
        },
      },
    },
    reason: { type: 'string', description: 'At most 20 words: what decided it.' },
  },
} as const;

const modelOut = z.object({ inside_a_room: z.boolean(), scores: z.array(z.object({ room: z.string(), score: z.number() })), reason: z.string() });

/**
 * Confidence from the scores, not the model's self-report: the best room's score, scaled down when the
 * runner-up is close (look-alike rooms). A gap of MARGIN_FULL points or more keeps the full score.
 */
const MARGIN_FULL = 25;
const MIN_SCORE = 50;
export function scoreConfidence(best: number, second: number): number {
  if (best < MIN_SCORE) return 0;
  return Math.round((best / 100) * Math.min(1, Math.max(0, best - second) / MARGIN_FULL) * 100) / 100;
}

/**
 * Twin rooms: same type, seating and floor shape, same height (±0.4 m) and floor area within 15%. ETH built many
 * of these in pairs (HG E 1.1 / E 1.2, D 1.1 / D 1.2, the D seminar rooms); photos alone cannot tell them apart.
 */
export function lookAlike(a: Pick<IndexEntry, 'type' | 'seating' | 'floorShape' | 'heightM' | 'floorAreaM2'>, b: typeof a): boolean {
  if (a.type !== b.type || a.seating !== b.seating || a.floorShape !== b.floorShape) return false;
  if (a.heightM != null && b.heightM != null && Math.abs(a.heightM - b.heightM) > 0.4) return false;
  if (a.floorAreaM2 && b.floorAreaM2 && Math.abs(a.floorAreaM2 - b.floorAreaM2) / Math.max(a.floorAreaM2, b.floorAreaM2) > 0.15) return false;
  return true;
}
const MAX_CONFIDENCE_WITH_TWIN = 0.5;

/** Candidate rooms: given names, else by type and/or floor, nearest first. */
export function chooseCandidates(req: Pick<z.infer<typeof requestSchema>, 'placeId' | 'lat' | 'lon' | 'levelId' | 'roomType' | 'candidates'>): PhotoRoom[] {
  const all = photoRooms();
  if (req.candidates?.length) {
    const wanted = new Set(req.candidates.map(normRoom));
    const picked = all.filter((r) => wanted.has(normRoom(r.name)) || [...wanted].some((w) => normRoom(r.name).endsWith(w)));
    if (picked.length) return picked.slice(0, MAX_CANDIDATES);
  }
  const place = req.placeId ? getPlace(req.placeId) : undefined;
  const levelId = place?.levelId ?? req.levelId;
  const point = place ?? (req.lat != null && req.lon != null ? { lat: req.lat, lon: req.lon } : undefined);
  let pool = all.filter((r) => !req.roomType || r.type === req.roomType);
  if (levelId && pool.some((r) => r.levelId === levelId)) pool = pool.filter((r) => r.levelId === levelId);
  if (point) {
    const g = getGraph();
    const here = g.xy(point);
    pool = [...pool].sort((a, b) => dist2D(here, g.xy(a)) - dist2D(here, g.xy(b)));
  }
  // Nothing to rank by: compare with more rooms, one photo each, rather than an arbitrary few.
  return pool.slice(0, point ? MAX_CANDIDATES : MAX_CANDIDATES_WIDE);
}

function photoDataUrl(file: string): string | null {
  const path = resolve(PHOTO_DIR, file);
  return existsSync(path) ? `data:image/jpeg;base64,${readFileSync(path).toString('base64')}` : null;
}

const describe = (r: PhotoRoom) =>
  `${r.name}: ${r.type}${r.seats ? `, ${r.seats} seats` : ''}${r.seating ? `, ${r.seating} seating` : ''}${r.floorShape ? `, ${r.floorShape} floor` : ''}${r.heightM ? `, ${r.heightM} m high` : ''}, floor ${r.floor}`;

export const locateRoomRoutes = new Hono();

locateRoomRoutes.post('/vision/locate-room', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json<LocateRoomResponse>({ ok: false, reason: 'invalid_request', message: parsed.error.issues.map((i) => i.path.join('.') || 'body').join(', ') }, 400);
  const req = parsed.data;
  const openai = getOpenAI();
  if (!openai) return c.json<LocateRoomResponse>({ ok: false, reason: 'disabled', message: 'OPENAI_API_KEY is not set.' });
  const candidates = chooseCandidates(req);
  if (!candidates.length) return c.json<LocateRoomResponse>({ ok: false, reason: 'no_candidates', message: 'No room with ETH photos matches that floor or type.' });

  const content: ({ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'low' | 'high' })[] = [
    { type: 'input_text', text: 'Photo from the user\'s phone camera, just now:' },
    { type: 'input_image', image_url: `data:image/jpeg;base64,${req.imageJpegBase64}`, detail: 'high' },
    { type: 'input_text', text: 'Reference photos from ETH Room Information of the candidate rooms (taken from other spots in each room, often empty):' },
  ];
  for (const r of candidates) {
    content.push({ type: 'input_text', text: describe(r) });
    for (const f of r.photos.slice(0, candidates.length > MAX_CANDIDATES ? 1 : PHOTOS_PER_ROOM)) {
      const url = photoDataUrl(f);
      if (url) content.push({ type: 'input_image', image_url: url, detail: 'low' });
    }
  }

  const t0 = performance.now();
  let aborted = false;
  try {
    const response = await withTimeout(TIMEOUT_MS, (signal) => {
      signal.addEventListener('abort', () => (aborted = true), { once: true });
      return openai.responses.create(
        {
          model: visionModel(),
          instructions: 'You localize a person inside the ETH Zürich main building. Decide which candidate room, if any, the user\'s photo was taken in, by comparing distinctive features with the reference photos: seating rows and colour, wall panels, windows, ceiling, lights, boards, screens, floor shape. People, angle and lighting differ. If the photo is a corridor or does not clearly match one room, say so with low confidence. Never guess a room that was not offered.',
          input: [{ role: 'user', content }],
          text: { format: { type: 'json_schema', name: 'room_match', schema: JSON_SCHEMA, strict: true } },
          reasoning: reasoningEffort(),
          store: false,
        },
        { signal },
      );
    });
    const out = modelOut.safeParse(JSON.parse(response.output_text));
    if (!out.success) return c.json<LocateRoomResponse>({ ok: false, reason: 'model_error', message: 'Unexpected model output.' });
    const m = out.data;
    const ranked = m.scores
      .map((x) => ({ room: candidates.find((r) => normRoom(r.name) === normRoom(x.room)), score: Math.max(0, Math.min(100, x.score)) }))
      .filter((x): x is { room: PhotoRoom; score: number } => Boolean(x.room))
      .sort((a, b) => b.score - a.score);
    const [first, second] = ranked;
    const scored = first && m.inside_a_room ? scoreConfidence(first.score, second?.score ?? 0) : 0;
    const hit = scored > 0 ? first.room : undefined;
    // A twin on offer means the photo cannot decide: say which rooms it could be, and let the door number settle it.
    const twins = hit ? candidates.filter((r) => r !== hit && lookAlike(hit, r)) : [];
    const confidence = twins.length ? Math.min(scored, MAX_CONFIDENCE_WITH_TWIN) : scored;
    const runnerUp = hit ? second?.room : undefined;
    const latencyMs = Math.round(performance.now() - t0);
    const toCandidate = (r: PhotoRoom): RoomCandidate => ({ name: r.name, type: r.type, floor: r.floor, placeName: r.placeName });
    console.log(`locate-room ${latencyMs} ms candidates=[${candidates.map((r) => r.name).join(', ')}] scores=[${ranked.map((x) => `${x.room.name}:${x.score}`).join(', ')}] conf=${confidence}${twins.length ? ` twins=[${twins.map((r) => r.name).join(', ')}]` : ''}`);
    return c.json<LocateRoomResponse>({
      ok: true,
      insideRoom: m.inside_a_room,
      match: hit ? toCandidate(hit) : null,
      confidence,
      runnerUp: runnerUp ? toCandidate(runnerUp) : null,
      lookAlikes: twins.map(toCandidate),
      reason: m.reason.split(/\s+/).slice(0, 25).join(' '),
      candidates: candidates.map(toCandidate),
      latencyMs,
    });
  } catch (err) {
    const { reason, message } = classifyError(err, aborted);
    console.warn(`locate-room failed after ${Math.round(performance.now() - t0)} ms: ${reason} (${describeError(err)})`);
    return c.json<LocateRoomResponse>({ ok: false, reason, message });
  }
});
