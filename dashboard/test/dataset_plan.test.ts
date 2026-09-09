import { test } from "node:test";
import assert from "node:assert/strict";
import { GPUS, INTERRUPTIBLE_FACTOR, TIERS, WORKLOADS, buildCoverage, planDataset, tierFor } from "../src/dataset_plan";

const scenario = (visibility: string, lighting: string, route: string, variants = 1, review = "unreviewed") => ({
  visibility_class: visibility,
  lighting_class: lighting,
  route_class: route,
  review_status: review,
  variants,
});

test("the coverage matrix crosses every visibility with every lighting class", () => {
  const cov = buildCoverage(
    [scenario("clear", "daylight", "straight_flat", 4, "reviewed"), scenario("fog", "night", "hairpin_flat", 2)],
    [],
  );
  assert.deepEqual(cov.axes.visibility, ["clear", "fog"]);
  assert.deepEqual(cov.axes.lighting, ["daylight", "night"]);
  assert.equal(cov.cells.length, 4);
  assert.equal(cov.totals.scenarios, 6);
  // Variants without runs are thin, empty crossings are gaps.
  const clearDay = cov.cells.find((c) => c.visibility === "clear" && c.lighting === "daylight")!;
  assert.equal(clearDay.status, "thin");
  assert.equal(clearDay.reviewed, 4);
  assert.equal(cov.cells.find((c) => c.visibility === "clear" && c.lighting === "night")!.status, "gap");
  assert.equal(cov.totals.gap_cells, 2);
  assert.equal(cov.totals.coverage_pct, 0);
});

test("a cell turns covered once it has enough accepted runs", () => {
  const runs = [
    { visibility_class: "clear", lighting_class: "daylight", route_class: "straight_flat", quality_status: "accepted", runs: 3, duration_s: 180, distance_km: 12 },
    { visibility_class: "clear", lighting_class: "daylight", route_class: "straight_flat", quality_status: "rejected", runs: 1, duration_s: 60, distance_km: 4 },
  ];
  const cov = buildCoverage([scenario("clear", "daylight", "straight_flat", 5)], runs);
  const cell = cov.cells[0];
  assert.equal(cell.runs, 4);
  assert.equal(cell.accepted_runs, 3);
  assert.equal(cell.status, "covered");
  assert.equal(cov.totals.covered_cells, 1);
  assert.equal(cov.totals.coverage_pct, 100);
  assert.deepEqual(cov.gaps, []);
  assert.equal(cov.by_route_class[0].duration_s, 240);
  // Raising the bar per cell takes the same data back to thin.
  assert.equal(buildCoverage([scenario("clear", "daylight", "straight_flat", 5)], runs, 5).cells[0].status, "thin");
});

test("runs without a scenario land in an unlabelled bucket rather than being dropped", () => {
  const cov = buildCoverage(
    [scenario("clear", "daylight", "straight_flat")],
    [{ visibility_class: null, lighting_class: null, route_class: null, quality_status: "accepted", runs: 2, duration_s: 100, distance_km: 8 }],
  );
  assert.ok(cov.axes.visibility.includes("unlabelled"));
  assert.equal(cov.axes.visibility[cov.axes.visibility.length - 1], "unlabelled");
  assert.equal(cov.totals.runs, 2);
  assert.equal(cov.cells.find((c) => c.visibility === "unlabelled" && c.lighting === "unlabelled")!.accepted_runs, 2);
  assert.equal(cov.by_route_class.find((r) => r.route_class === "unlabelled")!.runs, 2);
  // The unlabelled row and column are shown but are not ODD cells, so the only
  // cell counted here is clear x daylight, which has variants but no runs.
  assert.equal(cov.cells.length, 4);
  assert.equal(cov.totals.cells, 1);
  assert.equal(cov.totals.thin_cells, 1);
  assert.equal(cov.totals.gap_cells, 0);
  assert.deepEqual(cov.gaps.map((g) => `${g.visibility}/${g.lighting}`), ["clear/daylight"]);
});

test("gaps are ordered worst first", () => {
  const cov = buildCoverage(
    [scenario("clear", "daylight", "straight_flat", 9), scenario("fog", "daylight", "curve_flat", 1), scenario("fog", "night", "hairpin_flat", 1)],
    [{ visibility_class: "clear", lighting_class: "daylight", route_class: "straight_flat", quality_status: "accepted", runs: 2, duration_s: 120, distance_km: 8 }],
  );
  // Empty cells first, then cells with variants but no runs (ties keep axis
  // order), then the thin cell that already has some accepted runs.
  assert.deepEqual(cov.gaps.map((g) => `${g.visibility}/${g.lighting}`), ["clear/night", "fog/daylight", "fog/night", "clear/daylight"]);
});

test("tiers are picked by scene count", () => {
  assert.equal(tierFor(500).id, "poc");
  assert.equal(tierFor(1_000).id, "poc");
  assert.equal(tierFor(10_000).id, "adaptation");
  assert.equal(tierFor(250_000).id, "robust");
  assert.equal(TIERS[TIERS.length - 1].max_scenes, null);
});

