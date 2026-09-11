# Bhutan Mobility Atlas (Cloudflare Workers)

Operations dashboard and evaluation API for the Bhutan mobility-data pilot.
One Worker serves the JSON API (`/api/*`) and the static dashboard; D1 holds
the metadata catalog, R2 holds raw telemetry and clips, a cron trigger writes
nightly KPI snapshots. See `../docs/bhutan_dashboard.md` for the full guide and
`../docs/bhutan_roadmap.md` for the feature/integration to-do list.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                                  # http://127.0.0.1:8787
(cd ../toolkit && python scripts/seed_demo.py)   # demo data
npm run build:viewer                         # the XVIZ viewer at /viewer/
npm run typecheck
npm test                                     # node:test unit tests
```

Beyond the run/scenario/evaluation/clip API, the Worker also exposes:

* `GET /api/runs/:id/export/{geojson,csv,mcap}` and `GET /api/scenarios/:id/export/xosc`
  — export to [kepler.gl](https://github.com/keplergl/kepler.gl)/QGIS,
  pandas, [Foxglove Studio](https://github.com/foxglove/studio) and
  [CARLA ScenarioRunner](https://github.com/carla-simulator/scenario_runner)/[esmini](https://github.com/esmini/esmini).
* `GET /api/fleet/live`, `/api/ingest/traccar`, `/api/ingest/osmand` — live
  fleet positions from [Traccar](https://github.com/traccar/traccar) or the
  OsmAnd phone protocol, shown on the Fleet tab.
* `GET /api/planner` — dataset size, storage and GPU-cost bands for a target
  corpus (scenes, clip length, cameras, resolution) on marketplace GPUs, with the
  catalog's current coverage against that target. Powers the Planner tab.
* `GET /api/gpu-prices` — live $/GPU-hour from the
  [Vast.ai](https://vast.ai) and [RunPod](https://runpod.io) public listing
  APIs, aggregated to a min/25th-percentile/median per GPU class and pricing
  mode (on demand and interruptible), with the history behind the planner's
  price chart. The nightly cron records one observation; an admin can force one
  with `POST /api/gpu-prices/refresh`. The planner prices a run on the cheapest
  provider's median when an observation is less than 72 hours old and says so
  in `compute.price_source`; otherwise it falls back to the reference rates in
  `src/planner.ts`. Market data with no tenant in it, so the read needs no
  token.
* `GET /api/coverage` — ODD coverage matrix: scenario variants and the runs
  recorded against them, crossed by visibility and lighting class. A cell is
  covered at `min_runs` accepted runs (default 3), thin when variants exist but
  too few runs do, and a gap when nothing is there; gaps come back worst first.
  Runs with no scenario behind them land in an `unlabelled` row and column that
  is shown but excluded from the coverage percentage.
* `GET /api/scenes`, `GET /api/scenes/:id` — synthetic demo scenes, generated
  from a fixed seed. No tenant data and no authentication, so the Demo scenes
  tab works on a fresh deployment before a single run is ingested. Each scene
  carries road geometry, ego and actor tracks at 10 Hz, a sensor model and
  events, and sits in an ODD cell the coverage matrix reports as a gap. The
  lidar is not shipped — the viewer simulates the returns in the browser by
  casting rays against the same geometry, so a scene stays around 70 kB.
* `GET /api/xviz/logs`, `/api/xviz/logs/:id/…`, `/api/xviz/ws` — the same demo
  scenes encoded as [XVIZ](https://github.com/aurora-opensource/xviz) v2 logs
  for [streetscape.gl](https://github.com/aurora-opensource/streetscape.gl),
  which this repository vendors at [`../streetscape`](../streetscape) and builds
  into the viewer at `/viewer/`. Frames are generated one per request from the
  same seed, so they are pure and served `immutable`; the lidar is simulated on
  the Worker this time, by `src/lidar.ts`, because XVIZ frames come from the
  server. Both of streetscape.gl's loaders are supported: cached files, and a
  WebSocket stream answered from a `WebSocketPair` — the shape a live vehicle
  feed would take. See [`viewer/README.md`](viewer/README.md).
* `GET /api/metrics` — Prometheus exposition for Grafana.
* `GET /api/openapi.json` — OpenAPI 3.1 description of the whole API.
* A [CARLA Leaderboard](https://github.com/carla-simulator/leaderboard)-style
  driving score computed on `POST /api/runs/:id/finish`.

Deploy:

```sh
npx wrangler d1 create carla-bhutan-atlas    # put database_id in wrangler.toml
npx wrangler r2 bucket create carla-bhutan-atlas-data
npm run db:migrate:remote
npx wrangler secret put API_TOKENS           # token=tenant:role;...
npx wrangler secret put MANIFEST_SIGNING_KEY
npm run deploy                               # builds viewer/, then deploys
```

`npm run deploy` builds the XVIZ viewer into `public/viewer/` first, because
`wrangler deploy` uploads `public/` as the Worker's static assets. That
directory is generated and is not checked in.
