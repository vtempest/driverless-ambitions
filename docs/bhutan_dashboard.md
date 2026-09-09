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
| `GET /api/training/plan` | reader | Training-set inventory, sizing tiers, condition-coverage gaps and a low/typical/high GPU budget; `?format=markdown` returns a budget memo |
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

### Training set and compute budget

The **Training set** tab (`GET /api/training/plan`, `dashboard/src/training.ts`)
answers the two questions a model team asks before paying for GPUs: is the
catalog big and varied enough to train on, and what would a run cost?

*Scene count.* A scene is one catalog clip, or one run that has no clips (the
run is then the scene sequence). The count is checked against the usual
sizing tiers — 1k–10k scenes for a proof of concept, 10k–100k for useful
domain adaptation, 100k+ for a model that holds up across weather, lighting
and road types — and the tab shows how many scenes are missing from the next
tier.

*Coverage.* Scene counts alone do not make a model generalise, so runs are
grouped by the linked scenario's `lighting_class`, `visibility_class` and
`route_class`. A bucket holding under 5 % of scenes is flagged as thin, and
the route-class × lighting matrix highlights combinations with no scenes at
all. Runs uploaded without a `scenario_id` land in `unspecified`, which is
reported separately: coverage that cannot be verified is a gap in itself.
Average scene length is checked against ~10 s, below which behaviour cloning
and end-to-end driving have too little sequence to learn from.

*Budget.* GPU-hour bands come from the workload — fine-tune (100–1,000
GPU-hours), medium training job (1,000–5,000), from-scratch or heavy
iteration (5,000–20,000) — quoted at 100k scenes and scaled linearly to the
target (clamped to 0.25–4×). Preprocessing, augmentation and validation add
7 GPU-seconds per scene on top. Rates are reference brackets for marketplace
listings (A100 80 GB ≈ $0.70–1.60/h, H100 PCIe ≈ $0.90–2.50/h, L40S, RTX
4090), with interruptible instances at 60 % of on-demand; every one of them
is overridable per request (`rate_usd_hr`, `bytes_per_scene`,
`disk_usd_per_gb_month`, `retention_days`, `preprocess_gpu_s_per_scene`) and
echoed back under `assumptions`. Disk is sized at 1.5× the dataset with a
10 GB floor, because marketplace instances default to a 10 GB disk and a
driving corpus needs far more. Network egress and object storage are not
included.

Marketplace prices move constantly, so treat the defaults as a bracket to
start from and paste a real listing's rate before quoting a number to a
partner. `?format=markdown` renders the whole plan — inventory, tiers,
coverage, budget table, gaps and assumptions — as a memo for partner reports.
`/api/metrics` exposes `atlas_dataset_scenes`, `atlas_dataset_stored_bytes`,
`atlas_dataset_coverage_empty_cells` and `atlas_dataset_scenes_to_next_tier`
for Grafana.

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
