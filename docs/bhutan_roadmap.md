# Bhutan Atlas roadmap: features and open-source AV tool integrations

This is the working to-do list for the `dashboard/` Worker ("Atlas") and the
`toolkit` toolkit. It ranks the next dashboard features and the
popular GitHub autonomous-vehicle tools worth integrating, and records what
has already landed. The longer survey of tools by category lives in
[Tooling outline for a driverless fleet](bhutan_fleet_tools.md); this page is
the actionable subset.

Legend: `[x]` shipped, `[ ]` open. Items are ordered by value to the pilot.

- [Integrations with GitHub AV tools](#integrations-with-github-av-tools)
- [Training-compute and data-scale tooling](#training-compute-and-data-scale-tooling)
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

## Training-compute and data-scale tooling

The dataset-scale rules of thumb this pilot plans against: ~1k–10k labelled
clips for a proof of concept, ~10k–100k for useful domain adaptation, and 100k+
before a model is robust across weather, lighting, road types and rare events.
What matters more than the raw count is coverage of day/night, rain/fog,
urban/highway/rural and camera angles — and, for behaviour cloning, sequence
length rather than frame count. Storage follows: 1–5 GB for a toy demo, 20–100
GB for a serious fine-tune, 100 GB to several TB for a broad synthetic
programme (a marketplace instance's default ~10 GB disk covers none of it).
On GPU-hours, a 100k-scene project usually lands in the 500–5,000 A100-hour
band unless the model is large or the pipeline is inefficient, which is the
$500–$5,000 range on marketplace A100s. The planner in
`dashboard/src/dataset_plan.ts` encodes these bands; the items below are the
tools that would let it work from measured rather than assumed numbers.

| Done | Tool (GitHub) | What the integration does | Where |
|---|---|---|---|
| [x] | **Coverage and budget model** (in-repo) | ODD coverage matrix and the render/storage/training cost bands behind the Coverage & compute tab | `dashboard/src/dataset_plan.ts` |
| [ ] | **SkyPilot** ([skypilot-org/skypilot](https://github.com/skypilot-org/skypilot)) | Launch the render and training jobs the planner budgets on the cheapest available GPU across clouds and marketplaces, with managed spot instances that checkpoint and resume after preemption | `toolkit/scripts/launch_job.py` |
| [ ] | **dstack** ([dstackai/dstack](https://github.com/dstackai/dstack)) | Lighter-weight alternative to SkyPilot with a Vast.ai backend, for interactive dev boxes rather than batch jobs | `toolkit/scripts/launch_job.py` |
| [ ] | **MLflow** ([mlflow/mlflow](https://github.com/mlflow/mlflow)) or **wandb** | Record the GPU-hours, spend and dataset snapshot actually consumed by a training run and attach them to the evaluation row, so the planner's estimate can be scored against the outcome | `POST /api/evaluations` (`compute` block) |
| [ ] | **Live GPU price feed** (Vast.ai / provider APIs) | Replace the static hourly bands with the current marketplace floor, refreshed by the nightly cron | `dashboard/src/dataset_plan.ts`, cron |
| [ ] | **Rerun** ([rerun-io/rerun](https://github.com/rerun-io/rerun)) | Time-aligned multimodal viewer; `.rrd` export beside MCAP so a gap cell's clips can be reviewed without Foxglove | `dashboard/src/exports.ts` |
| [ ] | **Evidently** ([evidentlyai/evidently](https://github.com/evidentlyai/evidently)) | Drift report between the collected distribution and the distribution a model was trained on, per coverage cell | `toolkit/scripts/check_quality.py` |
| [ ] | **MetaDrive** ([metadriverse/metadrive](https://github.com/metadriverse/metadrive)) | CPU-cheap scenario replay for coverage sampling before spending GPU time in CARLA | `bhutan_sim/adapters/metadrive.py` |
| [ ] | **nuPlan devkit** ([motional/nuplan-devkit](https://github.com/motional/nuplan-devkit)), **Argoverse 2 API** ([argoverse/av2-api](https://github.com/argoverse/av2-api)) | Planning and prediction metrics beside the perception benchmark, so evaluations cover more than detection | `bhutan_sim/evaluation.py` |
| [ ] | **OpenPCDet** ([open-mmlab/OpenPCDet](https://github.com/open-mmlab/OpenPCDet)), **mmdetection3d** ([open-mmlab/mmdetection3d](https://github.com/open-mmlab/mmdetection3d)) | Baseline detectors to run against released clips so a new tenant gets a benchmark without bringing a model | `toolkit/scripts/baseline_detector.py` |
| [ ] | **AWSIM** ([tier4/AWSIM](https://github.com/tier4/AWSIM)) | Autoware-native simulator alternative for partners who do not run CARLA | `bhutan_sim/runner.py` |
| [ ] | Scenario-coverage literature (tree-based scenario classification; SCOUT) | A defensible coverage metric with confidence bounds, rather than counting cells with N runs | `dashboard/src/dataset_plan.ts` |

## Dashboard features

- [x] KPI trend chart from nightly snapshots on the Overview tab.
- [x] Run export menu: GeoJSON, CSV, MCAP and "Open in Foxglove".
- [x] Driving score, route completion and infraction penalty per run.
- [x] Fleet tab: live device positions, last-seen table and per-device track playback.
- [x] Scenario library: download any template as OpenSCENARIO.
- [x] Deep links: `#runs/<run_id>`, `#scenarios/<family>`, `#evaluations/<id>` restore the view.
- [ ] Run comparison: overlay two runs' timelines and event markers.
- [ ] Map overlays: event heatmap by class, per-segment quality colouring on the route.
- [ ] Pagination and free-text search on runs, scenarios and evaluations.
- [ ] Reviewer notes on scenario and event review dialogs (the API already stores them).
- [ ] Partner report page: printable Month-3 summary from a KPI snapshot.
- [ ] Notifications: webhook (Slack, e-mail via Workers) when a critical event is uploaded unreviewed.
- [ ] Clip player with event markers for released clips.
- [ ] Route archetype view from `route_profile.py` output (curvature, grade histograms).
- [x] Coverage matrix: scenarios and runs by visibility × lighting with gaps ranked worst first, plus route-class totals.
- [x] Dataset and GPU budget planner: scenes still to render, storage, GPU-hours and low/mid/high cost at marketplace rates.
- [ ] Per-tenant branding and read-only share links with expiring tokens.
- [ ] Coverage trend: put `coverage_pct` and the scene count in the nightly KPI snapshot so the matrix has a trend line.
- [ ] Third coverage axis: route class as a switchable dimension, and a per-family matrix on the scenario tab.
- [ ] "Fill this gap" action on a matrix cell: queue N generated variants for that visibility × lighting × route class.
- [ ] Plan vs actual: chart budgeted GPU-hours and spend against what training runs actually consumed.
- [ ] Export the coverage matrix and the budget plan as CSV and as a printable partner-report section.

## Toolkit and pipeline features

- [x] `scripts/convert_run.py`: GPX, MCAP and Traccar exports into a run directory.
- [x] `scripts/export_scenario.py`: OpenSCENARIO export of one template, a family or the whole library.
- [x] Driving score in `quality.json` and in the dashboard's `finish` step.
- [ ] Redaction step (EgoBlur or understand.ai anonymizer) that flips `redaction_status`.
- [ ] Batch runner: run every template of a family in CARLA and upload with one command.
- [ ] Route-to-scenario generator: sample templates from a real GNSS trace's archetypes.
- [ ] Scenario diff tool: what changed between two library versions and which reviews it invalidated.
- [ ] ROS 2 native bridge recipe: record CARLA UE5 ROS 2 topics into MCAP and ingest.
- [ ] `scripts/plan_capacity.py`: the dashboard's budget model as a CLI, for planning offline and in proposals.
- [ ] `scripts/render_gaps.py`: read `GET /api/coverage`, generate variants for the worst cells and render them in batch.

## Platform and engineering

- [x] Worker unit tests (`npm test`) for router, auth, exports, OpenSCENARIO, driving score and metrics.
- [x] D1 migration `0002_fleet_and_scores.sql`.
- [ ] Vitest with `@cloudflare/vitest-pool-workers` for end-to-end route tests against Miniflare.
- [ ] Cloudflare Access / SSO in front of the dashboard; keep bearer tokens for machine clients.
- [ ] Key rotation for `MANIFEST_SIGNING_KEY` with multiple `key_id`s.
- [ ] Rate limiting per token on write endpoints.
- [ ] Retention policy job: expire raw chunks of rejected runs after N days.

## Iteration log

Newest first. Each iteration ships one feature and leaves the open items above
re-ranked.

### 2026-09-09 — ODD coverage matrix and compute budget planner

1. `GET /api/coverage`: visibility × lighting matrix over the scenario library
   and the runs recorded against it, with `covered` / `thin` / `gap` per cell,
   route-class totals and the gaps ranked worst first. Runs with no scenario
   behind them are shown in an `unlabelled` row and column but excluded from
   the coverage percentage.
2. `GET /api/plan`: dataset-scale and GPU-budget model — scenes still to
   render, storage, generation and training GPU-hours, and low/mid/high cost at
   marketplace rates, defaulting to values measured from the tenant's own
   catalog (accepted runs, mean run duration, mean clip size).
3. **Coverage & compute** tab: the matrix, a route-class chart, a ranked gap
   list and an interactive planner (tier, scenes, workload, GPU, capture,
   interruptible) with a line-item cost table and its assumptions written out.
4. Prometheus: `atlas_coverage_pct`, `atlas_coverage_cells{,_covered,_gap}` and
   `atlas_dataset_scenes` for Grafana alerting on coverage regressions.
5. `dashboard/test/dataset_plan.test.ts`: 12 unit tests over the coverage
   classification and every branch of the cost model.

### Earlier — exports, scenario interchange and live fleet

1. MCAP, GeoJSON and CSV export endpoints plus the Foxglove deep link.
2. OpenSCENARIO export in both the Worker and the Python toolkit.
3. Leaderboard-style driving score stored on every finished run.
4. Traccar and generic position ingestion with a live Fleet tab.
5. Prometheus metrics and an OpenAPI description of the API.
6. Front end: KPI trends, export menu, XOSC download, hash routing.
7. Python adapters (GPX, MCAP, Traccar) and `convert_run.py`.
8. Worker unit-test suite and CI updates.
