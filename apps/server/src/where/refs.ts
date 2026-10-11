/**
 * Reference library for photo matching: spots in HG captured on site by the team (survey mode), each tied to a
 * graph node. Only the camera's text fingerprint and its embedding are kept, never the photo, so nothing of the
 * people who happened to be in frame is stored. data/hg/refs.json is plain JSON and can be committed and shared.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeId } from '@polyguide/shared';
import { getOpenAI } from '../ai/openai';

const DATA_DIR = process.env.DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../data');
const REFS_PATH = resolve(DATA_DIR, 'hg', 'refs.json');
export const embedModel = () => process.env.OPENAI_EMBED_MODEL?.trim() || 'text-embedding-3-small';
/** Small vectors keep the file light; plenty for telling a few hundred spots apart. */
const DIMENSIONS = 256;
const MAX_REFS = 5000;

export interface RefEntry {
  id: string;
  nodeId: NodeId;
  levelId: string;
  /** Optional: which way the camera faced (degrees from north), when the phone knew. */
  headingDeg?: number;
  fingerprint: string;
  signs: string[];
  embedding: number[];
  source: 'survey' | 'import';
  createdAt: string;
}

let refs: RefEntry[] | null = null;

export function loadRefs(): RefEntry[] {
  if (refs) return refs;
  try {
    refs = existsSync(REFS_PATH) ? (JSON.parse(readFileSync(REFS_PATH, 'utf8')) as { refs: RefEntry[] }).refs ?? [] : [];
  } catch (err) {
    console.warn(`refs.json unreadable, starting empty: ${(err as Error).message}`);
    refs = [];
  }
  return refs;
}

export function addRef(entry: RefEntry): void {
  const all = loadRefs();
  if (all.length >= MAX_REFS) throw new Error('Reference library is full.');
  all.push(entry);
  mkdirSync(dirname(REFS_PATH), { recursive: true });
  // Write to a temp file first so a crash never leaves a half-written library.
  const tmp = `${REFS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ model: embedModel(), dimensions: DIMENSIONS, refs: all }, null, 0));
  renameSync(tmp, REFS_PATH);
}

/** Embed a fingerprint (plus the signs read, which make two spots in a long corridor different). */
export async function embed(text: string, signal?: AbortSignal): Promise<number[] | null> {
  const openai = getOpenAI();
  if (!openai || !text.trim()) return null;
  const res = await openai.embeddings.create({ model: embedModel(), input: text.slice(0, 2000), dimensions: DIMENSIONS }, { signal });
  return res.data[0]?.embedding ?? null;
}

export const fingerprintText = (fingerprint: string, signs: string[]) => (signs.length ? `Signs: ${signs.join(', ')}. ${fingerprint}` : fingerprint);

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The closest reference spots, at most one per node. */
export function nearestRefs(vector: number[], limit = 5): { ref: RefEntry; similarity: number }[] {
  const best = new Map<NodeId, { ref: RefEntry; similarity: number }>();
  for (const ref of loadRefs()) {
    const similarity = cosine(vector, ref.embedding);
    const prev = best.get(ref.nodeId);
    if (!prev || similarity > prev.similarity) best.set(ref.nodeId, { ref, similarity });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

export function refStats(): { total: number; byLevel: Record<string, number>; nodes: number } {
  const all = loadRefs();
  const byLevel: Record<string, number> = {};
  for (const r of all) byLevel[r.levelId] = (byLevel[r.levelId] ?? 0) + 1;
  return { total: all.length, byLevel, nodes: new Set(all.map((r) => r.nodeId)).size };
}
