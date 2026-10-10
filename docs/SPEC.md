# PolyGuide — Accessible Indoor Navigation for ETH Zürich

**Spec v1 · hackathon build · 5 h · 3 devs + 3 coding agents**

PolyGuide is a mobile web app (PWA) that guides people through ETH buildings on a route that fits their needs. It works fully by voice or fully by screen. It uses ETH's own PolyMaps routing network, a profile-aware A* router, step-by-step instructions generated from the route geometry, and a camera + AI check that confirms where the user is and puts guidance into natural speech.

---

## 1. Goals, non-goals, demo

### Goals (must ship)
1. **Profile-aware routing** inside one multi-floor building (**HG**). Profiles: `wheelchair`, `blind` / `lowVision`, default. Profiles can be combined.
2. **Two equivalent interfaces.** Every action is available by voice and by touch. A blind user never needs to look at the screen. A deaf or non-speaking user never needs to talk or listen.
3. **Turn-by-turn guidance** while walking:
   - compass heading cue (visual arrow + stereo audio beacon)
   - step progress estimate
   - **camera + AI confirmation** of landmarks (room signs, elevators, stairs)
   - re-localization from a room sign when the user is lost
4. **Start-point localization without beacons**: the user picks or says a room, or scans a room sign. GPS is used only outdoors.

### Non-goals (explicitly out of scope today)
- Obstacle detection or collision avoidance. **The app supplements a cane or guide dog. It does not replace them.** This must be stated in onboarding and in the voice intro.
- BLE beacon positioning. PolyMaps uses BLE beacons indoors, but browsers can't scan them (and iOS not at all).
- Campus-wide coverage, accounts, persistence, and an offline mode beyond a cached graph.

### Designed-for extensions (architecture must allow; UI shows as "coming soon")
- `lowStamina`: prefer routes with seating; cap the distance between rest points.
- `avoidCrowds`: time-dependent crowd weights per edge.

Both plug in as **cost modifiers** (§4.3). The algorithm does not change.

### Demo scenario (decide at T+0, verify room names in PolyMaps)
Two routes inside HG, run once with each profile:
- **A — Wheelchair:** HG main entrance → a lecture hall one or two floors up (e.g. Audimax **HG F 30**). The route must use an elevator. Show the default profile choosing stairs for contrast.
- **B — Blind, voice only:** with the screen locked or covered, the user says "Take me to HG E …". The app gives audio turns, the camera confirms a room sign on the way, and the user says "Where am I?" mid-route.

---

## 2. Data source — ETH PolyMaps ArcGIS REST (public, undocumented)

Base: `https://arcgis-prd-web.ethz.ch/server/rest/services/EGDB/`. Max **2000 records per request** → page with `resultOffset` + `resultRecordCount`. `f=geojson` is supported. Coordinates are Web Mercator by default. Add `outSR=4326&returnZ=true` to get lat/lon plus elevation.

> ⚠️ This API is undocumented and can change; the dated routing service name shows it has changed before. **Never call it at runtime.** Download everything once with `scripts/fetch-eth.ts` and commit the results to `data/hg/`. Email polymaps@ethz.ch if this goes beyond the hackathon.

| Use | Service / layer | Key fields |
|---|---|---|
| **Edges (horizontal)** | `EGDB_Public_Network/FeatureServer/2` **Pathways_Public** (polyline Z) | `PATHWAY_TYPE`, `LEVEL_ID` (e.g. `ETH.HG.E`), `VERTICAL_ORDER`, `LENGTH_3D`, `TRAVEL_DIRECTION`, `PATHWAY_RANK`, `LOCATION` (0 indoor / 1 outdoor), `EMERGENCY`, `FACILITY_ID`, `DELAY` |
| **Edges (vertical)** | `EGDB_Public_Network/FeatureServer/1` **Transitions_Public** (polyline Z) | `TRANSITION_TYPE`, `LEVEL_NAME_FROM/TO`, `VERTICAL_ORDER_FROM/TO`, `LENGTH_3D`, `TRAVEL_DIRECTION`, `EMERGENCY`, `FACILITY_ID` (**no** `LEVEL_ID` → filter spatially) |
| Junctions | `EGDB_Public_Network/FeatureServer/0` | Not needed. Nodes are derived from line endpoints and vertices. |
| Entrances / landmarks | `EGDB_Public_Network/FeatureServer/3` **Landmarks_Public** (point) | `DESCRIPTION` (German, e.g. "Haupteingang CAB E"), `LEVEL_ID`, `VERTICAL_ORDER` |
| Rooms (destinations + sign matching) | `Units/FeatureServer/3` | `UNIT_ID` (e.g. `ETH.HG.F.F_053.4`), `NAME` (e.g. `HG F 53.4`), `Gebäude`, `Geschoss`, `RaumNr`, `USE_TYPE`/`RaumTyp`, `LEVEL_ID` |
| Floors | `Levels/FeatureServer` | Inspect at T+0 for name and vertical order |
| POIs (toilets, cafés…) | `PointsOfInterest/FeatureServer` | Inspect at T+0 |
| **Reference router / escape hatch** | `Hosted_Public_Network/NAServer/Route` | Travel modes: `Walking` (id 1), **`Wheelchair` (id 2)**, `Buggy`, `Bus`. Impedance `WalkTime`. Directions in `en`/`de`, style `NA Campus`. |

