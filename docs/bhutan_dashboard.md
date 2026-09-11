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
auditable — including the XVIZ encoder, which writes the protocol directly
rather than pulling `@xviz/builder` into the isolate. The dashboard front end is
plain HTML, CSS and JavaScript with deck.gl from a CDN and no build step. The
one exception is the XVIZ viewer at `/viewer/`, a React app built by Vite from
the vendored [`streetscape/`](../streetscape) source into `dashboard/public/viewer/`,
which the same Worker then serves as a static asset.

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
npm run build:viewer                     # streetscape.gl viewer → /viewer/
npm run dev                              # http://127.0.0.1:8787
```

`npm run dev:viewer` runs the XVIZ viewer under Vite with hot reload instead,
proxying `/api` (WebSocket included) to `wrangler dev` on port 8787.

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
| `GET /api/planner/options` | none | Reference tables behind the planner: dataset tiers, training programs, GPU rates, video bitrates |
| `GET`/`POST /api/planner` | reader | Dataset size, storage and GPU-cost plan for a target corpus, plus the catalog's coverage against it |
| `GET /api/gpu-prices` | none | Marketplace GPU quotes (median, p25 and cheapest $/GPU-hour per card), their drift against the reference table, and the stored price history |
| `POST /api/gpu-prices/refresh` | writer | Poll the GPU marketplaces now instead of waiting for the nightly cron |
| `GET /api/coverage` | reader | ODD coverage matrix (visibility x lighting) with gaps worst first |
| `GET /api/scenes`, `GET /api/scenes/:id` | none | Synthetic demo scenes for the scene viewer |
| `GET /api/xviz/logs` | none | The demo scenes as XVIZ v2 logs, with the URLs each streetscape.gl loader needs |
| `GET /api/xviz/logs/:id/:file` | none | XVIZ file loader: `0-frame.json` timings, `1-frame.json` metadata, `n-frame.json` data frame `n - 2` |
| `GET /api/xviz/logs/:id/lidar-:density/:file` | none | The same frames at a chosen point-cloud density, `0` to `1` |
| `GET /api/xviz/ws?log=:id` | none | XVIZ v2 WebSocket stream for `XVIZStreamLoader` |
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

### Dataset and compute planner

The Planner tab and `/api/planner` size a target corpus and price the training
program behind it, so a proposal can quote storage and GPU spend instead of
guessing. Everything is computed in `dashboard/src/planner.ts`; the reference
points are returned with every response in `assumptions`, and can be overridden
per request.

```sh
curl -H "authorization: Bearer $TOKEN" \
  "$BASE/api/planner?scenes=100000&clip_seconds=10&fps=10&cameras=3&resolution=1080p&program=medium_train&gpu=h100_80gb&gpus=4&interruptible=true"
