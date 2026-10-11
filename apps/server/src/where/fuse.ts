/**
 * Fusing the evidence for "where am I" into one graph node (pure, unit-tested).
 *
 * Evidence, strongest first: a room sign read in full; a match with a reference photo captured on site; a
 * partial sign; a floor letter; the kinds of landmark in view. Every candidate is then weighed by how far the
 * user would have had to walk from where the route (or the user) says they are, so a sign misread as a room on
 * another floor across the building does not beat the plausible one next door. With no evidence at all, the
 * prior wins: the person and the route are trusted over an unreadable photo.
 */
import type { NodeId } from '@polyguide/shared';

export type EvidenceKind = 'sign' | 'photo' | 'partial_sign' | 'landmark' | 'route';

export interface Candidate {
  nodeId: NodeId;
  levelId: string;
  score: number;
  evidence: { kind: EvidenceKind; detail: string; weight: number }[];
}

export interface FuseInput {
  signs: { nodeId: NodeId; levelId: string; label: string; confidence: number }[];
  partialSigns: { nodeId: NodeId; levelId: string; label: string; confidence: number }[];
  photos: { nodeId: NodeId; levelId: string; similarity: number; refId: string }[];
  /** Nodes near the prior that carry a landmark kind seen in the photo. */
  landmarks: { nodeId: NodeId; levelId: string; kind: string }[];
  floorLevelId: string | null;
  /** Walking metres from the prior to each node (only nodes within reach). */
  prior: { nodeId: NodeId; levelId: string; distances: Map<NodeId, number> } | null;
}

export interface FuseResult {
  best: Candidate | null;
  /** 0..1: how much better the best is than the alternatives, and how strong its own evidence is. */
  confidence: number;
  method: EvidenceKind;
  alternatives: Candidate[];
}

/** Metres over which the prior's support halves: people rarely are 100 m from where the route thinks. */
const PRIOR_SCALE_M = 60;
/** Reference fingerprints closer than this cosine similarity are not evidence. */
export const PHOTO_MIN_SIMILARITY = 0.55;

export function fuse(input: FuseInput): FuseResult {
  const byNode = new Map<NodeId, Candidate>();
  const add = (nodeId: NodeId, levelId: string, kind: EvidenceKind, detail: string, weight: number) => {
    const c = byNode.get(nodeId) ?? { nodeId, levelId, score: 0, evidence: [] };
    c.score += weight;
    c.evidence.push({ kind, detail, weight: +weight.toFixed(2) });
    byNode.set(nodeId, c);
  };

  for (const s of input.signs) add(s.nodeId, s.levelId, 'sign', s.label, 3 * s.confidence);
  for (const s of input.partialSigns) add(s.nodeId, s.levelId, 'partial_sign', s.label, 1.2 * s.confidence);
  for (const p of input.photos) {
    if (p.similarity < PHOTO_MIN_SIMILARITY) continue;
    add(p.nodeId, p.levelId, 'photo', p.refId, 2.5 * ((p.similarity - PHOTO_MIN_SIMILARITY) / (1 - PHOTO_MIN_SIMILARITY)));
  }
  for (const l of input.landmarks) add(l.nodeId, l.levelId, 'landmark', l.kind, 0.4);
  if (input.prior) add(input.prior.nodeId, input.prior.levelId, 'route', 'where the route puts you', 0.35);

  const scored = [...byNode.values()].map((c) => {
    let s = c.score;
    if (input.floorLevelId) s *= c.levelId === input.floorLevelId ? 1.3 : 0.6;
    if (input.prior) {
      const d = input.prior.distances.get(c.nodeId);
      // Out of reach (far, or another wing): still possible if the user is lost, but strongly discounted.
      s *= d == null ? 0.25 : 0.4 + 0.6 * Math.pow(0.5, d / PRIOR_SCALE_M);
    }
    return { ...c, score: +s.toFixed(3) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0] ?? null;
  if (!best) return { best: null, confidence: 0, method: 'route', alternatives: [] };
  const second = scored[1]?.score ?? 0;
  const margin = best.score / (best.score + second);
  const strength = Math.min(1, best.score / 2.5);
  const top = [...best.evidence].sort((a, b) => b.weight - a.weight)[0];
  return { best, confidence: +(0.5 * margin + 0.5 * strength).toFixed(2), method: top?.kind ?? 'route', alternatives: scored.slice(1, 4) };
}