**`PATHWAY_TYPE` / `TRANSITION_TYPE` domain** → our `EdgeKind`:

| code | ETH name | `EdgeKind` |
|---|---|---|
| 1 | Hallway / Sidewalk | `hallway` |
| 2 | Stairs / Curb | `stairs` |
| 3 | Ramp / Curb Ramp | `ramp` |
| 4 | Elevator / Wheelchair Lift | `elevator` |
| 5 | Escalator | `escalator` |
| 6 | Moving Walkway | `moving_walkway` |
| 7 | Entrance / Exit | `entrance` |
| 8 | Lasten (freight lift) | `freight_lift` (always excluded) |
| 9 | E-Link (shuttle bus) | `shuttle` (excluded today) |
| 10 | Steep Sidewalk | `steep` |

`TRAVEL_DIRECTION`: 1 both, 2 from→to only, 3 to→from only. `EMERGENCY = 1` → exclude.

**Filtering to HG.** Pathways: `where=LEVEL_ID LIKE 'ETH.HG.%'`. Transitions: compute the bbox of HG pathways, expand it by 15 m, and query with `geometry=<envelope>&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects`. Then keep only transitions whose endpoints snap to HG nodes. Rooms: `where=NAME LIKE 'HG %'`. Sanity-check the `FACILITY_ID` values at T+0.

**Known data gaps** (document them in the UI; the overrides file handles them):
- No door widths, door types, or automatic-door flags.
- No live elevator status.
- No seating data.

`data/overrides.json` lets the team manually mark or close edges, add seating nodes, or mark a heavy door (§4.4).

---

## 3. Architecture

```
pnpm monorepo (TypeScript everywhere)
├─ packages/shared      contracts: types.ts, api.ts, fixtures (owned jointly, additive changes only)
├─ packages/routing     pure TS: buildGraph(), astar(), profiles, instructions  (no I/O → unit-testable)
├─ apps/server          Hono on Node 20: REST API, loads data/hg/*.json at boot, OpenAI calls
├─ apps/web             Vite + React + TS PWA: UI, voice, map, guidance engine, sensors, camera
├─ scripts/fetch-eth.ts one-off downloader → data/hg/{pathways,transitions,units,landmarks,levels,pois}.geojson
└─ data/hg/             committed snapshot + graph.json (built) + overrides.json
```

- **Why server-side routing:** one source of truth, keeps the OpenAI key server-side, and the graph is small enough to load in memory. `packages/routing` has no I/O, so it can also run in the browser later for offline use.
- **HTTPS is mandatory.** Camera, motion/orientation sensors, wake lock and mic all need a secure context. Use `@vitejs/plugin-basic-ssl` plus `vite --host`, or a `cloudflared`/`ngrok` tunnel. Vite proxies `/api` → `http://localhost:8787`, so there is one origin with no CORS or mixed-content issues.
- **Env:** `OPENAI_API_KEY`, `OPENAI_VISION_MODEL` (the fastest vision-capable model on your account; prefer a small/"mini" tier for latency), `OPENAI_TEXT_MODEL`, `USE_MOCK=1` (serves fixtures), `PORT=8787`.
- **Libraries:**
  - routing: none needed; write a ~60-line binary heap
  - map: `leaflet` + `react-leaflet` drawing GeoJSON on a plain background (no basemap tiles indoors)
  - search: `fuse.js`
  - API calls: `openai` (Responses API with JSON-schema structured output)
  - validation: `zod`

---

## 4. Routing

