# PolyGuide — 5-hour Dev Plan (3 devs × 3 agents)

Times are relative to kickoff (**T+0**). With a 15:45 start the absolute times are shown in brackets. Shift them if you start later.

## Roles

Each dev owns one track and drives one coding agent. Paste the matching brief from `docs/agents/` as the agent's first message, together with `docs/SPEC.md` and `packages/shared/src/types.ts`.

| Track | Dev | Agent brief | Owns (only this track edits these paths) |
|---|---|---|---|
| **A — Data & Routing** | Dev 1 | `agents/A_data_routing.md` | `scripts/`, `data/`, `packages/routing/`, `apps/server/` **except** `apps/server/src/ai/` |
| **B — Guidance & AI** | Dev 2 | `agents/B_guidance_ai.md` | `apps/server/src/ai/`, `apps/web/src/guidance/` |
| **C — App, Voice & A11y** | Dev 3 | `agents/C_app_voice.md` | everything else in `apps/web/` |
| Shared | all | — | `packages/shared/` — **additive changes only**, announce in chat before merging |

Disjoint paths mean everyone commits to `main` with `git pull --rebase` before each push, about every 30 min. No long-lived branches.

### Integration seams (how the tracks plug together)
- **A → C:** HTTP API in SPEC §7. Typed by `packages/shared`. Mockable with `USE_MOCK=1`.
- **B → C:** a React hook. C renders it and B implements it:
  ```ts
  useGuidance(route: RouteResult | null, profile: Profile) → GuidanceState & GuidanceActions
  ```
  Both are defined in `types.ts`. Until B lands, C uses `useGuidanceMock` (C writes it in 10 min: it steps through fixture steps on "Next").
- **B → A:** B's server routes mount on A's Hono app via `app.route('/api', aiRoutes)`. A exposes `getPlaceByName()` and `getRouteNodeIds()` helpers so B's vision prompt can include landmarks and off-route checks.

---

## Timeline

### Phase 0 · T+0:00–0:25 · Kickoff (humans, all together) [15:45–16:10]
- [ ] Dev 1 scaffolds the monorepo:
  - `pnpm init` workspaces
  - `apps/web` (Vite React TS)
  - `apps/server` (Hono + tsx)
  - `packages/shared`, `packages/routing`
  - root `tsconfig.base.json`
  - copy in `docs/` and `packages/shared/src/*` from this kit
  - push
- [ ] Dev 2: OpenAI key in `apps/server/.env` (never committed). Pick `OPENAI_VISION_MODEL` with one 640 px test image → note its latency.
- [ ] Dev 3: HTTPS tunnel (`cloudflared tunnel --url https://localhost:5173` or `ngrok`) and confirm the camera opens on **one iPhone and one Android** via the tunnel URL.
- [ ] All: open PolyMaps and pick the **two demo routes** (SPEC §1). Write the exact room names into `docs/DEMO.md`.
- [ ] All: read `types.ts` together for 5 minutes. Changes now are free; later they cost three people.

### Phase 1 · T+0:25–1:30 · Build against mocks [16:10–17:15]
| A | B | C |
|---|---|---|
| `fetch-eth.ts` (paging, outSR 4326, returnZ) → `data/hg/*.geojson`; inspect Levels/POIs fields | Server `ai/vision.ts`: `/api/vision/check` with JSON-schema output, timeout, no logging of images | Screens 1–6 skeleton with router; Needs screen + localStorage; design tokens (high contrast, large type) |
| `build.ts`: projection, node merge, edges, components report → `graph.json` | Server `ai/intent.ts`: `/api/intent` | Destination & start search (`/api/places` mock), route preview with step list |
| `astar.ts` + binary heap + unit test on a toy graph | Client `sensors.ts`: heading (iOS + Android), step detector, motion state; debug overlay page `/debug/sensors` | TTS queue with priorities; STT push-to-talk + regex fast path → `Intent` |
| Server boot: load graph; `/api/health`, `/api/levels`, `/api/places`; `USE_MOCK` switch | Client `camera.ts`: rear camera stream, `captureFrame(px)` → base64 JPEG | Navigate screen with `useGuidanceMock`; aria-live region; big buttons |

