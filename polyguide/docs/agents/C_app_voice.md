# Agent Brief — Track C: App, Voice & Accessibility

You are building the **PWA front end** for PolyGuide, an accessible indoor-navigation web app for ETH Zürich: screens, map, voice input/output, and accessibility. Two other agents work in parallel:
- **Track A** builds routing and the server API.
- **Track B** builds the guidance engine hook `useGuidance`.

Read `docs/SPEC.md` (§1, §6, §7) and `packages/shared/src/types.ts` first. **Do not edit `packages/shared`** unless your dev tells you to.

## You own
Everything in `apps/web/` **except** `apps/web/src/guidance/`, which belongs to Track B.

## Hard requirements (judged in the demo)
- **Every action works by voice alone and by touch alone.** A blind user never needs the screen. A deaf or non-speaking user never needs audio or speech.
- Real `<button>`/`<input>` elements with labels; the full flow works with VoiceOver and TalkBack.
- The current instruction lives in `aria-live="assertive"`.
- WCAG AA contrast, ≥ 64 px primary buttons, ≥ 28 px instruction text, 200 % zoom-safe, `prefers-reduced-motion`, dark mode.
- No information is conveyed by color alone.
- The safety notice ("This app supplements your cane or guide dog. It does not detect obstacles.") is shown and spoken during onboarding.

## Setup
- Vite + React + TS.
- `@vitejs/plugin-basic-ssl`, server `host: true`, proxy `/api` → `http://localhost:8787`.
- A PWA manifest is enough; skip offline caching.
- `react-router` for screens. `leaflet` + `react-leaflet` for the map, with **no basemap tiles** (draw GeoJSON on a plain background). `fuse.js` for client-side filtering.
- Typed API client in `src/api.ts` using the types from `@polyguide/shared`.
- **Start against `USE_MOCK=1`** on Track A's server, or import `fixtures.ts` directly until the server is up.

## Deliverables, in order

### 1. Screens (SPEC §6.1)
- Needs
- Where are you?
- Where to?
- Route preview
- Navigate
- Arrived
- Settings: speech rate, "speak with app voice", beacon on/off, step length

Persist `Profile` and settings to `localStorage`, wrapped in try/catch.

### 2. TTS queue (`src/voice/tts.ts`)
- `speechSynthesis` with priorities `instruction > vision > heading > info`.
- A new instruction interrupts the current speech.
- No speaking when "speak with app voice" is off; the aria-live region still updates.
- Expose `speak(text, priority)`. **This is the `onSpeak` you pass into Track B's `useGuidance`.**

### 3. STT + commands (`src/voice/stt.ts`, `src/voice/commands.ts`)
- Feature-detect `SpeechRecognition` / `webkitSpeechRecognition`.
- Push-to-talk button, always visible; in voice-first mode it fills the lower half of the screen.
- Continuous listening during navigation where supported.
- Regex fast path for:
  - next / back / repeat / stop / help
  - where am I / what's ahead
  - take me to X / navigate to X
  - I'm at X
- Anything else goes to `POST /api/intent`.
- If STT is unavailable, show a large text box that accepts the same commands.

### 4. Voice-first mode
- Default on when Blind is selected.
- Each screen announces itself and its commands on entry.
- "Help" lists the commands.
- Destination disambiguation by voice: "I found 3 matches: F 30 Audimax, F 31, F 33. Say the number."

### 5. Permissions step
One "Enable camera, motion and microphone" button. In its click handler, call Track B's `requestSensorPermissions()`, `getUserMedia` (audio + video, then stop the tracks), and the wake lock. Explain each permission in text and speech.

### 6. Navigate screen
- Calls `useGuidance(route, profile, { onSpeak })`.
- **Until Track B lands, use your own `useGuidanceMock`** with the same signature, which steps through the fixture on Next.
- Big arrow rotated by `headingDeltaDeg`, or "compass unreliable" when not reliable.
- Instruction, distance remaining, next maneuver.
- Small camera preview showing the "checking…" state.
- Buttons: Repeat · Next · Where am I? · Stop.

### 7. Route preview + map
- `profileSummary` chips and the step list (accessible on its own).
- Floor switcher drawing `/api/map/:levelId` room polygons plus the route polyline for that level.

### 8. Scan a room sign
Camera capture → `POST /api/vision/check` with `trigger:'localize'` → take `detectedRoomNames[0]` → `POST /api/localize` → confirm by voice and on screen.

### 9. Coming soon
"Low stamina" and "Avoid crowds" toggles are shown as disabled, with a one-line explainer.

## Done when
On an iPhone and an Android phone via the HTTPS tunnel, demo route B completes with the screen covered (voice only), and demo route A completes with touch only and sound muted.