### 4.1 Graph build (`packages/routing/src/build.ts`, run by `pnpm build:graph`)
1. Read pathways and transitions as GeoJSON in EPSG:4326 with Z.
2. **Project** each vertex to local metric ENU around an origin (HG centroid) with an equirectangular projection: `x = (lon-lon0)·cos(lat0)·111320`, `y = (lat-lat0)·110540`, `z = elevation`.
   - Don't use Web Mercator meters: at Zürich's latitude they are about 1.48× too long.
3. **Nodes** = every polyline vertex, merged by quantized key `round(x/0.25), round(y/0.25), round(z/1.0)`. The 1 m z bucket keeps floors apart. Transition endpoints land on pathway vertices on each floor by design (ArcGIS Indoors requires it). Log any transition endpoint that fails to merge.
4. **Edges** = consecutive vertex pairs of each polyline. They inherit the feature's attributes. `lengthM` = 3D Euclidean length of the segment. Scale it so the feature's segments sum to `LENGTH_3D` when that value is sane (≠ 9999).
5. **Node attributes:**
   - `levelId`, from the pathway `LEVEL_ID`; transitions inherit it from their endpoints
   - `verticalOrder`
   - `degree`
   - `isDecisionPoint` (degree ≥ 3, or the angle between in/out edges is > 30°)
6. Drop `EMERGENCY=1`, `freight_lift`, `shuttle`.
7. Keep the **largest connected component** and log the sizes of the others.
8. Write `data/hg/graph.json` (`GraphJson` in shared types).
9. **Places:**
   - **Rooms:** each room gets an `id`, `name`, `levelId`, centroid, `useType`, and `nodeId`. `nodeId` is the nearest graph node on the same `levelId`, preferring nodes within 3 m of the room polygon boundary, which approximates the door.
   - **Landmarks:** entrances become places of kind `entrance`.
   - **POIs:** become places of kind `poi`.
   - `aliases` for each place: `"HG F 30"`, `"F 30"`, `"F30"`, `"HGF30"`, `"Audimax"` (from POI names when present), all lowercased.

**Validation (required before Sync 1):** for 5 random room pairs, compare our default-profile distance with `NAServer/Route/solve` (travel mode `Walking`). Accept within ±15 %.

### 4.2 Search: A* (`astar.ts`)
- State = node id. Cost unit = **seconds**.
- `g(e) = profile.edgeCost(edge, ctx)`; `Infinity` means forbidden.
- Heuristic `h(n) = euclid3D(n, goal) / maxSpeedOfProfile`. This is admissible because every cost is at least `length / speed`.
- Binary-heap open set. Graph size is in the low thousands of edges, so a query takes well under 50 ms.
- Respect `oneway`.
- Return the node path, the edge path, and the total cost.
- **No route** → `RouteResult { ok:false, reason:'no_route' }`. The UI then says why, for example "No step-free route found between these rooms. The nearest step-free alternative is …" (stretch).

### 4.3 Profiles = composable cost modifiers (`profiles.ts`)
`edgeCost = baseTime(edge, speed) × Π multipliers + Σ fixed penalties`. Any modifier returning `Infinity` wins.

| Need | Effect |
|---|---|
| *(base)* | speed 1.3 m/s; elevator = 25 s wait + 3 s/floor; stairs = length/0.5 m/s |
| `wheelchair` | speed 1.0 m/s; **stairs, escalator, steep = ∞**; ramp ×1.2; entrance ×1.0 (no door data → warning); prefer rank 1 paths (rank 2 ×1.1, rank 3 ×1.3) |
| `blind` / `lowVision` | speed 0.9 m/s; escalator & moving walkway = ∞; stairs allowed but ×1.5 (`blind`); **+6 s per decision point** (fewer, simpler turns); outdoor edges ×1.3; prefer rank 1 paths strongly (rank 3 ×1.6) |
| `lowStamina` *(stub)* | speed 0.8 m/s; stairs ×3; **+penalty proportional to distance from the nearest seating node** (seating comes from `overrides.json` `seats[]`) |
| `avoidCrowds` *(stub)* | `× crowdFactor(edgeId, now)` from `data/hg/crowd.json` (hourly weights; default 1.0) |
| user override | `avoidStairs:true` turns stairs into ∞ for anyone (temporary injury, carrying luggage) |

Combined needs use the slowest speed, the product of multipliers, and the sum of penalties. `RouteResult.profileSummary` lists human-readable guarantees, for example "No stairs", "Uses 1 elevator", "2 doors, widths unknown".

