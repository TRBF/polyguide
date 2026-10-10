# Agent Brief — Track B: Guidance, Sensors & AI Vision

You are building the **live guidance engine** for PolyGuide, an accessible indoor-navigation web app for ETH Zürich. That means the sensors, the step-tracker state machine, the heading cues, and the camera → OpenAI vision loop. Two other agents work in parallel:
- **Track A** builds routing and the server.
- **Track C** builds the UI and voice.

Read `docs/SPEC.md` (§5, §6.3, §7) and `packages/shared/src/types.ts` first. **Do not edit `packages/shared`** unless your dev tells you to.

## You own
- `apps/server/src/ai/` — export a Hono sub-app `aiRoutes`; Track A mounts it under `/api`
- `apps/web/src/guidance/` — export `useGuidance` and everything behind it

## Core principle
**Code decides where to go; AI only perceives and phrases.** Guidance must work, degraded, with the AI switched off. AI results only confirm, correct or enrich. Never block on them.

## Deliverables, in order

### 1. `apps/server/src/ai/vision.ts` → `POST /api/vision/check`
- Input `VisionRequest`, output `VisionResponse`.
- Use the `openai` SDK with **structured output** (JSON schema mirroring `VisionResult`) and model `process.env.OPENAI_VISION_MODEL`.
- Keep the system prompt **static** so it can be cached. Put the dynamic context (step, expected landmarks, heading delta, needs, question) in the user message, alongside the image.
- Prompt rules (SPEC §5.5):
  1. Describe only; never claim a path is clear or safe.
  2. Copy room-sign text exactly into `detectedRoomNames`.
  3. `utterance` is ≤ 15 words, using left/right or clock directions.
  4. Use confidence < 0.5 and an empty utterance when unsure.
- Post-filter `utterance`: drop phrases like "clear", "safe", "no obstacles".
- 6 s timeout → `{ ok:false, reason:'timeout' }`. Measure `latencyMs`.
- **Never log or store images.**
- Off-route check: if `detectedRoomNames` has a known room that Track A's `isNearRoute()` says is not near the route, set `offRouteSuspected = true`.

### 2. `apps/server/src/ai/intent.ts` → `POST /api/intent`
Uses a small text model with a JSON schema producing an `Intent`. Include examples such as "nearest toilet", "I'm next to the main staircase", "go back".

### 3. `apps/web/src/guidance/camera.ts`
- `startCamera()` opens the rear camera (`facingMode: 'environment'`).
- `captureFrame(maxPx = 640, quality = 0.6)` returns a base64 JPEG string with no data-URL prefix.
- `stopCamera()`.

### 4. `sensors.ts`
- **Heading:**
  - iOS: `webkitCompassHeading` after `DeviceOrientationEvent.requestPermission()` (export `requestSensorPermissions()` so Track C calls it inside a click handler)
  - Android: `deviceorientationabsolute`, `(360 - alpha) % 360`
  - Circular smoothing.
  - Report `reliable: boolean` (jitter < 25°).
- **Step detector:** `devicemotion` magnitude, low-pass filter, peaks with a 0.35 s refractory period.
- **`moving`** flag from acceleration variance.
- A `/debug/sensors` component that shows the live values. Hand it to Track C for routing.

### 5. `tracker.ts`
Pure reducer implementing SPEC §5.3: `TrackerState` plus events (`step`, `tick`, `vision`, `user_next`, `user_back`, `reroute`) → new state plus effects (`speak`, `requestVision`, `requestReroute`). Unit-test it.

### 6. `heading.ts`
- `delta = normalize180(bearing - heading)`.
- Spoken heading phrases are rate-limited (SPEC §5.4).
- **Stereo audio beacon:** WebAudio oscillator → gain → `StereoPannerNode`.
  - one tick every 600 ms
  - `pan = clamp(delta/90, -1, 1)`
  - higher pitch when aligned
  - double-tick when `|delta| < 15°`
- `navigator.vibrate` on Android only.
- Expose `setBeaconEnabled`.

### 7. `vision.ts` (client)
- Triggers per SPEC §5.5.
- **Single-flight**: drop new triggers while a request is in flight, except `user_query`, which queues one.
- 640 px frames, or 1024 px for `localize`.
- Fusion rules:
  - `atExpectedPoint && confidence ≥ 0.6` → tracker `vision` event
  - off-route → `requestReroute`
  - speak the utterance only if confidence ≥ 0.6 and it isn't a near-duplicate of the last one

### 8. `useGuidance.ts`
Implement exactly the `UseGuidance` signature from `types.ts`. Wire sensors, tracker, heading, vision and reroute (`POST /api/localize` then `POST /api/route`). Emit speech through the `onSpeak` callback that Track C passes in. **Do not call `speechSynthesis` yourself**; C owns the TTS queue.

## Integration
- Track C renders your hook. Pair with Track C at about T+2:30 to swap out their mock.
- Get `isNearRoute` / `getPlaceByName` from Track A (`apps/server/src/graphStore.ts`). If they're not there yet, stub them behind the same names.

## Done when
In HG on a real phone:
- the beacon steers you onto the step bearing
- approaching a room sign advances the step
- photographing an off-route room sign triggers "Rerouting"
- with `OPENAI_API_KEY` unset, guidance still works via the pedometer and manual "Next"
