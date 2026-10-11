/**
 * Two witnesses for big jumps. One camera frame may move the user a little (a sign next to where we thought they
 * were simply sharpens the estimate), but it may never on its own move them far or onto another floor: a misread
 * sign would otherwise yank a blind user's route across the building. A big jump is held until a second,
 * independent witness agrees: another frame read a moment later, the route itself reaching that floor (stairs or
 * an elevator step), or the user saying yes. The user's own word is always a witness and passes at once.
 */

export type FixSource = 'sign' | 'photo' | 'where' | 'user' | 'route';

export interface GatePoint {
  lat: number;
  lon: number;
  levelId: string;
  /** Spoken name, e.g. "HG F 41". */
  label: string;
  /** The place and graph node behind it, so a confirmed jump can be acted on. */
  placeId?: string;
  nodeId?: string;
}

export interface GateCurrent {
  lat: number;
  lon: number;
  levelId: string;
  /** How sure the app is of where the user is; with none, anything goes. */
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export type GateDecision =
  | { action: 'accept'; reason: 'user' | 'small_move' | 'no_estimate' | 'second_witness' | 'route_floor' | 'altimeter' | 'confirmed' }
  | { action: 'hold'; question: string; jumpM: number; floorChange: boolean };

/** Within this, one good reading may move the user (same floor). */
export const SMALL_JUMP_M = 20;
/** A second reading this close to the held one confirms it. */
const AGREE_M = 12;
/** …but it must be a different moment, not the same frame twice. */
const MIN_GAP_MS = 1500;
/** A held jump nobody confirmed is forgotten after this. */
const PENDING_TTL_MS = 90_000;

const floorOf = (levelId: string) => levelId.split('.').at(-1) ?? levelId;

/** Local metres between two lat/lon points (small distances, equirectangular is plenty). */
export function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((b.lon - a.lon) * 111_320 * k, (b.lat - a.lat) * 110_540);
}

export class JumpGate {
  private pending: { point: GatePoint; source: FixSource; at: number }[] = [];

  /**
   * Should this fix move the user? `routeLevels`: floors the current route legitimately reaches right now (the
   * level of the step and where its stairs/elevator lead), so a floor change the route predicts is not suspicious.
   */
  /**
   * `floorWitness`: the floor the altimeter is confident about (elevator ride, stairs, GPS altitude). A reading on
   * that floor has its floor confirmed by an independent sensor; one on another floor does not.
   */
  decide(point: GatePoint, source: FixSource, current: GateCurrent | null, routeLevels: string[] = [], now = Date.now(), floorWitness: string | null = null): GateDecision {
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS);
    if (source === 'user') {
      this.pending = [];
      return { action: 'accept', reason: 'user' };
    }
    if (!current || current.confidence === 'none') return this.accept('no_estimate');
    const jumpM = metresBetween(current, point);
    const floorChange = point.levelId !== current.levelId;
    const routePredictsFloor = floorChange && routeLevels.includes(point.levelId);
    if (!floorChange && jumpM <= SMALL_JUMP_M) return this.accept('small_move');
    if (routePredictsFloor && jumpM <= SMALL_JUMP_M * 2) return this.accept('route_floor');
    // The altimeter measured the user onto this floor: the camera's floor is the second witness's floor.
    if (floorWitness && point.levelId === floorWitness && jumpM <= SMALL_JUMP_M * 2) return this.accept('altimeter');

    const witness = this.pending.find((p) => p.point.levelId === point.levelId && metresBetween(p.point, point) <= AGREE_M && now - p.at >= MIN_GAP_MS);
    if (witness) return this.accept('second_witness');

    this.pending = [...this.pending.slice(-2), { point, source, at: now }];
    const question = floorChange
      ? `I read ${point.label}, which is on floor ${floorOf(point.levelId)}, but you were on floor ${floorOf(current.levelId)}. Are you on floor ${floorOf(point.levelId)} now?`
      : `I read ${point.label}, about ${Math.round(jumpM / 5) * 5} metres from where I thought you were. Are you near ${point.label}?`;
    return { action: 'hold', question, jumpM: Math.round(jumpM), floorChange };
  }

  /** The user said yes to the held question: the most recent held fix, now confirmed (or null). */
  confirm(now = Date.now()): GatePoint | null {
    const latest = this.pending.filter((p) => now - p.at < PENDING_TTL_MS).at(-1);
    this.pending = [];
    return latest?.point ?? null;
  }

  /** The user said no, or navigation ended. */
  clear(): void {
    this.pending = [];
  }

  get holding(): boolean {
    return this.pending.length > 0;
  }

  private accept(reason: Extract<GateDecision, { action: 'accept' }>['reason']): GateDecision {
    this.pending = [];
    return { action: 'accept', reason };
  }
}

/** One gate for the whole app: a sign read by the engine and a later "where am I" can confirm each other. */
export const positionGate = new JumpGate();
