# Agent Brief — Track A: Data & Routing

You are building the **data pipeline, routing engine and REST server** for PolyGuide, an accessible indoor-navigation web app for ETH Zürich. Two other agents work in parallel:
- **Track B** builds guidance, sensors and AI vision.
- **Track C** builds the app UI and voice.

Read `docs/SPEC.md` (§2, §3, §4, §7) and `packages/shared/src/types.ts` before writing code. **Do not edit `packages/shared`** unless your dev tells you to.

## You own
`scripts/`, `data/`, `packages/routing/`, `apps/server/`, except `apps/server/src/ai/`, which belongs to Track B. B's routes get mounted on your app.

## Deliverables, in order

### 1. Mock mode first (≤ 15 min)
`apps/server`: Hono on Node 20 (`tsx watch`), port 8787. With `USE_MOCK=1`, every endpoint in SPEC §7 returns data from `packages/shared/src/fixtures.ts`. Push this immediately; Track C depends on it.

### 2. `scripts/fetch-eth.ts`
Base URL `https://arcgis-prd-web.ethz.ch/server/rest/services/EGDB/`.

General query rules:
- `f=geojson&outSR=4326&returnZ=true&outFields=*`
- page with `resultOffset` / `resultRecordCount=2000` until `exceededTransferLimit` is absent

What to download:
- Pathways: `EGDB_Public_Network/FeatureServer/2`, `where=LEVEL_ID LIKE 'ETH.HG.%'`
- Transitions: `EGDB_Public_Network/FeatureServer/1`, spatial envelope query (HG pathway bbox + 15 m)
- Landmarks: `EGDB_Public_Network/FeatureServer/3` (HG bbox)
- Rooms: `Units/FeatureServer/3`, `where=NAME LIKE 'HG %'`
- Levels: `Levels/FeatureServer` (find the layer id via `?f=json`)
- POIs: `PointsOfInterest/FeatureServer` (find the layer id via `?f=json`)

Write each to `data/hg/<name>.geojson`. Print feature counts and the distinct `LEVEL_ID`s. **Commit the data.** Never call ETH at server runtime.

### 3. `packages/routing/src/build.ts` → `data/hg/graph.json` (`GraphJson`)
Follow SPEC §4.1 exactly. Key points:
- **Local ENU projection, not Web Mercator meters.**
- Node merge key: 0.25 m in x/y, 1 m in z.
- Map the type codes to `EdgeKind`.
- Drop emergency, freight lift and shuttle edges.
- Keep the largest connected component.
- Print a report: node/edge counts, component sizes, edge kinds per level, transitions that failed to merge.

Places:
- Rooms, entrances and POIs, each with `aliases` and a `nodeId`.
- Snap `nodeId` to the nearest node on the same level, preferring nodes within 3 m of the room polygon.

### 4. `astar.ts`, `profiles.ts`, `heap.ts`
- SPEC §4.2–4.3. Costs are in seconds. `Infinity` means forbidden.
- Composable `CostModifier`s, one per need, including stubs for `lowStamina` and `avoidCrowds`.
- Unit tests (vitest) on a toy two-floor graph: the wheelchair profile never uses stairs; the default profile takes stairs when they're shorter; one-way edges are respected.

### 5. `instructions.ts`
SPEC §4.5:
- collapse segments
- turn classification
- vertical maneuvers
- arrive side
- expected landmarks within 6 m
- `text` and `speech` strings, following the speech rules
- `bearingDeg`, the compass bearing from north

Also produce `profileSummary` and `warnings` (e.g. "door widths unknown").

### 6. Endpoints
- `/api/health`
- `/api/levels`
- `/api/places` (fuse.js over name + aliases)
- `/api/map/:levelId`
- `/api/route`
- `/api/localize` (SPEC §4.6)

Load `data/overrides.json` at boot (SPEC §4.4). Validate request bodies with zod.

### 7. `/api/dev/compare`
Call the ETH NAServer `Hosted_Public_Network/NAServer/Route/solve` (travel modes `Walking` id 1 and `Wheelchair` id 2; take the full mode JSON from `.../NAServer/Route?f=json`). Report our distance vs theirs. Post the numbers for 5 room pairs at Sync 1.

### 8. Helpers for Track B
Export from `apps/server/src/graphStore.ts`:
- `getPlaceByName(text)`
- `getNode(id)`
- `isNearRoute(routeId, placeId, radiusM)`
- `routeStore`: keep the last 50 routes by `routeId` in memory

## Decision gate
At **T+2:15**, if floors are still disconnected, implement `/api/route` as a proxy to the NAServer and convert its directions into `RouteStep[]`. Keep the `speech` rules. Tell your dev before switching.

## Done when
- A wheelchair route between the two demo rooms contains an `elevator` step and no `stairs` edges.
- The default route on the same pair uses stairs.
- `pnpm -r typecheck` and the tests pass.