### 4.4 Overrides (`data/overrides.json`)
```json
{ "closedEdges": ["e_123"], "edgeMultipliers": {"e_456": 2.0},
  "notes": {"e_789": "heavy manual door"},
  "seats": [{"lat":0,"lon":0,"levelId":"ETH.HG.E","label":"Bench by main hall"}] }
```
The server applies this at load time. This is also how you demo "elevator out of service → reroute".

### 4.5 Instruction generation (`instructions.ts`, deterministic, no AI)
1. Walk the edge path and **collapse** consecutive edges where the kind and level are unchanged and the turn angle is < 25°.
2. Classify each turn by the signed angle between the incoming and outgoing bearing:

   | angle | maneuver |
   |---|---|
   | < 25° | `straight` |
   | 25–60° | `slight_left` / `slight_right` |
   | 60–135° | `left` / `right` |
   | > 135° | `sharp_left` / `sharp_right` |
   | 180° ± 20 | `u_turn` |
3. Vertical edges become `take_elevator` / `take_stairs_up|down` / `take_ramp_up|down`, using `toLevelId`. An `entrance` edge becomes `enter_building` / `exit_building`.
4. `arrive` gets a `side` computed from the cross product of the last heading and the vector to the room centroid.
5. **Expected landmarks** per step: rooms whose `nodeId` lies within 6 m of the step's polyline (with left/right side), plus elevators, stairs and entrances on the step. These feed the vision check and give richer cues ("You'll pass rooms F 33 and F 35 on your right").
6. Two strings per step:
   - `text` (screen): "Turn left, then go 24 m to the elevator"
   - `speech` (TTS-safe): "Turn left. Then go about 25 metres to the elevator." Rules: no abbreviations; distances rounded to 5 m; floors spoken as "floor F"; room "HG F 30" spoken as "room H G, F thirty".
7. Each step carries `bearingDeg`, the compass bearing from north of its first segment. Guidance uses it as the heading target.

### 4.6 Localization (`POST /api/localize`)
- `roomText` (from voice, typing or OCR): normalize (uppercase, strip spaces/dots), then fuzzy match against aliases. Return the place, its node and a confidence.
- `lat/lon/accuracyM`: only if accuracy < 20 m. Snap to the nearest **outdoor** node (`indoor=false`); indoors, GPS is ignored.
- `levelHint` narrows the matches.

---

## 5. Guidance & AI (camera)

### 5.1 Principle
**Code decides where to go; AI only perceives and phrases.** The route and steps are deterministic. The AI answers three questions: what can it see, does that match what we expect here, and what's the shortest helpful sentence? Guidance never waits for the AI. The AI only confirms, corrects, or enriches.

### 5.2 Sensors (client, `apps/web/src/guidance/sensors.ts`)
- **Heading:**
  - iOS: `DeviceOrientationEvent.requestPermission()` inside a user gesture, then `event.webkitCompassHeading`
  - Android: `deviceorientationabsolute`, then `heading = (360 - alpha) % 360`
  - Smooth with a circular moving average over about 300 ms.
  - Indoor magnetic interference is real. Show a "compass unreliable" state if heading jitter is > 25°, and let vision corrections dominate.
- **Steps:** `devicemotion` acceleration magnitude, low-pass filtered, peak detection with a 0.35 s refractory period. Step length 0.7 m, configurable in settings.
  - Wheelchair: no step signal. Estimate progress as `moving ? elapsed × 1.0 m/s : 0`, where moving = accelerometer variance above a threshold, or rely on vision/manual confirmation.
- **GPS:** `watchPosition` only while the current step is outdoor.
- **Wake lock:** `navigator.wakeLock.request('screen')` during navigation.

### 5.3 Step tracker (state machine, `guidance/tracker.ts`)
`idle → localizing → navigating(stepIndex, progressM) → approaching → (advance) → … → arrived`

| From | Trigger | To |
|---|---|---|
| `navigating` | `progressM ≥ 0.8 × step.distanceM` or `≥ distance - 4 m` | `approaching` (fires vision check `approaching_node`) |
| `approaching` | vision `atExpectedPoint && confidence ≥ 0.6`, OR user says "next" / taps Next, OR `progressM ≥ 1.3 × distanceM` (auto-advance with "I think you've reached …, say 'back' if not") | next step |
| any | vision `offRouteSuspected` with a recognized room name | `localizing` → `/api/localize` → `/api/route` from the new node ("Rerouting") |
| vertical step (elevator/stairs) | user says "done" / taps, or vision sees the target floor label | next step |

