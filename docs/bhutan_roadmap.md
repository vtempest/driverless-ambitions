# Bhutan Atlas roadmap: features and open-source AV tool integrations

This is the working to-do list for the `dashboard/` Worker ("Atlas") and the
`toolkit` toolkit. It ranks the next dashboard features and the
popular GitHub autonomous-vehicle tools worth integrating, and records what
has already landed. The longer survey of tools by category lives in
[Tooling outline for a driverless fleet](bhutan_fleet_tools.md); this page is
the actionable subset.

Legend: `[x]` shipped, `[ ]` open. Items are ordered by value to the pilot.

- [Integrations with GitHub AV tools](#integrations-with-github-av-tools)
- [Research queue: packages to evaluate](#research-queue-packages-to-evaluate)
- [Dashboard features](#dashboard-features)
- [Toolkit and pipeline features](#toolkit-and-pipeline-features)
- [Platform and engineering](#platform-and-engineering)
- [Iteration log](#iteration-log)

---

## Integrations with GitHub AV tools

| Done | Tool (GitHub) | What the integration does | Where |
|---|---|---|---|
| [x] | **MCAP / Foxglove** ([foxglove/mcap](https://github.com/foxglove/mcap), [foxglove/schemas](https://github.com/foxglove/schemas)) | Export any run as an MCAP file with `foxglove.LocationFix` and `foxglove.Log` channels; one-click "Open in Foxglove"; Python reader/writer so MCAP captures from ROS 2 / rosbag2 recorders can be ingested | `dashboard/src/exports.ts`, `toolkit/bhutan_sim/adapters/mcap_io.py` |
| [x] | **CARLA ScenarioRunner / esmini** ([carla-simulator/scenario_runner](https://github.com/carla-simulator/scenario_runner), [esmini/esmini](https://github.com/esmini/esmini)) | Export scenario templates as ASAM OpenSCENARIO 1.2 `.xosc` files so they run in ScenarioRunner, esmini or partner simulators | `dashboard/src/openscenario.ts`, `bhutan_sim/openscenario.py` |
| [x] | **CARLA Leaderboard metrics** ([carla-simulator/leaderboard](https://github.com/carla-simulator/leaderboard)) | Route completion, infraction penalty and driving score computed from run events with the Leaderboard penalty table; stored per run and shown in the runs table | `dashboard/src/driving_score.ts`, `bhutan_sim/driving_score.py` |
| [x] | **Traccar** ([traccar/traccar](https://github.com/traccar/traccar)) | Accept Traccar position forwarding (JSON) and generic position posts; live fleet map and per-device tracks | `dashboard/src/routes/fleet.ts`, Fleet tab |
| [x] | **Prometheus / Grafana** ([prometheus/prometheus](https://github.com/prometheus/prometheus), [grafana/grafana](https://github.com/grafana/grafana)) | `/api/metrics` exposes every KPI and edge-case rate in Prometheus text format for Grafana alerting | `dashboard/src/metrics.ts` |
| [x] | **kepler.gl / QGIS** ([keplergl/kepler.gl](https://github.com/keplergl/kepler.gl), [qgis/QGIS](https://github.com/qgis/QGIS)) | GeoJSON and CSV export of routes and events for GIS risk overlays | `dashboard/src/exports.ts` |
| [x] | **GPX dashcam / phone logs** (gpxpy-compatible) | Convert GPX tracks from dashcams and phone loggers into the unified timeline | `bhutan_sim/adapters/gpx.py`, `scripts/convert_run.py` |
| [x] | **OpenAPI / Swagger UI** ([swagger-api/swagger-ui](https://github.com/swagger-api/swagger-ui)) | `/api/openapi.json` describes every endpoint for client generation and partner docs | `dashboard/src/openapi.ts` |
| [ ] | **Scenic** ([BerkeleyLearnVerify/Scenic](https://github.com/BerkeleyLearnVerify/Scenic)) | Generate a Scenic program per family for probabilistic coverage sampling; import sampled scenes as templates | `bhutan_sim/scenic_export.py` |
| [ ] | **openpilot / comma logs** ([commaai/openpilot](https://github.com/commaai/openpilot)) | Read-only rlog ingestion (GPS, IMU, CAN speed/brake) into the timeline via `openpilot-tools` | `bhutan_sim/adapters/openpilot.py` |
| [ ] | **cantools / can-utils** ([cantools/cantools](https://github.com/cantools/cantools)) | Decode J1939 candump logs with a DBC into `throttle`, `brake`, `speed_mps`, payload signals | `bhutan_sim/adapters/can_dbc.py` |
| [ ] | **CVAT / Label Studio** ([cvat-ai/cvat](https://github.com/cvat-ai/cvat), [HumanSignal/label-studio](https://github.com/HumanSignal/label-studio)) | Push released clips as labeling tasks; import exported labels as ground truth | `POST /api/clips/:id/labeling-task`, `scripts/import_labels.py` |
| [ ] | **FiftyOne** ([voxel51/fiftyone](https://github.com/voxel51/fiftyone)) | Dataset export in FiftyOne format for coverage and duplicate analysis by weather, lighting and route class | `scripts/export_fiftyone.py` |
| [ ] | **nuScenes devkit** ([nutonomy/nuscenes-devkit](https://github.com/nutonomy/nuscenes-devkit)) | Export ground truth and detections as nuScenes-style JSON so model teams reuse their tooling | `bhutan_sim/adapters/nuscenes.py` |
| [ ] | **DVC** ([iterative/dvc](https://github.com/iterative/dvc)) | Versioned dataset snapshots tied to the D1 catalog manifest | `scripts/snapshot_dataset.py` |
| [ ] | **Autoware** ([autowarefoundation/autoware](https://github.com/autowarefoundation/autoware)) | Adapter that converts Autoware perception topics (MCAP) into the model-adapter detections contract | `bhutan_sim/adapters/autoware.py` |
| [ ] | **Lanelet2 / OSM** ([fzi-forschungszentrum-informatik/Lanelet2](https://github.com/fzi-forschungszentrum-informatik/Lanelet2)) | Corridor lane maps for route archetypes; OSM basemap self-hosting | `bhutan_sim/route.py` |
| [ ] | **Great Expectations / pandera** ([great-expectations/great_expectations](https://github.com/great-expectations/great_expectations)) | Declarative quality-suite export of the Q1–Q5 gates | `bhutan_sim/quality.py` |
| [ ] | **OpenTelemetry** ([open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js)) | Traces for API calls and cron jobs | `dashboard/src/index.ts` |
| [ ] | **Cloudflare Queues + Durable Objects** | Streaming ingestion and live vehicle sessions once the fleet grows beyond batch uploads | `dashboard/wrangler.toml` |

## Research queue: packages to evaluate

Candidates found while surveying what comparable AV data platforms use.
Each line says what to check before committing to an integration, so a later
iteration can pick one up and either promote it to the table above or drop it.

| Done | Package | Why it is worth a look | What to check |
|---|---|---|---|
| [ ] | **py123d + FiftyOne** ([voxel51/fiftyone](https://github.com/voxel51/fiftyone)) | Converts Argoverse 2, nuScenes, nuPlan, KITTI-360, PandaSet and Waymo into one Apache Arrow schema with a single API for cameras, lidar, maps and labels — the same fragmentation problem the Atlas catalog solves for local data | Whether the Atlas run/clip model maps cleanly onto its schema, so Bhutan data sits next to public datasets in one FiftyOne app |
| [ ] | **ScenarioNet + MetaDrive** ([metadriverse/scenarionet](https://github.com/metadriverse/scenarionet)) | Unified scenario description plus a large repository of real-world scenarios imported from Waymo, nuScenes, Lyft L5, Argoverse and nuPlan; replays them in a lightweight simulator | Whether the scenario library can be exported to its format alongside OpenSCENARIO, and whether its Bhutan-relevant scenarios (mountain, mixed traffic) are worth importing |
| [ ] | **nuPlan devkit** ([motional/nuplan-devkit](https://github.com/motional/nuplan-devkit)) | Closed-loop planning benchmark with a scenario taxonomy and metric suite over 1,300+ hours of driving logs | Whether its metric definitions can back a planning KPI next to the Leaderboard driving score |
| [ ] | **Rerun** ([rerun-io/rerun](https://github.com/rerun-io/rerun)) | Time-series and 3D log viewer; faster than Foxglove for local iteration and embeddable in notebooks | Whether an `.rrd` export is cheap next to the existing MCAP writer |
| [ ] | **SkyPilot** ([skypilot-org/skypilot](https://github.com/skypilot-org/skypilot)) | Runs a job on the cheapest GPU across clouds and marketplaces, with spot preemption recovery — the execution half of the budget planner | Whether a plan from `/api/training/plan` can be emitted as a SkyPilot task YAML with the right accelerator, disk and checkpoint policy |
| [ ] | **NVIDIA Cosmos / Alpamayo** | Open models and tooling for AV world modelling, reasoning and synthetic scene generation | Licence terms, VRAM needed per generated scene, and whether generated scenes can carry the condition labels the coverage matrix needs |
| [ ] | **EgoBlur** ([facebookresearch/EgoBlur](https://github.com/facebookresearch/EgoBlur)) | Face and plate anonymisation; the concrete package behind the open redaction step | Throughput per clip-hour on a modest GPU, and whether its output can flip `redaction_status` automatically |
| [ ] | **Waymax / Bench2Drive** ([waymo-research/waymax](https://github.com/waymo-research/waymax), [Thinklab-SJTU/Bench2Drive](https://github.com/Thinklab-SJTU/Bench2Drive)) | Closed-loop driving benchmarks used to compare end-to-end policies, Bench2Drive on CARLA itself | Whether a Bench2Drive-style protocol can run the Bhutan scenario families and report into the evaluations table |
| [ ] | **Deepchecks / Evidently** ([deepchecks/deepchecks](https://github.com/deepchecks/deepchecks)) | Data-drift and dataset-integrity suites; would watch for the collection drifting away from the coverage targets | Whether drift checks belong in the nightly cron next to the KPI snapshot |
| [ ] | **Vast.ai / marketplace price feeds** | The budget planner ships static reference rates; live listings would make estimates real | Whether an offer search can be polled from the Worker cron and cached per GPU class, and what its rate limits are |

## Dashboard features

- [x] KPI trend chart from nightly snapshots on the Overview tab.
- [x] Run export menu: GeoJSON, CSV, MCAP and "Open in Foxglove".
- [x] Driving score, route completion and infraction penalty per run.
- [x] Fleet tab: live device positions, last-seen table and per-device track playback.
- [x] Scenario library: download any template as OpenSCENARIO.
- [x] Deep links: `#runs/<run_id>`, `#scenarios/<family>`, `#evaluations/<id>` restore the view.
- [x] Training set tab: scene inventory against the 1k / 10k / 100k sizing tiers, condition-coverage gaps, route-class × lighting matrix and a low/typical/high GPU budget with a Markdown budget memo.
- [ ] Run comparison: overlay two runs' timelines and event markers.
- [ ] Map overlays: event heatmap by class, per-segment quality colouring on the route.
- [ ] Pagination and free-text search on runs, scenarios and evaluations.
- [ ] Collection planner: turn the coverage matrix's empty cells into a ranked list of scenario families and routes to collect next, with an estimated scene count per cell.
- [ ] Dataset builder: filter scenes by weather × lighting × route class and export the split as a signed manifest (the training half of the evidence pack).
- [ ] Spend tracking: record what a training job actually cost per model version and plot it against the planned budget on the Training set tab.
- [ ] Live GPU rates: cron-poll marketplace listings so the budget planner quotes real prices instead of the static reference brackets.
- [ ] Labeling queue: clips pushed to CVAT or Label Studio, with label progress per coverage cell.
- [ ] Reviewer notes on scenario and event review dialogs (the API already stores them).
- [ ] Partner report page: printable Month-3 summary from a KPI snapshot.
- [ ] Notifications: webhook (Slack, e-mail via Workers) when a critical event is uploaded unreviewed.
- [ ] Clip player with event markers for released clips.
- [ ] Route archetype view from `route_profile.py` output (curvature, grade histograms).
- [ ] Coverage matrix: scenarios and runs by weather × lighting × route class with gaps highlighted.
- [ ] Per-tenant branding and read-only share links with expiring tokens.

## Toolkit and pipeline features

- [x] `scripts/convert_run.py`: GPX, MCAP and Traccar exports into a run directory.
- [x] `scripts/export_scenario.py`: OpenSCENARIO export of one template, a family or the whole library.
- [x] Driving score in `quality.json` and in the dashboard's `finish` step.
- [ ] Redaction step (EgoBlur or understand.ai anonymizer) that flips `redaction_status`.
- [ ] Batch runner: run every template of a family in CARLA and upload with one command.
- [ ] `scripts/plan_training.py`: the budget planner offline, so a plan can be produced from a run directory before anything is uploaded, and emitted as a SkyPilot task YAML.
- [ ] Route-to-scenario generator: sample templates from a real GNSS trace's archetypes.
- [ ] Scenario diff tool: what changed between two library versions and which reviews it invalidated.
- [ ] ROS 2 native bridge recipe: record CARLA UE5 ROS 2 topics into MCAP and ingest.

## Platform and engineering

- [x] Worker unit tests (`npm test`) for router, auth, exports, OpenSCENARIO, driving score and metrics.
- [x] D1 migration `0002_fleet_and_scores.sql`.
- [ ] Vitest with `@cloudflare/vitest-pool-workers` for end-to-end route tests against Miniflare.
- [ ] Cloudflare Access / SSO in front of the dashboard; keep bearer tokens for machine clients.
- [ ] Key rotation for `MANIFEST_SIGNING_KEY` with multiple `key_id`s.
- [ ] Rate limiting per token on write endpoints.
- [ ] Retention policy job: expire raw chunks of rejected runs after N days.

## Iteration log

Newest first. One feature lands per iteration; the to-do lists above are the
queue it is drawn from.

### Iteration 3 — training-set sizing and compute budget

1. `GET /api/training/plan` (`dashboard/src/training.ts`,
   `dashboard/src/routes/training.ts`): scene inventory from clips and runs,
   progress against the 1k / 10k / 100k sizing tiers, condition coverage with
   thin buckets flagged, a route-class × lighting matrix, and a
   low/typical/high GPU budget for marketplace A100/H100 listings. Every rate
   and assumption is overridable per request and echoed back with the plan.
2. `?format=markdown` renders the whole plan as a budget memo for partner
   reports.
3. **Training set** dashboard tab: inventory tiles, tier progress, coverage
   bars and matrix, budget table, and a "what to collect next" list driven by
   the same gaps.
4. Prometheus gauges `atlas_dataset_scenes`, `atlas_dataset_stored_bytes`,
   `atlas_dataset_coverage_empty_cells`, `atlas_dataset_scenes_to_next_tier`.
5. Unit tests for tiers, GPU-hour scaling, coverage gaps, storage sizing,
   pricing overrides and the memo; OpenAPI and docs updated.
6. Research queue added above: py123d/FiftyOne, ScenarioNet/MetaDrive, nuPlan
   devkit, Rerun, SkyPilot, Cosmos/Alpamayo, EgoBlur, Waymax/Bench2Drive,
   Deepchecks and live marketplace price feeds.

### Iteration 2 — AV tool integrations

1. MCAP, GeoJSON and CSV export endpoints plus the Foxglove deep link.
2. OpenSCENARIO export in both the Worker and the Python toolkit.
3. Leaderboard-style driving score stored on every finished run.
4. Traccar and generic position ingestion with a live Fleet tab.
5. Prometheus metrics and an OpenAPI description of the API.
6. Front end: KPI trends, export menu, XOSC download, hash routing.
7. Python adapters (GPX, MCAP, Traccar) and `convert_run.py`.
8. Worker unit-test suite and CI updates.
