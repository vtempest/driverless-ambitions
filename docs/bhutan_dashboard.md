# Bhutan dashboard on Cloudflare Workers

The `dashboard/` directory contains "Atlas", the operations and evidence
application for the Bhutan pilot. One Worker serves both the JSON API under
`/api/*` and a static single-page dashboard (deck.gl route playback, unified
timeline, scenario library, evaluations, safety review and governance).

- [Architecture](#architecture)
- [Deploy](#deploy)
- [Local development](#local-development)
- [Authentication and tenants](#authentication-and-tenants)
- [API](#api)
- [KPI definitions](#kpi-definitions)
- [Evidence packs](#evidence-packs)
- [Data governance](#data-governance)

---

## Architecture

| Component | Cloudflare product | Role |
|---|---|---|
| API and static assets | Workers with static assets | Same-origin API and dashboard, no separate frontend host |
| Metadata catalog | D1 | Runs, telemetry chunk index, events, quality segments, scenarios, evaluations, clips, KPI snapshots, audit log |
| Raw data | R2 | Immutable telemetry chunks (JSONL, SHA-256 in object metadata) and clips |
| Scheduled work | Cron trigger | Nightly KPI snapshot per tenant for trend lines and partner reports |
| Signing | Worker secret + WebCrypto | HMAC-SHA256 signature on evidence packs |

The Worker is dependency-free TypeScript (no framework) so it stays small and
auditable. The front end is plain HTML, CSS and JavaScript with deck.gl loaded
from a CDN; there is no build step.

## Deploy

```sh
cd dashboard
npm install
npx wrangler d1 create carla-bhutan-atlas            # copy database_id into wrangler.toml
npx wrangler r2 bucket create carla-bhutan-atlas-data
npm run db:migrate:remote
npx wrangler secret put API_TOKENS                   # token=tenant:role;token2=tenant2:reader
npx wrangler secret put MANIFEST_SIGNING_KEY         # 32+ random bytes
npm run deploy
```

The GitHub Actions workflow `.github/workflows/bhutan_dashboard.yml`
typechecks on every pull request touching `dashboard/` and deploys on pushes
to the main branches when the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets are present.

To seed a fresh deployment with the scenario library:

```sh
cd toolkit
python scripts/generate_library.py --dashboard https://carla-bhutan-atlas.<account>.workers.dev --token <writer token>
```

## Local development

```sh
cd dashboard
npm install
cp .dev.vars.example .dev.vars           # local tokens and signing key
npm run db:migrate:local
npm run dev                              # http://127.0.0.1:8787
```

Then, from `toolkit`, `python scripts/seed_demo.py` fills the local
instance with the scenario library, three synthetic switchback runs (clearly
labelled as synthetic), a baseline evaluation and two clips. Open the
dashboard, paste `dev-writer-token` into the token box and connect.

## Authentication and tenants

`API_TOKENS` is a secret of the form `token=tenant:role;...`. Roles are
`reader` (dashboards, evidence export, released clips), `writer` (uploads,
reviews, governance changes) and `admin` (may switch tenant with the
`X-Tenant` header). Every row in D1 carries `tenant_id`, R2 keys are prefixed
with the tenant, and every write is recorded in `audit_log` with a short
non-reversible token fingerprint as the actor. Tokens are compared in
constant time.

## API

All endpoints expect `Authorization: Bearer <token>` except `GET /api/health`,
`GET /api/openapi.json` and the ingestion webhooks noted below (those still
need a writer token, just not necessarily in an `Authorization` header).

| Method and path | Role | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness check |
| `GET /api/openapi.json` | none | OpenAPI 3.1 description of every endpoint, for client generation and Swagger UI |
| `GET /api/metrics` | reader | Prometheus text exposition of KPIs, edge-case rates and perception metrics, for Grafana |
| `GET /api/kpis` | reader | Live KPI report, edge-case rates and perception benchmark |
| `GET /api/kpis/history` | reader | Nightly KPI snapshots |
| `POST /api/kpis/snapshot` | writer | Force a snapshot |
| `GET /api/coverage` | reader | ODD coverage matrix (visibility × lighting), route-class totals and the cells that are still gaps |
| `GET /api/plan` | reader | Dataset-scale and GPU-budget plan: scenes still to render, storage and low/mid/high cost bands |
| `GET /api/runs`, `GET /api/runs/:id` | reader | Run catalog and detail (segments, chunks, event summary, evaluations, driving score) |
| `POST /api/runs` | writer | Upsert a run manifest |
| `POST /api/runs/:id/telemetry?seq=N` | writer | Upload a chunk of samples (stored in R2, indexed in D1) |
| `GET /api/runs/:id/telemetry?max=4000` | reader | Merged, downsampled samples for playback |
| `POST /api/runs/:id/events`, `GET /api/runs/:id/events` | writer / reader | Bulk event upload and listing |
| `POST /api/runs/:id/finish` | writer | Record quality report, segments, streams, privacy status; computes the Leaderboard-style driving score |
| `GET /api/runs/:id/evidence` | reader | Signed evidence pack |
| `GET /api/runs/:id/export/:format` | reader | Export a run as `geojson` (kepler.gl, QGIS), `csv` (pandas, PlotJuggler), `mcap` (Foxglove Studio, ROS 2) or `json` |
| `GET /api/events/critical`, `POST /api/events/:id/review` | reader / writer | Safety review queue |
| `GET /api/scenarios`, `GET /api/scenarios/:id` | reader | Library with per-family review counts |
| `POST /api/scenarios/import` | writer | Import a library manifest; a changed content hash resets the review |
| `POST /api/scenarios/:id/review` | writer | Expert alignment review |
| `GET /api/scenarios/:id/export/xosc` | reader | ASAM OpenSCENARIO 1.2 export for CARLA ScenarioRunner or esmini |
| `GET /api/evaluations`, `GET /api/evaluations/:id`, `POST /api/evaluations` | reader / writer | Benchmark reports |
| `POST /api/evaluations/:id/replay-verified` | writer | Mark reproducibility (compares a replay's inputs and counts) |
| `GET /api/clips`, `POST /api/clips`, `PUT /api/clips/:id/object`, `GET /api/clips/:id/object`, `POST /api/clips/:id/governance` | mixed | Clip registration, upload, gated download, redaction and release |
| `GET /api/fleet/live` | reader | Latest position and status of every fleet device |
| `POST /api/fleet/positions` | writer | Generic position upload from edge loggers |
| `GET /api/fleet/devices/:id/track` | reader | A device's positions in a time window |
| `POST /api/fleet/devices/:id/materialize` | writer | Turn a device's track into a run so it enters the catalog and KPIs |
| `POST /api/ingest/traccar` | writer | [Traccar](https://github.com/traccar/traccar) forward webhook (`forward.url` + a writer token in `forward.header`) |
| `GET`/`POST /api/ingest/osmand` | writer | OsmAnd protocol used by Traccar Client and GPSLogger (`?token=<writer token>`) |
| `GET /api/audit` | reader | Audit trail |

The Python client in `bhutan_sim/telemetry.py` wraps the run, scenario, evaluation and clip endpoints.

### Fleet ingestion

Three producers feed the same `fleet_positions`/`fleet_devices` tables so a
partner's existing GPS tracking keeps working while the fleet grows into
dedicated edge loggers:

* **Traccar** — an existing [Traccar](https://github.com/traccar/traccar)
  server (hundreds of supported GPS protocols) forwards every position to
  `POST /api/ingest/traccar` via `forward.url` / `forward.header` in
  `traccar.xml`.
* **OsmAnd protocol** — Traccar Client, OsmAnd and GPSLogger apps on a
  driver's phone post directly to `GET/POST /api/ingest/osmand?token=<writer token>`.
* **Generic** — an edge logger posts batches of `{device_id, t, lat, lon, ...}`
  to `POST /api/fleet/positions`.

The Fleet tab shows live positions and per-device tracks on the same deck.gl
map as run playback. `POST /api/fleet/devices/:id/materialize` turns a time
window of a device's track into a run (derived speed, heading and grade)
so it can be finished with a quality report and counted toward the
real-world route-coverage KPI.

### Exports

`GET /api/runs/:id/export/:format` and `GET /api/scenarios/:id/export/xosc`
turn Atlas data into formats other open-source AV tools already read:

* **MCAP** (`foxglove.LocationFix` + `foxglove.Log` channels, plus the full
  Atlas sample) opens directly in [Foxglove Studio](https://github.com/foxglove/studio)
  or any ROS 2 tool that reads MCAP.
* **GeoJSON** loads into [kepler.gl](https://github.com/keplergl/kepler.gl),
  QGIS or any web map for risk overlays.
* **CSV** is for spreadsheets, pandas and PlotJuggler.
* **OpenSCENARIO 1.2** (`.xosc`) runs a scenario template in
  [CARLA ScenarioRunner](https://github.com/carla-simulator/scenario_runner)
  or [esmini](https://github.com/esmini/esmini):
  `python scenario_runner.py --openscenario bt-x.xosc`.

### Driving score

`POST /api/runs/:id/finish` computes a
[CARLA Leaderboard](https://github.com/carla-simulator/leaderboard)-style
`driving_score = route_completion * infraction_penalty` from the run's
events, using the Leaderboard 2.0 coefficients for collisions and
documented Atlas-specific coefficients for the safety rules that have no
Leaderboard equivalent (see `dashboard/src/driving_score.ts` and
`toolkit/bhutan_sim/driving_score.py`, which are kept identical).

## Coverage matrix and compute budget

The **Coverage & compute** tab answers the two questions that come before any
GPU purchase: what the catalog actually covers, and what closing the gap costs.

**Coverage.** `GET /api/coverage` crosses the scenario library's
`visibility_class` with its `lighting_class` and counts, per cell, the scenario
variants, the runs recorded against them and their accepted subset. A cell is

* `covered` — at least `min_runs` accepted runs (default 3, `?min_runs=`),
* `thin` — variants exist but too few accepted runs,
* `gap` — nothing in the catalog at all.

Runs with no scenario behind them (materialised fleet tracks, GPX imports) land
in an `unlabelled` row and column: they are shown so the data is visible, but
they are not ODD combinations, so they do not count towards `coverage_pct` or
the gap list. Gaps come back worst first — empty cells before thin ones — which
is the order to collect or render in. `atlas_coverage_pct`,
`atlas_coverage_cells_gap` and `atlas_dataset_scenes` are also exported to
Prometheus, so Grafana can alert when a cell regresses.

**Budget.** `GET /api/plan` costs a target dataset size in three parts:
rendering the missing scenes in CARLA, storing the result, and training on it.
Defaults are calibrated from the tenant's own catalog — accepted runs as the
scene count, mean accepted-run duration as seconds per scene, mean clip size as
MB per scene — and every one can be overridden with a query parameter
(`tier`, `scenes`, `have`, `workload`, `gpu`, `interruptible`,
`seconds_per_scene`, `resolution`, `camera_streams`, `mb_per_scene`, `rate`,
`storage_rate`, `preprocess_overhead`).

| Dataset tier | Scenes | What it buys |
|---|---|---|
| Proof of concept | 1k–10k | The pipeline end to end and a baseline demo |
| Domain adaptation | 10k–100k | Moving an off-the-shelf model onto Bhutanese roads, signage and traffic mix |
| Robust across the ODD | 100k+ | Varied weather, lighting, road types and rare events with enough examples per cell |

Every figure is a low/mid/high band, because both marketplace GPU rates and
pipeline efficiency move by more than 2×. The training model is
1–10 A100-hours per 1,000 scenes for a fine-tune, 10–50 for a medium job and
50–200 from scratch, plus 20 % for preprocessing, augmentation and validation;
other GPUs scale by a throughput factor (an H100 is 2.2× an A100). Rates are
marketplace on-demand listings (Vast.ai-style), with interruptible instances at
60 % of on-demand. Storage is video bitrate × seconds × camera streams plus
10 % for telemetry, labels and manifests — a marketplace instance's default
~10 GB of disk covers none of it, so volume space is a real line item. The
model lives in `dashboard/src/dataset_plan.ts` and is unit-tested in
`dashboard/test/dataset_plan.test.ts`; change the constants there, not the UI,
when the market moves.

## KPI definitions

| KPI | Computation | Month-3 target |
|---|---|---|
| Real-world route coverage | Sum of `duration_s` of accepted runs with `source = vehicle` | 50–100 h |
| Replay completeness | Finished runs with `replay_complete` (GNSS, IMU and events present) | ≥ 95 % |
| Scenario-library coverage | Count of scenarios in the tenant | 100+ |
| Synthetic-to-real alignment review | Distinct families with at least one reviewed template | 20+ |
| Data-quality acceptance rate | Passed segments over all segments | ≥ 90 % |
| Edge-case discovery rate | Events per 100 km by class over total distance | tracked |
| Perception benchmark | Precision and recall by class, weather, lighting and route class from stored evaluations | baseline |
| Evaluation reproducibility | Evaluations whose input hashes are all recorded | 100 % |
| Critical safety-rule violations | Critical events that are logged, classified (rule id) and reviewed | 100 % |
| Data-governance compliance | Released clips that are redacted (or exempt) and consent-traceable | 100 % |

## Evidence packs

`GET /api/runs/:id/evidence` returns a self-describing manifest with the run
row, scenario reference and whether its content hash still matches, telemetry
chunk hashes, quality segments, all events with review state, evaluations with
input hashes, clip governance state and a set of attestations (replay
complete, quality status, privacy status, consent traceability, unreviewed
critical events). The canonical JSON is hashed and HMAC-signed with
`MANIFEST_SIGNING_KEY`; the `key_id` lets partners know which key to verify
against. Exports are audited.

## Data governance

* A clip can only be released when `redaction_status` is `redacted` or `not_required` and a `consent_ref` is recorded; the API refuses otherwise.
* Readers can download only released clips; writers and admins see their tenant's clips for review.
* Runs record `privacy_status`; the quality gates flag video that has not been redacted.
* All raw objects are immutable in R2 and carry their SHA-256 in object metadata.