**🔁 Sync 1 · T+1:30 [17:15] (15 min standup + merge)**. Exit criteria:
- [ ] A: real `/api/route` returns a result for a wheelchair route on HG with an elevator in it, and a default route with stairs. The component report is posted in chat.
- [ ] B: `/api/vision/check` returns valid `VisionResult` for a photo of an HG room sign within 4 s.
- [ ] C: the full screen flow works on a phone with mocks. The voice "take me to …" parses.
- [ ] Phone test of sensors on iOS + Android. Decide the fallbacks now.

### Phase 2 · T+1:45–3:00 · Real data + guidance engine [17:30–18:45]
| A | B | C |
|---|---|---|
| `profiles.ts` (all rows of SPEC §4.3, stubs included) + `overrides.json` loader | `tracker.ts` state machine (SPEC §5.3) | Map view: `/api/map/:levelId` polygons + route polyline per level, floor switcher |
| `instructions.ts`: collapse, turn classes, vertical maneuvers, arrive side, expected landmarks, `speech` strings | `heading.ts` cue + **stereo audio beacon** | Swap `useGuidanceMock` → B's `useGuidance` (pair with B for 15 min at ~T+2:30) |
| `/api/localize`; NAServer `/api/dev/compare` for 5 pairs | `vision.ts` client: triggers, single-flight, fusion → advance / off-route | Permission onboarding step (one gesture: camera, motion, mic, wake lock) + voice-first mode announcements |
| Expose `getPlaceByName`, `isNearRoute` helpers to B | `useGuidance` hook wiring sensors + tracker + vision + TTS events | "Scan a room sign" UI → `/api/vision/check` with `trigger: 'localize'` → `/api/localize` |

**Decision gate at T+2:15:** if A's graph still disconnects HG floors, switch `/api/route` to the **NAServer proxy** (SPEC §8). Do not debug the graph past this point.

**🔁 Sync 2 · T+3:00 [18:45] — Walk test in HG (everyone, 20 min, real phones).** Walk demo route A with the wheelchair profile and demo route B voice-only with the screen covered. Write every issue into `docs/ISSUES.md` with an owner.

### Phase 3 · T+3:20–4:15 · Fix & polish [19:05–20:00]
Priority order. Stop at the first track-level blocker.
1. Anything that breaks either demo route (all tracks).
2. Rerouting from an off-route sign (B + A).
3. Voice-only flow polish: every screen announces itself, "help" lists commands (C).
4. `profileSummary` chips + "no step-free route" message (A + C).
5. Elevator-out-of-service demo via `overrides.json` (A).
6. "Coming soon" toggles visible for low stamina / crowds with an explainer (C).

### Phase 4 · T+4:15–5:00 · Freeze & demo [20:00–20:45]
- [ ] **T+4:15 feature freeze.** Only bug fixes after this.
- [ ] Record a backup video of both demo routes (screen + audio).
- [ ] Write the 2-minute pitch in `docs/DEMO.md`:
  1. the problem
  2. why ETH's own network data + per-need profiles
  3. live demo A
  4. live demo B
  5. what's next: stamina, crowds, door data
- [ ] Clean `README.md`: how to run, env vars, data snapshot date.

---

## Cut list (pull from the bottom up if you're behind)
| Cut | Fallback |
|---|---|
| Own graph + A* | NAServer proxy with its `Wheelchair`/`Walking` modes; keep our instruction/`speech` formatting |
| Vision auto-advance | Manual "Next" (tap/voice) + pedometer auto-advance |
| Map view | Step list only (it's already accessible) |
| Continuous STT | Push-to-talk only |
| Audio beacon | Spoken heading phrases only |
| GPS outdoor leg | HG-only demo (already the plan) |

## Definition of done (demo-ready)
- [ ] Wheelchair route in HG uses an elevator and never stairs; the default profile on the same pair uses stairs.
- [ ] The full flow works with VoiceOver/TalkBack or voice-first mode, screen never touched after "Start".
- [ ] A room sign photo localizes the user and reroutes.
- [ ] No API key in the client bundle. No images logged server-side.
- [ ] The safety notice is spoken and shown.

## Agent hygiene (tell each agent)
- Read `docs/SPEC.md` and `packages/shared/src/types.ts` first. **Do not change shared types** without being told to.
- Stay inside the owned paths. If you need something from another track, write a `// TODO(track-X): …` and tell your dev.
- Commit small and often with descriptive messages. Run `pnpm -r typecheck` before every commit.
- Prefer working, ugly, and tested on a real phone over polished and untested.