### 5.4 Heading cue (both modalities)
- `delta = normalize180(step.bearingDeg - heading)`
- **Visual:** a large arrow rotated by `delta`, plus distance remaining and the next maneuver.
- **Audio beacon:** a short tick every 600 ms through WebAudio `StereoPannerNode`. `pan = clamp(delta/90, -1, 1)`. Pitch rises as `|delta| → 0`, and a double-tick means you are on course (`|delta| < 15°`). This lets a blind user "turn until the sound is centred" with no words needed.
- **Speech** only on change: "Turn left" when `|delta| > 45°` for more than 1.5 s; "Straight ahead" once when the user re-aligns. Rate-limit to one heading phrase per 4 s.
- **Haptics:** `navigator.vibrate` on Android (short = on course, long = turn). iOS has no web vibration; ignore it there.

### 5.5 Vision loop (client `guidance/vision.ts` → server `POST /api/vision/check`)
Event-driven, not a fixed 5 s timer:

| Trigger | When |
|---|---|
| `approaching_node` | tracker enters `approaching` |
| `off_heading` | `|delta| > 60°` for more than 3 s while moving |
| `user_query` | "Where am I?", "What's ahead?", or a tap on the camera button |
| `periodic` | every 4 s **only while moving** and remaining distance on the step < 20 m |
| `localize` | "Scan sign" button or command at start / when lost |

- **Never more than one request in flight.** Drop new triggers while busy, except `user_query`, which queues one.
- **Frame:** rear camera (`facingMode: 'environment'`), drawn to a canvas at **640 px** on the longest side, JPEG quality 0.6 (≈ 40–70 KB). For `localize`, use **1024 px** so small sign text stays readable.
- **Server:** one OpenAI call with a structured JSON schema (`VisionResult` minus `latencyMs`). The prompt includes:
  - the current step text
  - expected landmarks with sides
  - current level
  - the next maneuver
  - heading delta
  - the user's needs
  - the user question, if any

  Keep the system prompt static so it can be prompt-cached. Timeout 6 s; on timeout return `{ok:false}` and the client stays silent.
- **Prompt rules** (enforce in the system prompt and post-filter):
  1. Never say a path is clear or safe. Describe only ("I can see a closed glass door ahead").
  2. Report room-sign text exactly as read, in `detectedRoomNames`.
  3. `utterance` ≤ 15 words, in plain language, using clock directions or left/right.
  4. If unsure, set confidence < 0.5 and give an empty utterance.
- **Client fusion:**
  - `atExpectedPoint` → advance.
  - `detectedRoomNames` contains a room that is **not** on or near the route → off-route → re-localize.
  - Speak `utterance` only when confidence ≥ 0.6 and it isn't a near-duplicate of the last spoken line.
- **Privacy:** frames are not stored or logged server-side. Say so in onboarding.
- *Stretch:* a streaming/realtime multimodal session instead of request/response, if latency proves to be the bottleneck. Not in the 5 h scope.

### 5.6 Voice intents (`POST /api/intent`, plus a client fast path)
The client regex fast path handles: `next`, `back`/`previous`, `repeat`, `stop`, `where am i`, `what's ahead`, `help`, `navigate to X` / `take me to X`, `I'm at X`. Anything else goes to `/api/intent` (a small text model with a JSON schema → `Intent`), e.g. "nearest accessible toilet", "I'm next to the big staircase".

---

## 6. Frontend

### 6.1 Screens
1. **Welcome / Needs:**
   - big toggles: Wheelchair · Blind · Low vision · *Low stamina (soon)* · *Avoid crowds (soon)* · Avoid stairs
   - "Voice-first mode" (default on if Blind is selected)
   - speech rate
   - language (EN; DE stretch)
   - safety notice (spoken in voice-first mode)
   - Stored in `localStorage` (wrap access in try/catch).
2. **Where are you?** Room search (Fuse), "Scan a room sign" (camera), "Use GPS" (outdoor only), or voice "I'm at …".
3. **Where to?** Search rooms and POIs; voice "Take me to …"; recent destinations.
4. **Route preview:**
   - summary (distance, time, `profileSummary` chips such as "No stairs ✓" and "1 elevator")
   - step list
   - floor-by-floor map with a floor switcher
   - "Start"
5. **Navigate:**
   - full-width arrow
   - the current instruction in ≥ 28 px type
   - distance remaining and next maneuver
   - small camera preview with a "camera checking…" indicator
   - bottom bar of ≥ 64 px buttons: **Repeat · Next · Where am I? · Stop**
   - A microphone button is always visible; in voice-first mode it's the whole lower half of the screen.
