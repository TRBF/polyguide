/**
 * PolyGuide shared contracts — the single source of truth between tracks A, B and C.
 * Rule: ADDITIVE CHANGES ONLY after kickoff. Announce in team chat before merging any change here.
 * See docs/SPEC.md for semantics.
 */

/* ───────────────────────────── Basics ───────────────────────────── */

/** ETH level id, e.g. "ETH.HG.E" (building HG, floor E). */
export type LevelId = string;
export type NodeId = string;
export type EdgeId = string;
export type PlaceId = string;
export type RouteId = string;

export interface LatLon {
  lat: number;
  lon: number;
}

/* ───────────────────────────── Profiles ─────────────────────────── */

export type Need =
  | 'wheelchair'
  | 'blind'
  | 'lowVision'
  | 'lowStamina' // stub today (SPEC §4.3)
  | 'avoidCrowds'; // stub today (SPEC §4.3)

export interface Profile {
  needs: Need[];
  /** Force stairs = forbidden for anyone (temporary injury, luggage…). */
  avoidStairs?: boolean;
  /**
   * Nodes where the user found an elevator out of service ("the elevator is not working").
   * The whole elevator shaft through each node is avoided. Additive (after kickoff).
   */
  avoidElevatorAt?: NodeId[];
  /** Override the profile's default walking speed (m/s). */
  speedMps?: number;
  /** Step length used by the pedometer (m). Default 0.7. */
  stepLengthM?: number;
  language?: 'en' | 'de';
}

/* ───────────────────────────── Graph ────────────────────────────── */

/** Mapped from ETH PATHWAY_TYPE / TRANSITION_TYPE codes (see ETH_TYPE_TO_KIND). */
export type EdgeKind =
  | 'hallway'
  | 'stairs'
  | 'ramp'
  | 'elevator'
  | 'escalator'
  | 'moving_walkway'
  | 'entrance'
  | 'freight_lift'
  | 'shuttle'
  | 'steep';

export const ETH_TYPE_TO_KIND: Record<number, EdgeKind> = {
  1: 'hallway',
  2: 'stairs',
  3: 'ramp',
  4: 'elevator',
  5: 'escalator',
  6: 'moving_walkway',
  7: 'entrance',
  8: 'freight_lift',
  9: 'shuttle',
  10: 'steep',
};

export interface GraphNode extends LatLon {
  id: NodeId;
  /** Local ENU metres around GraphJson.origin (NOT Web Mercator). */
  x: number;
  y: number;
  /** Elevation in metres. */
  z: number;
  levelId: LevelId | null;
  verticalOrder: number | null;
  degree: number;
  isDecisionPoint: boolean;
  indoor: boolean;
  /** A doorway (ETH door transition collapsed onto this node). Additive. */
  door?: boolean;
}

export interface GraphEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  lengthM: number;
  /** 'forward' = only from→to; 'backward' = only to→from. */
  oneway: 'both' | 'forward' | 'backward';
  rank: 1 | 2 | 3;
  indoor: boolean;
  levelFrom: LevelId | null;
  levelTo: LevelId | null;
  source: 'pathway' | 'transition';
  /** OBJECTID in the ETH layer, for debugging. */
  sourceOid: number;
  /**
   * Not in ETH's routing network but inferred from its floor plans (e.g. an elevator shaft present on every floor
   * without transitions). Routes using it warn the user to verify on site. Additive.
   */
  synthetic?: boolean;
}

export interface GraphJson {
  builtAt: string; // ISO
  dataSnapshotAt: string; // ISO, when fetch-eth ran
  facility: string; // "HG"
  origin: LatLon; // ENU origin
  nodes: GraphNode[];
  edges: GraphEdge[];
  places: Place[];
  levels: Level[];
}

/** Context passed to cost modifiers (time-dependent weights, etc.). */
export interface CostContext {
  now: Date;
  /** Previous edge on the path, if any (allows turn-aware penalties later). */
  prevEdge?: GraphEdge;
  toNode: GraphNode;
}

/** One composable modifier per Need. Return Infinity to forbid. */
export interface CostModifier {
  need: Need | 'base' | 'avoidStairs';
  speedMps?: number;
  multiplier?(edge: GraphEdge, ctx: CostContext): number; // ≥ 1 or Infinity
  penaltyS?(edge: GraphEdge, ctx: CostContext): number; // ≥ 0 or Infinity
}

export interface Overrides {
  closedEdges: EdgeId[];
  edgeMultipliers: Record<EdgeId, number>;
  notes: Record<EdgeId, string>;
  seats: (LatLon & { levelId: LevelId; label: string })[];
}

/* ───────────────────────────── Places ───────────────────────────── */

