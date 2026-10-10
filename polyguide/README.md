# PolyGuide — kickoff kit

Accessible indoor navigation for ETH Zürich: wheelchair, blind and low-vision users; voice-only or screen-only. Built in 5 hours by 3 devs, each driving one coding agent.

## What's here
| File | Purpose |
|---|---|
| `docs/SPEC.md` | Product and technical spec: data source, routing, guidance/AI, UI, API, risks |
| `docs/PLAN.md` | 5-hour timeline, ownership, sync points, decision gate, cut list |
| `docs/agents/A_data_routing.md` | Paste-ready brief for the Data & Routing agent |
| `docs/agents/B_guidance_ai.md` | Paste-ready brief for the Guidance & AI agent |
| `docs/agents/C_app_voice.md` | Paste-ready brief for the App, Voice & A11y agent |
| `packages/shared/src/types.ts` | Shared contracts. Freeze at T+0:25; additive changes only after that. |
| `packages/shared/src/fixtures.ts` | Mock data, so the UI is never blocked |

## Kickoff (first 25 minutes)
1. Dev 1 scaffolds the monorepo and drops this kit in. See PLAN Phase 0.
2. Each dev starts their agent with: *"Read docs/SPEC.md, docs/PLAN.md, packages/shared/src/types.ts and docs/agents/<X>.md. Then start on deliverable 1."*
3. Pick the two demo routes in PolyMaps and write them into `docs/DEMO.md`.

## Data
ETH PolyMaps ArcGIS REST (public, undocumented): `https://arcgis-prd-web.ethz.ch/server/rest/services/EGDB/`. The routing network lives in `EGDB_Public_Network` (Pathways, Transitions, Landmarks). The reference router is `Hosted_Public_Network/NAServer/Route`, which already has a Wheelchair travel mode. Snapshot it once and commit; never call it at runtime. Contact: polymaps@ethz.ch.