```

What the model assumes, and why:

* **Dataset tiers** — 1k–10k scenes is a proof of concept, 10k–100k is useful
  domain adaptation, 100k+ is where day/night, rain/fog and urban/highway/rural
  can all be covered. Coverage across those conditions matters more than the raw
  count, and for behaviour cloning so does clip length, which is why the planner
  takes seconds-per-scene and frames-per-second rather than a frame total.
* **Storage** — encoded video per camera (4/8/14/28 Mbit/s for 720p/1080p/1440p/4k),
  plus 8 % for labels and manifests, plus one working copy for decoded shards and
  checkpoints. A toy demo lands in the single-GB range, a serious fine-tune in the
  tens of GB, and a broad synthetic programme in the TB range. Instances default to
  a 10 GB disk, so the extra is billed per GB-month.
* **Compute** — each training program carries an aggregate A100-class GPU-hour band
  at a 10M-frame baseline (fine-tune 150–1000, medium 1000–5000, from scratch
  5000–20000), scaled by `(frames/baseline)^0.85` because preprocessing, validation
  and evaluation do not shrink linearly. Other GPUs divide those hours by a
  throughput factor (H100 ≈ 2.2× an A100). Aggregate hours do not change with the
  number of GPUs; wall-clock time does, at a conservative 0.92 per doubling.
* **Price** — the live marketplace median when one is stored, otherwise a reference
  rate (A100 80GB ≈ $1.15/h, H100 ≈ $1.80/h, with H100s advertised as low as
  $0.90/h). `usd_per_gpu_hour` overrides both; `live_prices=false` pins a plan to
  the reference table so two plans made a week apart stay comparable. Interruptible
  instances use the quoted bid when the marketplace publishes one and 60 % of
  on-demand otherwise, and are only safe with checkpointed training.

The response also carries `coverage`: how much accepted collection time the catalog
already holds, expressed as scenes of the planned clip length, and how many hours of
driving remain to hit the target, and `prices`: the live rates the plan was costed
at and how far each has drifted from the reference table.

### Live marketplace prices

`GET /api/gpu-prices` serves what the GPU marketplaces are asking today, so a plan
is priced against a rentable machine rather than a number written into the source
last quarter. The nightly cron polls [Vast.ai](https://console.vast.ai/api/v0/bundles/)
(public bundle search, no key needed) and [RunPod](https://api.runpod.io/graphql)
(public GPU catalogue), normalises every listing to a **per-GPU** hourly price —
Vast quotes `dph_total` for the whole machine — and stores one sample per source
and card in `gpu_price_samples`.

```sh
curl "$BASE/api/gpu-prices?days=60"                 # quotes, drift, price history
curl -X POST -H "authorization: Bearer $TOKEN" "$BASE/api/gpu-prices/refresh"
```

* **The median, not the minimum.** The cheapest listing for a card is usually one
  host with poor reliability or a disk too small for the corpus; a budget built on
  it does not survive contact with the queue. The minimum and the 25th percentile
  are stored alongside so the spread stays visible, and the Planner tab shows all
  three.
* **Cheapest fresh median across sources** is the rate a plan is costed at, and the
  source is recorded on the plan (`compute.price_source` is `live:vast.ai`,
  `reference`, or `override`).
* **Stale quotes are dropped, not aged in.** Past 48 hours a sample is still served
  and charted, but the planner falls back to the reference table and says so — a
  two-day-old median is a worse estimate than a documented reference point, because
  it looks live.
* **Cards are matched by name and memory floor**, so an A100 40GB listing never
  prices an A100 80GB plan.

Both marketplaces are read-only and unauthenticated here; `VAST_API_KEY` is
optional and only raises the rate limit.

## ODD coverage matrix

`GET /api/coverage` crosses the scenario library's `visibility_class` with its
`lighting_class` and counts, per cell, the scenario variants and the runs
recorded against them. Scenario rows describe *planned* coverage; run rows
describe *realised* coverage.

| Status | Meaning |
|---|---|
| `covered` | at least `min_runs` accepted runs (default 3) |
| `thin` | variants or runs exist, but too few accepted runs |
| `gap` | nothing at all in the cell |

Gaps come back worst first — empty cells before thin ones, then the thinnest of
those — so the list doubles as a collection work queue. Runs with no scenario
behind them (materialised fleet tracks, GPX imports) land in an `unlabelled` row
and column: they are shown, because that data is real, but they are not ODD
combinations, so they are excluded from `coverage_pct`.

What closing a gap *costs* is a separate question, answered by
`/api/planner`. The matrix deliberately holds no pricing model.

## Demo scenes

`GET /api/scenes` and `GET /api/scenes/:id` serve four synthetic scenes
generated from a fixed seed. They carry no tenant data, so they need no token
and are cached for an hour — which makes the Demo scenes tab the one surface
that works on a fresh deployment, before a token exists or a single run has been
ingested. Being seeded, they also make screenshots in partner reports
reproducible.

Each scene sits in an ODD cell the coverage matrix reports as a gap for a young
catalog:

| Scene | ODD cell | What it shows |
|---|---|---|
| `thimphu_junction` | clear / daylight / urban junction | Pedestrian steps off the kerb from behind a parked bus |
| `dochula_switchback` | clear / daylight / hairpin | Oncoming truck cuts the apex and crosses the centreline |
| `monsoon_descent` | heavy rain / daylight / mountain curve | Spray and standing water; usable lidar range 38 m |
| `night_fog_pass` | fog / night / mountain straight | Usable range 22 m; roadside pedestrian acquired at 21.9 m |

A scene is road geometry (a curvature profile integrated into a centreline, the
way OpenDRIVE describes it), ego and actor tracks at 10 Hz, a sensor model and a
list of events. Everything is a pure function of the seed, so two callers get
identical bytes.

The lidar is **not** in the payload. A point cloud for every frame would run to
tens of megabytes; instead the viewer simulates the returns in the browser,
casting rays from the ego against the same geometry the API sent and stopping at
the nearest of the ground plane, an actor or a verge post. That keeps a scene
around 70 kB and makes the scan respond to the sensor model — an actor beyond
the scene's usable lidar range is drawn as *not detected*, which is what makes
the fog and rain scenes look visibly different from the clear ones.

## XVIZ logs and the streetscape.gl viewer

The same four scenes are also published as [XVIZ](https://github.com/aurora-opensource/xviz)
v2 logs and played by [streetscape.gl](https://github.com/aurora-opensource/streetscape.gl),
Aurora's autonomy-log viewer, at `/viewer/`. Upstream is archived, so it is
vendored at [`streetscape/`](../streetscape) and built from source — see
[`streetscape/VENDORED.md`](../streetscape/VENDORED.md).

This is the same data through an industry-standard lens. Where the Demo scenes
tab is our own deck.gl view of our own JSON, XVIZ is the format AV teams already
have tooling for, so a partner can point their own viewer at these URLs, and the
scenario library gains an export path that is not specific to this dashboard.

### Streams

| Stream | Category | What it carries |
|---|---|---|
| `/vehicle_pose` | pose | Ego position in metres from the scene origin, plus heading. Anchors every other stream. |
| `/lidar/points` | primitive · point | Simulated returns, coloured carriageway / verge / object |
| `/object/shape` | primitive · polygon | Actor footprints, extruded to actor height |
| `/object/tracked_point`, `/object/label` | primitive · circle, text | Actor centres and `id + range` labels |
| `/road/carriageway`, `/road/centerline` | primitive · polygon, polyline | Road geometry |
| `/ego/trajectory`, `/ego/trail` | primitive · polyline | Six seconds ahead, eight seconds behind |
| `/vehicle/velocity`, `/vehicle/acceleration` | time series | Speed and its central difference; drives the HUD gauges |
| `/perception/nearest_object`, `/perception/nearest_vru`, `/perception/tracked_objects` | time series | Range to the nearest actor and nearest vulnerable road user, and how many are inside the sensor envelope |
| `/vehicle/turn_signal` | time series | Derived from the ego's own yaw rate a second ahead |
| `/scene/events` | UI primitive | The scene's event list, filling as playback reaches each one |

Actors outside the scene's usable lidar range carry the `missed` style class and
are drawn as flat grey ghosts labelled *not detected* — the same sensor-model
claim the Demo scenes tab makes, expressed in XVIZ styling.

### Transports

Both of streetscape.gl's loaders are served, with byte-identical frames:

* **Files.** `GET /api/xviz/logs/:id/0-frame.json` is the timings index,
  `1-frame.json` the metadata, and `n-frame.json` for `n >= 2` is data frame
  `n - 2` — the numbering `XVIZFileLoader` expects. Every frame is a pure
  function of the seed, so all of them are served `immutable` and a replay comes
  from the edge cache rather than the Worker.
* **WebSocket.** `GET /api/xviz/ws?log=:id` upgrades through a `WebSocketPair`
  and speaks XVIZ v2: metadata on connect, then a `state_update` per frame for
  each `transform_log` range the client asks for, ending in
  `transform_log_done`. A new request supersedes whatever is still in flight, so
  seeking does not interleave two streams. No Durable Object is involved —
  frames are generated from a seed, so there is no state to hold.

### Lidar density

Every return is JSON on the wire here, so the density is a path segment:
`/api/xviz/logs/:id/lidar-<n>/<file>` for `n` in `[0, 1]`, defaulting to 0.35 —
roughly 10 kB gzipped per frame. `lidar-1` sends the full modelled scan;
`lidar-0` omits the point cloud. It is a path segment rather than a query
parameter because `XVIZFileLoader` picks its parser from the end of the URL
string, and anything after `.json` makes the frame an "unknown file format".

`dashboard/src/lidar.ts` is a TypeScript port of the ray caster in
`public/scenes.js`: the browser viewer simulates its own scan, the XVIZ log's
has to be built on the server. `test/lidar.test.ts` loads the browser copy in a
sandbox and asserts the two produce the identical scan, so they cannot drift.

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