export type PlaceKind = 'room' | 'poi' | 'entrance' | 'landmark' | 'seat';

export interface Place extends LatLon {
  id: PlaceId;
  /** Display name, e.g. "HG F 30". */
  name: string;
  /** Optional friendly name, e.g. "Audimax". */
  label?: string;
  kind: PlaceKind;
  levelId: LevelId;
  verticalOrder: number | null;
  /** Graph node used for routing to/from this place. */
  nodeId: NodeId;
  useType?: string;
  /** Lowercased search aliases: "hg f 30", "f 30", "f30", "hgf30", "audimax". */
  aliases: string[];
}

export interface Level {
  id: LevelId; // "ETH.HG.F"
  name: string; // "F"
  verticalOrder: number;
  facility: string; // "HG"
}

/* ───────────────────────────── Routing API ──────────────────────── */

export type LocationRef =
  | { type: 'place'; placeId: PlaceId }
  | { type: 'node'; nodeId: NodeId }
  | { type: 'coord'; lat: number; lon: number; levelId?: LevelId };

export interface RouteRequest {
  from: LocationRef;
  to: LocationRef;
  profile: Profile;
}

export type Maneuver =
  | 'depart'
  | 'straight'
  | 'slight_left'
  | 'slight_right'
  | 'left'
  | 'right'
  | 'sharp_left'
  | 'sharp_right'
  | 'u_turn'
  | 'take_elevator'
  | 'take_stairs_up'
  | 'take_stairs_down'
  | 'take_ramp_up'
  | 'take_ramp_down'
  | 'take_escalator'
  | 'enter_building'
  | 'exit_building'
  | 'arrive';

export type Side = 'left' | 'right' | 'ahead';

export interface ExpectedLandmark {
  /** What a camera might read or see, e.g. "HG F 33", "elevator". */
  label: string;
  kind: 'room_sign' | 'elevator' | 'stairs' | 'entrance' | 'poi' | 'other';
  side?: Side;
  /** Distance from the start of the step (m). */
  atDistanceM: number;
  placeId?: PlaceId;
}

export interface RouteStep {
  index: number;
  maneuver: Maneuver;
  /** On-screen text, e.g. "Turn left, then go 24 m to the elevator". */
  text: string;
  /** TTS-safe text, no abbreviations, distances rounded to 5 m (SPEC §4.5). */
  speech: string;
  distanceM: number;
  durationS: number;
  /** Compass bearing (0 = north, clockwise) of the step's first segment; null for vertical steps. */
  bearingDeg: number | null;
  levelId: LevelId;
  /** Only for vertical maneuvers. */
  toLevelId?: LevelId;
  startNodeId: NodeId;
  endNodeId: NodeId;
  /** [lon, lat] pairs (GeoJSON order). */
  polyline: [number, number][];
  expectedLandmarks: ExpectedLandmark[];
  /** For 'arrive': which side the destination is on. */
  side?: Side;
  edgeKinds: EdgeKind[];
}

export type RouteResult =
  | {
      ok: true;
      routeId: RouteId;
      from: Place | { name: string; nodeId: NodeId; levelId: LevelId };
      to: Place;
      profile: Profile;
      /** Human-readable guarantees, e.g. ["No stairs", "Uses 1 elevator"]. */
      profileSummary: string[];
      totalDistanceM: number;
      totalDurationS: number;
      levels: LevelId[];
      steps: RouteStep[];
      warnings: string[];
      /** 'own' = our A*; 'eth' = NAServer escape hatch. */
      engine: 'own' | 'eth';
    }
  | {
      ok: false;
      reason: 'no_route' | 'unknown_place' | 'invalid_request' | 'server_error';
      message: string;
    };

/* ───────────────────────────── Localization ─────────────────────── */

export interface LocalizeRequest {
  /** From voice, typed text or OCR ("HG E 41", "e41"). */
  roomText?: string;
  lat?: number;
  lon?: number;
  accuracyM?: number;
  levelHint?: LevelId;
}

export type LocalizeResult =
  | {
      ok: true;
      place?: Place;
      nodeId: NodeId;
      levelId: LevelId;
      confidence: number; // 0..1
      method: 'room_text' | 'gps';
      /** Other plausible matches for voice disambiguation. */
      alternatives: Place[];
    }
  | { ok: false; reason: 'no_match' | 'gps_inaccurate' | 'indoor_gps_ignored'; message: string };

/* ───────────────────────────── Vision API ───────────────────────── */

export type VisionTrigger = 'approaching_node' | 'off_heading' | 'user_query' | 'periodic' | 'localize';