test("a fine-tune plan stays in the published GPU-hour and cost band", () => {
  const plan = planDataset({ scenes: 100_000, have_scenes: 0, workload: "finetune", gpu: "a100_80gb", seconds_per_scene: 20 });
  assert.equal(plan.tier.id, "robust");
  assert.equal(plan.scenes.short, 100_000);
  // 1-10 A100-hours per 1k scenes plus 20% preprocessing overhead.
  assert.equal(plan.training.gpu_hours.low, 120);
  assert.equal(plan.training.gpu_hours.high, 1200);
  assert.equal(plan.training.cost_usd.low, Math.round(120 * GPUS.a100_80gb.hourly.low));
  assert.ok(plan.training.cost_usd.high <= 2500, "fine-tune high end stays near the $1k-scale band");
  assert.ok(plan.total_cost_usd.low < plan.total_cost_usd.mid && plan.total_cost_usd.mid < plan.total_cost_usd.high);
});

test("from-scratch training on 100k scenes lands in the thousands, not the hundreds", () => {
  const plan = planDataset({ scenes: 100_000, workload: "scratch", gpu: "a100_80gb" });
  assert.equal(plan.workload.id, WORKLOADS.scratch.id);
  assert.ok(plan.training.gpu_hours.low >= 5_000, `expected >=5000 GPU-hours, got ${plan.training.gpu_hours.low}`);
  assert.ok(plan.training.cost_usd.high >= 20_000, `expected >=$20k at the high end, got ${plan.training.cost_usd.high}`);
});

test("an H100 needs fewer hours than an A100 for the same job", () => {
  const a100 = planDataset({ scenes: 50_000, workload: "medium", gpu: "a100_80gb" });
  const h100 = planDataset({ scenes: 50_000, workload: "medium", gpu: "h100_80gb" });
  assert.ok(h100.training.gpu_hours.mid < a100.training.gpu_hours.mid);
  assert.equal(h100.training.gpu_hours.mid, Math.round((a100.training.gpu_hours.mid / GPUS.h100_80gb.throughput) * 10) / 10);
});

test("interruptible instances discount every rate", () => {
  const plan = planDataset({ scenes: 10_000, gpu: "a100_80gb", interruptible: true });
  assert.equal(plan.rate_usd_per_hour.mid, Math.round(GPUS.a100_80gb.hourly.mid * INTERRUPTIBLE_FACTOR * 1000) / 1000);
  const explicit = planDataset({ scenes: 10_000, rate_usd_per_hour: 0.75 });
  assert.deepEqual(explicit.rate_usd_per_hour, { low: 0.75, mid: 0.75, high: 0.75 });
});

test("storage follows the capture description and a measured clip size overrides it", () => {
  // 20 s at 8 Mbit/s = 20 MB, plus 10% for telemetry and labels.
  const plan = planDataset({ scenes: 100_000, seconds_per_scene: 20, resolution: "1080p", camera_streams: 1 });
  assert.equal(plan.dataset.mb_per_scene, 22);
  assert.equal(plan.storage.gb.mid, 2200);
  assert.ok(plan.storage.cost_usd_per_month.mid > 0);
  const measured = planDataset({ scenes: 1_000, mb_per_scene: 4 });
  assert.equal(measured.dataset.mb_per_scene, 4);
  assert.equal(measured.storage.gb.mid, 4);
  assert.equal(measured.dataset.resolution, null);
  assert.ok(measured.assumptions.some((a) => a.includes("measured from clips")));
  // Three camera streams triple both the bytes and the render time.
  const multi = planDataset({ scenes: 100_000, seconds_per_scene: 20, resolution: "1080p", camera_streams: 3 });
  assert.equal(multi.dataset.mb_per_scene, 66);
  assert.ok(Math.abs(multi.generation.gpu_hours.mid - 3 * plan.generation.gpu_hours.mid) < 1);
});

test("generation cost covers only the scenes that are still missing", () => {
  const plan = planDataset({ scenes: 10_000, have_scenes: 10_000, seconds_per_scene: 60 });
  assert.equal(plan.scenes.short, 0);
  assert.deepEqual(plan.generation.gpu_hours, { low: 0, mid: 0, high: 0 });
  assert.deepEqual(plan.generation.cost_usd, { low: 0, mid: 0, high: 0 });
  assert.ok(plan.assumptions.some((a) => a.includes("no generation cost")));
  // 4,000 scenes x 60 s at real time is 4000 minutes of rendering.
  const partial = planDataset({ scenes: 10_000, have_scenes: 6_000, seconds_per_scene: 60 });
  assert.equal(partial.generation.gpu_hours.mid, Math.round((4_000 * 60) / 3600 * 10) / 10);
  assert.equal(partial.generation.gpu_hours.low, Math.round((4_000 * 60) / 3600 / 2 * 10) / 10);
});

test("out-of-range inputs fall back to defaults instead of producing nonsense", () => {
  const plan = planDataset({ scenes: Number.NaN, seconds_per_scene: -5, camera_streams: 99, workload: "nope" as never, gpu: "gpu9000" });
  assert.equal(plan.tier.id, "adaptation");
  assert.equal(plan.scenes.target, TIERS[1].min_scenes);
  assert.equal(plan.dataset.seconds_per_scene, 1);
  assert.equal(plan.dataset.camera_streams, 12);
  assert.equal(plan.workload.id, "finetune");
  assert.equal(plan.gpu.id, "a100_80gb");
});