6. **Arrived:** "You've arrived. Room F 30 is on your right." Then: new destination.

### 6.2 Accessibility requirements (acceptance criteria)
- Every control is a real `<button>` or `<input>` with a label. The full flow is operable with VoiceOver/TalkBack. No information is conveyed by color alone.
- The current instruction lives in an `aria-live="assertive"` region.
  - Setting "Speak with app voice" (default on). When the user runs a screen reader, they can turn it off so the screen reader announces the instruction instead of hearing it twice.
- WCAG AA contrast; respects `prefers-reduced-motion`; supports 200 % zoom; dark mode.
- Voice-first mode: after "Start", the app speaks the safety notice, then "Say where you are going." Every screen announces itself and the available commands on entry ("Say 'help' for options").
- Permissions are requested in **one** explicit "Enable camera, motion and microphone" step behind a user gesture (an iOS requirement), with a spoken explanation.

### 6.3 Voice I/O
- **TTS:** `speechSynthesis`, with a queue that has priorities. Instruction > vision utterance > heading phrase. Interrupt on new instruction.
- **STT:** OpenAI speech to text via `POST /api/stt` when the server has a key (`OPENAI_STT_MODEL`, default `gpt-4o-mini-transcribe`). The phone records the mic (`MediaRecorder`), detects the start and end of each command from the audio level and uploads only speech; the server drops Whisper's inventions on silence. Works on any browser that can record, including iOS Safari and Firefox.
  - Fallback: `webkitSpeechRecognition` / `SpeechRecognition` when there is no key or no recording support; `localStorage['polyguide.stt'] = 'browser'` forces it. If neither exists, show a large text field and keep push-to-talk hidden.
  - Hands-free listening pauses while the app speaks (Android mutes speech while the mic is open, and it avoids hearing itself).

---

## 7. API (server, all JSON; types in `packages/shared/src/types.ts`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | – | `{ok, graph:{nodes,edges}, mock:boolean}` |
| GET | `/api/levels` | – | `Level[]` |
| GET | `/api/places` | `q`, `limit`, `kind?` | `Place[]` (fuzzy) |
| GET | `/api/map/:levelId` | – | `FeatureCollection` (room polygons + pathways for drawing) |
| POST | `/api/route` | `RouteRequest` | `RouteResult` |
| POST | `/api/localize` | `LocalizeRequest` | `LocalizeResult` |
| POST | `/api/vision/check` | `VisionRequest` | `VisionResponse` |
| POST | `/api/intent` | `IntentRequest` | `Intent` |
| GET | `/api/dev/compare` | `from`,`to`,`mode` | ours vs ETH NAServer (dev only) |

With `USE_MOCK=1`, every endpoint serves `packages/shared/src/fixtures.ts`, so the frontend is never blocked.

### ETH NAServer escape hatch
`GET .../Hosted_Public_Network/NAServer/Route/solve`, with:
- `stops`: JSON features with `{x,y,z}` in 3857
- `travelMode`: the full JSON of the `Wheelchair` or `Walking` object from the service description
- `returnDirections=true`
- `directionsLanguage=en`
- `directionsStyleName=NA Campus`
- `outSR=4326`
- `f=json`

Verify the exact parameter shapes at T+0:30. Quirk: ETH's `Walking` mode prohibits elevators.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Graph has broken connectivity (snapping) | Component report + NAServer comparison at Sync 1. If still broken at T+2:15 → **switch `/api/route` to proxy the NAServer** (Wheelchair/Walking modes) and convert its directions into `RouteStep`s. |
| Compass unusable indoors | Audio beacon + vision `relativeDirection` corrections + "turn until the tick is centred" UX; show reliability state. |
| Vision latency 2–5 s | Never blocking; small frames; small model; one in flight; approach-triggered rather than continuous. |
| iOS Safari: no vibrate, partial STT, gesture-gated sensors | Test on one iPhone and one Android **by T+1:30**. Typed-input fallback. Single permission gesture. |
| HTTPS on phones | Set up the tunnel at T+0 and share one URL. |
| ETH API changes | Committed snapshot in `data/hg/`. |
| Over-trust by blind users | Safety notice; descriptive-only AI prompt rules; no "path is clear" language. |
| Demo-day connectivity | Record a backup screen + voice video of each scenario at T+4:15. |