export interface VisionRequest {
  /** Base64 JPEG without data-URL prefix. 640px (1024px for 'localize'). */
  imageJpegBase64: string;
  trigger: VisionTrigger;
  routeId?: RouteId;
  stepIndex?: number;
  /** Subset of the current step the prompt needs. */
  step?: Pick<RouteStep, 'text' | 'maneuver' | 'levelId' | 'toLevelId' | 'expectedLandmarks' | 'distanceM'>;
  nextStepText?: string;
  headingDeltaDeg?: number | null;
  needs: Need[];
  userQuestion?: string;
  language?: 'en' | 'de';
}

export type RelativeDirection = 'left' | 'right' | 'ahead' | 'behind' | 'unknown';

export interface VisionResult {
  sceneSummary: string;
  /** All legible text, verbatim. */
  readText: string[];
  /** Room-sign names as read, e.g. ["HG F 33"]. */
  detectedRoomNames: string[];
  seen: { label: string; matchesExpected: boolean; relativeDirection: RelativeDirection }[];
  atExpectedPoint: boolean;
  offRouteSuspected: boolean;
  /** Descriptive only ("closed glass door ahead"). Never "path is clear". */
  notableThings: string[];
  /** ≤ 15 words; empty if unsure. */
  utterance: string;
  confidence: number; // 0..1
  latencyMs: number;
}

export type VisionResponse =
  | ({ ok: true } & VisionResult)
  | { ok: false; reason: 'timeout' | 'model_error' | 'rate_limited' | 'disabled'; message: string };

/* ───────────────────────────── Voice intents ────────────────────── */

export type IntentType =
  | 'navigate_to'
  | 'set_location'
  | 'where_am_i'
  | 'whats_ahead'
  | 'repeat'
  | 'next'
  | 'back'
  | 'stop'
  | 'help'
  | 'choose_option'
  | 'unknown';

export interface Intent {
  type: IntentType;
  /** Destination/location text for navigate_to / set_location, e.g. "HG F 30" or "nearest toilet". */
  target?: string;
  /** For choose_option ("number two"). */
  option?: number;
  source: 'regex' | 'llm';
}

export interface IntentRequest {
  utterance: string;
  screen: 'needs' | 'start' | 'destination' | 'preview' | 'navigate' | 'arrived' | 'settings';
  language?: 'en' | 'de';
}

/* ───────────────────── Voice agent (POST /api/agent). Additive. ───────────────────── */

/** What the agent decided the user wants. The client executes it; the agent never routes on its own. */
export type AgentAction =
  | 'set_trip' // from and/or to named → propose, ask "is that right?"
  | 'confirm' // yes to the pending proposal → start
  | 'reject' // no → ask again
  | 'choose_option' // "the second one"
  | 'set_needs' // "I'm blind", "I use a wheelchair", "no stairs"
  | 'start' | 'next' | 'back' | 'repeat' | 'stop'
  | 'where_am_i' | 'whats_ahead'
  | 'emergency' | 'elevator_broken'
  | 'slower' | 'faster' | 'settings' | 'help'
  | 'none'; // small talk, or nothing to do: just speak the reply

export interface AgentContext {
  phase: 'trip' | 'confirm' | 'ready' | 'navigate' | 'arrived';
  from?: { id: PlaceId; name: string };
  to?: { id: PlaceId; name: string };
  /** Options read out to the user, numbered from 1. */
  options?: { id: PlaceId; name: string }[];
  needs: Need[];
  avoidStairs?: boolean;
  /** Current instruction while navigating. */
  step?: string;
  /** While navigating: a node on the current step, so "I'm at the elevator" resolves to the one nearby. */
  nearNodeId?: NodeId;
}

export interface AgentRequest {
  utterance: string;
  context: AgentContext;
  language?: 'en' | 'de';
}

export type AgentResponse =
  | {
      ok: true;
      action: AgentAction;
      /** One or two short sentences to speak and show. */
      reply: string;
      /** set_trip: places the agent resolved (either may be missing → ask for it). */
      from?: Place;
      to?: Place;
      /** set_trip with an ambiguous name: candidates to choose from (numbered in `reply`). */
      options?: Place[];
      /** Which side `options` are for. */
      optionsFor?: 'from' | 'to';
      option?: number;
      needs?: { add: (Need | 'avoidStairs')[]; remove: (Need | 'avoidStairs')[] };
      latencyMs: number;
    }
  | { ok: false; reason: 'disabled' | 'timeout' | 'model_error' | 'rate_limited' | 'invalid_request'; message: string };

/* ───────────────────────────── Guidance hook (B → C seam) ───────── */

export type TrackerPhase = 'idle' | 'localizing' | 'navigating' | 'approaching' | 'rerouting' | 'arrived';

