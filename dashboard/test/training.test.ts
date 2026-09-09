import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  GPU_OPTIONS,
  INTERRUPTIBLE_FACTOR,
  REFERENCE_SCENES,
  WORKLOADS,
  type DatasetInventory,
  planTraining,
  recommendations,
  renderPlanMarkdown,
  scaleGpuHours,
  summariseCoverage,
  tierFor,
} from "../src/training";

function inventory(overrides: Partial<DatasetInventory> = {}): DatasetInventory {
  const base: DatasetInventory = {
    scenes: 2_000,
    clips: 1_500,
    clips_released: 900,
    runs: 600,
    runs_with_clips: 100,
    sim_runs: 400,
    vehicle_runs: 200,
    hours: 120,
    distance_km: 4_200,
    stored_bytes: 30_000_000_000,
    measured_bytes_per_scene: 20_000_000,
    avg_scene_seconds: 30,
    coverage: summariseCoverage([
      { lighting: "day", visibility: "clear", route_class: "urban", n: 60 },
      { lighting: "day", visibility: "rain", route_class: "highway", n: 30 },
      { lighting: "night", visibility: "clear", route_class: "rural", n: 2 },
    ]),
  };
  return { ...base, ...overrides };
}

test("tiers follow the dataset-size rule of thumb", () => {
  assert.equal(tierFor(500), null);
  assert.equal(tierFor(1_000)?.id, "poc");
  assert.equal(tierFor(9_999)?.id, "poc");
  assert.equal(tierFor(10_000)?.id, "adaptation");
  assert.equal(tierFor(250_000)?.id, "robust");
});

test("GPU-hour bands scale from the reference dataset size and clamp", () => {
  const finetune = WORKLOADS[0];
  const atReference = scaleGpuHours(finetune, REFERENCE_SCENES);
  assert.deepEqual(atReference, { low: finetune.gpu_hours_low, high: finetune.gpu_hours_high, scale: 1 });
  assert.equal(scaleGpuHours(finetune, REFERENCE_SCENES / 2).scale, 0.5);
  assert.equal(scaleGpuHours(finetune, 10).scale, 0.25, "tiny sets still pay pipeline overhead");
  assert.equal(scaleGpuHours(finetune, 10_000_000).scale, 4, "huge sets get subsampled, not billed linearly");
});

test("coverage flags thin buckets and empty matrix cells", () => {
  const coverage = summariseCoverage([
    { lighting: "day", visibility: "clear", route_class: "urban", n: 96 },
    { lighting: "night", visibility: "fog", route_class: "rural", n: 4 },
  ]);
  const lighting = coverage.dimensions.find((d) => d.dimension === "lighting")!;
  assert.deepEqual(lighting.gaps, ["night"]);
  assert.equal(lighting.buckets[0].bucket, "day");
  assert.equal(lighting.buckets[0].share, 0.96);
  // 2 route classes x 2 lighting buckets, only 2 of the 4 cells are populated.
  assert.equal(coverage.matrix.cells.length, 4);
  assert.equal(coverage.matrix.empty_cells, 2);
  assert.equal(coverage.unspecified_share, 0);
});

test("scenes with no scenario conditions are counted as unspecified", () => {
  const coverage = summariseCoverage([
    { lighting: "day", visibility: "clear", route_class: "urban", n: 3 },
    { lighting: "unspecified", visibility: "unspecified", route_class: "unspecified", n: 1 },
  ]);
  assert.equal(coverage.unspecified_share, 0.25);
  const lighting = coverage.dimensions.find((d) => d.dimension === "lighting")!;
  assert.deepEqual(lighting.gaps, [], "unspecified is reported but is not itself a coverage gap");
});

test("the default target is the next tier and the budget follows the GPU-hour band", () => {
  const inv = inventory();
  const plan = planTraining(inv, { workload: "finetune", gpu: "a100_80gb" });
  assert.equal(plan.current_tier?.id, "poc");
  assert.equal(plan.next_tier?.id, "adaptation");
  assert.equal(plan.target_scenes, 10_000);
  assert.equal(plan.scenes_to_next_tier, 8_000);

  const scaled = scaleGpuHours(WORKLOADS[0], 10_000);
  const preprocess = Math.round((10_000 * DEFAULTS.preprocess_gpu_s_per_scene) / 3600);
  assert.equal(plan.compute.preprocess_gpu_hours, preprocess);
  assert.equal(plan.compute.gpu_hours.low, scaled.low + preprocess);
  assert.equal(plan.compute.gpu_hours.high, scaled.high + preprocess);

  const a100 = GPU_OPTIONS[0];
  assert.deepEqual(plan.compute.rate_usd_hr, a100.on_demand);
  assert.equal(plan.compute.cost_usd.low, Math.round(plan.compute.gpu_hours.low * a100.on_demand.low));
  assert.equal(plan.total_usd.low, plan.compute.cost_usd.low + Math.round(plan.storage.disk_usd));
  assert.ok(plan.total_usd.low <= plan.total_usd.typical && plan.total_usd.typical <= plan.total_usd.high);
});