export type SpeechPriority = 'instruction' | 'vision' | 'heading' | 'info';

export interface GuidanceState {
  phase: TrackerPhase;
  route: Extract<RouteResult, { ok: true }> | null;
  stepIndex: number;
  currentStep: RouteStep | null;
  nextStep: RouteStep | null;
  /** Estimated metres walked along the current step. */
  progressM: number;
  remainingStepM: number;
  remainingTotalM: number;
  headingDeg: number | null;
  /** normalize180(step.bearing - heading); null if no heading or vertical step. */
  headingDeltaDeg: number | null;
  compassReliable: boolean;
  moving: boolean;
  visionBusy: boolean;
  lastVision: VisionResult | null;
  /** Last line spoken/shown, for the aria-live region and "repeat". */
  lastAnnouncement: string;
  error: string | null;
}

export interface GuidanceActions {
  start(): void;
  stop(): void;
  next(): void;
  back(): void;
  repeat(): void;
  whereAmI(): void;
  whatsAhead(): void;
  /** Camera check for the current step (no-op unless navigating). */
  checkStep(): void;
  setBeaconEnabled(on: boolean): void;
}

export interface GuidanceOptions {
  /** Track C's TTS queue. Track B must NOT call speechSynthesis directly. */
  onSpeak: (text: string, priority: SpeechPriority) => void;
  /** Called when the tracker obtains a new route after rerouting. */
  onRouteChange?: (route: Extract<RouteResult, { ok: true }>) => void;
  visionEnabled?: boolean;
  beaconEnabled?: boolean;
}

/** Signature implemented by Track B (`useGuidance`) and mocked by Track C (`useGuidanceMock`). */
export type UseGuidance = (
  route: Extract<RouteResult, { ok: true }> | null,
  profile: Profile,
  options: GuidanceOptions,
) => GuidanceState & GuidanceActions;

/* ───────────────────────────── Misc API ─────────────────────────── */

export interface HealthResponse {
  ok: boolean;
  mock: boolean;
  graph: { nodes: number; edges: number; places: number; dataSnapshotAt: string | null };
}

export const API = {
  health: '/api/health',
  levels: '/api/levels',
  places: '/api/places', // ?q=&limit=&kind=
  map: (levelId: LevelId) => `/api/map/${encodeURIComponent(levelId)}`,
  route: '/api/route',
  localize: '/api/localize',
  vision: '/api/vision/check',
  intent: '/api/intent',
  agent: '/api/agent',
  where: '/api/where',
  refs: '/api/refs',
  devCompare: '/api/dev/compare',
} as const;

/* ───────────── Where am I (camera + graph localization) ───────────── */

export interface WhereRequest {
  /** A camera frame (base64 JPEG, no data-URL prefix). Optional: without it the answer comes from the prior. */
  imageJpegBase64?: string;
  /** Where the route (or the user) last put them: weighs candidates by walking distance from here. */
  nearNodeId?: NodeId;
  /** While navigating: the answer says whether the spot is on this route. */
  routeId?: RouteId;
  language?: 'en' | 'de';
}

export type WhereEvidence = 'sign' | 'photo' | 'partial_sign' | 'landmark' | 'route';

export type WhereResponse =
  | {
      ok: true;
      nodeId: NodeId;
      levelId: LevelId;
      /** The room or place the description is anchored on: usable as a trip's starting point. */
      place?: Place;
      /** One or two spoken sentences: "You are on floor F, near HG F 30, the Audimax. The elevator is …". */
      description: string;
      confidence: number;
      method: WhereEvidence;
      /** What was read or recognised, for the screen ("Read: HG F 33.2"). */
      evidence: string[];
      /** With routeId: false = clearly away from the route (reroute), null = unknown. */
      onRoute?: boolean | null;
      latencyMs: number;
    }
  | { ok: false; reason: 'no_evidence' | 'disabled' | 'timeout' | 'model_error' | 'rate_limited' | 'invalid_request'; message: string };

export interface RefCaptureRequest {
  imageJpegBase64: string;
  /** The spot being captured: a graph node, or a place (its node is used). */
  nodeId?: NodeId;
  placeId?: PlaceId;
  headingDeg?: number;
}

export type RefCaptureResponse =
  | { ok: true; id: string; nodeId: NodeId; levelId: LevelId; signs: string[]; fingerprint: string; total: number }
  | { ok: false; reason: 'disabled' | 'unauthorized' | 'invalid_request' | 'model_error' | 'timeout' | 'rate_limited'; message: string };

export const ETH_ARCGIS_BASE = 'https://arcgis-prd-web.ethz.ch/server/rest/services/EGDB';