test("storage uses measured clip size and sizes the instance disk above the marketplace default", () => {
  const plan = planTraining(inventory(), { scenes: 100_000 });
  assert.equal(plan.storage.bytes_per_scene_source, "measured");
  assert.equal(plan.storage.dataset_gb, 2_000, "100k scenes x 20 MB");
  assert.equal(plan.storage.instance_disk_gb, 3_000);
  assert.equal(plan.storage.disk_usd, Math.round(3_000 * DEFAULTS.disk_usd_per_gb_month * 100) / 100);

  const empty = planTraining(inventory({ measured_bytes_per_scene: null }), { scenes: 100 });
  assert.equal(empty.storage.bytes_per_scene_source, "default");
  assert.equal(empty.storage.bytes_per_scene, DEFAULTS.bytes_per_scene);
  assert.equal(empty.storage.dataset_gb, 2.5);
  assert.equal(empty.storage.instance_disk_gb, DEFAULTS.default_instance_disk_gb, "small datasets keep the default disk");
});

test("interruptible pricing discounts the reference rate and an explicit rate overrides both", () => {
  const spot = planTraining(inventory(), { gpu: "h100_pcie", pricing: "interruptible" });
  const h100 = GPU_OPTIONS.find((g) => g.id === "h100_pcie")!;
  assert.equal(spot.compute.rate_usd_hr.typical, Math.round(h100.on_demand.typical * INTERRUPTIBLE_FACTOR * 100) / 100);
  assert.equal(spot.compute.rate_source, "reference");

  const fixed = planTraining(inventory(), { gpu: "h100_pcie", pricing: "interruptible", rate_usd_hr: 0.9 });
  assert.deepEqual(fixed.compute.rate_usd_hr, { low: 0.9, typical: 0.9, high: 0.9 });
  assert.equal(fixed.compute.rate_source, "override");
});

test("unknown workloads and GPUs fall back instead of failing", () => {
  const plan = planTraining(inventory(), { workload: "nope", gpu: "nope" });
  assert.equal(plan.compute.workload.id, WORKLOADS[0].id);
  assert.equal(plan.compute.gpu.id, GPU_OPTIONS[0].id);
});

test("recommendations name the tier gap, the thin conditions and short sequences", () => {
  const inv = inventory({ avg_scene_seconds: 4 });
  const recs = recommendations(inv, planTraining(inv));
  const ids = recs.map((r) => r.id);
  assert.ok(ids.includes("tier"));
  assert.ok(ids.includes("coverage:lighting"), "night is under 5 % of scenes");
  assert.ok(ids.includes("matrix"));
  assert.ok(ids.includes("sequence"));
  assert.match(recs.find((r) => r.id === "sequence")!.message, /4\.0 s/);
});

test("a top-tier dataset is told to chase rare events, not volume", () => {
  const inv = inventory({ scenes: 250_000 });
  const plan = planTraining(inv);
  assert.equal(plan.next_tier, null);
  assert.equal(plan.scenes_to_next_tier, 0);
  assert.match(recommendations(inv, plan).find((r) => r.id === "tier")!.message, /rare events/);
});

test("the markdown memo carries the totals and the assumptions", () => {
  const inv = inventory();
  const plan = planTraining(inv, { workload: "medium", gpu: "a100_80gb" });
  const md = renderPlanMarkdown(inv, plan, recommendations(inv, plan), "bhutan", "2026-09-09T00:00:00.000Z");
  assert.match(md, /# Training-set and compute budget — bhutan/);
  assert.match(md, /\| Typical \|/);
  assert.ok(md.includes("$" + plan.total_usd.high.toLocaleString("en-US")));
  for (const a of plan.assumptions) assert.ok(md.includes(a), `memo states: ${a}`);
});
