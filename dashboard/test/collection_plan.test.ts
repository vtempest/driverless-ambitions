import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCollectionPlan, familyProfiles, normalizeOptions, type LibraryRow } from "../src/collection_plan";
import { lightingClassOf, routeClassOf, visibilityClassOf } from "../src/odd";

const libraryPath = fileURLToPath(new URL("../../toolkit/scenarios/library.json", import.meta.url));
const generated = JSON.parse(readFileSync(libraryPath, "utf8")) as { scenarios: Array<Record<string, any>> };

/** The toolkit's generated library, in the shape the D1 rows arrive in. */
const library: LibraryRow[] = generated.scenarios.map((s) => ({
  scenario_id: s.id,
  family: s.family,
  group_name: s.group,
  name: s.name,
  description: s.description,
  tags: s.tags,
  params: s.params,
  actors: s.actors,
  expected_events: s.expected_events,
  route_class: s.route_class,
  lighting_class: s.lighting_class,
  visibility_class: s.visibility_class,
  review_status: s.review_status,
}));

/** Coverage rows for the same library, which is what an imported tenant has. */
const scenarioRows = library.map((s) => ({
  route_class: s.route_class ?? null,
  lighting_class: s.lighting_class ?? null,
  visibility_class: s.visibility_class ?? null,
  review_status: s.review_status ?? null,
  variants: 1,
}));

const run = (visibility: string, lighting: string, route: string, runs = 1, quality = "accepted") => ({
  visibility_class: visibility,
  lighting_class: lighting,
  route_class: route,
  quality_status: quality,
  runs,
  duration_s: 300 * runs,
  distance_km: 4 * runs,
});

test("the plan turns every uncovered cell into route-class targets, worst first", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { max_targets: 8 });
  assert.equal(plan.targets.length, 8);
  assert.ok(plan.totals.runs_needed > 0);
  // Priority is monotonically non-increasing, and the hardest condition leads.
  for (let i = 1; i < plan.targets.length; i++) assert.ok(plan.targets[i - 1].priority >= plan.targets[i].priority);
  const first = plan.targets[0];
  assert.equal(first.visibility, "fog");
  assert.equal(first.lighting, "night");
  assert.equal(first.route_class, "hairpin_steep_descent");
  // Nothing is driven yet, so every cell needs the full quota.
  assert.equal(first.accepted_runs, 0);
  assert.equal(first.runs_needed, 3);
  assert.ok(plan.notes.some((n) => n.includes("further targets are open")));
});

test("accepted runs in a cell reduce that cell's target and can retire it", () => {
  const runs = [
    run("fog", "night", "hairpin_steep_descent", 3),
    run("fog", "night", "curve_steep_descent", 1),
    // Rejected runs do not count towards closing a cell.
    run("heavy_rain", "night", "hairpin_steep_descent", 5, "rejected"),
  ];
  const plan = buildCollectionPlan(scenarioRows, runs, library, { max_targets: 200 });
  const at = (v: string, l: string, r: string) => plan.targets.find((t) => t.visibility === v && t.lighting === l && t.route_class === r);
  assert.equal(at("fog", "night", "hairpin_steep_descent"), undefined, "a cell at quota is no longer a target");
  const partial = at("fog", "night", "curve_steep_descent")!;
  assert.equal(partial.accepted_runs, 1);
  assert.equal(partial.runs_needed, 2);
  const rejected = at("heavy_rain", "night", "hairpin_steep_descent")!;
  assert.equal(rejected.runs, 5);
  assert.equal(rejected.accepted_runs, 0);
  assert.equal(rejected.runs_needed, 3);
});

test("missing runs become clips at the planner's clip length", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { seconds_per_run: 600, clip_seconds: 10, max_targets: 3 });
  for (const target of plan.targets) {
    assert.equal(target.scenes_needed, target.runs_needed * 60);
    assert.equal(target.drive_hours, (target.runs_needed * 600) / 3600);
  }
  assert.equal(plan.totals.scenes_needed, plan.targets.reduce((n, t) => n + t.scenes_needed, 0));
  assert.equal(plan.totals.sim_scenes + plan.totals.vehicle_scenes, plan.totals.scenes_needed);
});

test("the backlog counts every open target, not only the ones returned", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { max_targets: 4 });
  assert.equal(plan.totals.targets, 4);
  assert.ok(plan.backlog.targets > plan.totals.targets);
  assert.ok(plan.backlog.runs_needed > plan.totals.runs_needed);
  assert.equal(plan.backlog.sim_scenes + plan.backlog.vehicle_scenes, plan.backlog.scenes_needed);
  // Priority puts the render-only cells first, so the driving work is below the
  // cut — the tile that reads 0 on the returned targets must not read 0 here.
  assert.equal(plan.totals.vehicle_scenes, 0);
  assert.ok(plan.backlog.vehicle_scenes > 0);
  assert.ok(plan.backlog.drive_hours > 0);
  // With nothing cut, the two agree on every shared figure.
  const all = buildCollectionPlan(scenarioRows, [], library, { max_targets: 200 });
  const { natural_drive_hours, unrenderable_targets, batch_size, ...shared } = all.totals;
  assert.ok(natural_drive_hours > 0 && unrenderable_targets === 0 && batch_size > 0);
  assert.deepEqual(all.backlog, shared);
});

test("a cell too rare to wait for is recommended for simulation, a common one for driving", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { max_targets: 200, gaps_only: false, drive_hours_cap: 40 });
  const fogNight = plan.targets.find((t) => t.visibility === "fog" && t.lighting === "night" && t.route_class === "hairpin_steep_descent")!;
  assert.equal(fogNight.recommended_source, "sim");
  assert.ok(fogNight.natural_drive_hours > 500, `expected a long wait, got ${fogNight.natural_drive_hours} h`);
  assert.match(fogNight.reason, /render it instead/);
  const clearDay = plan.targets.find((t) => t.visibility === "clear" && t.lighting === "daylight" && t.route_class === "straight_flat")!;
  assert.equal(clearDay.recommended_source, "vehicle");
  // 3 runs × 300 s ÷ (0.55 × 0.62 × 0.6 × 0.7 of on-road time), to one decimal
  // because a cell this cheap is decided by the fraction.
  assert.equal(clearDay.natural_drive_hours, 1.7);
  assert.match(clearDay.reason, /about 1\.7 h of driving/);
  // The easy cell still ranks below the hard one.
  assert.ok(fogNight.priority > clearDay.priority);
});

test("a condition no weather preset renders can only be driven", () => {
  const snow = [{ route_class: "curve_flat", lighting_class: "daylight", visibility_class: "snow", variants: 2 }];
  const plan = buildCollectionPlan([...scenarioRows, ...snow], [], library, { max_targets: 200 });
  const targets = plan.targets.filter((t) => t.visibility === "snow");
  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.equal(target.renderable, false);
    assert.equal(target.recommended_source, "vehicle");
    assert.equal(target.variants, 0);
    assert.match(target.reason, /only be closed on the road/);
  }
  assert.equal(plan.totals.unrenderable_targets, targets.length);
  assert.equal(plan.batch.filter((b) => b.target.visibility === "snow").length, 0);
});

test("every generated variant classifies into the cell it was generated for", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { max_targets: 20, variants_per_target: 3 });
  assert.equal(plan.batch.length, plan.totals.batch_size);
  assert.ok(plan.batch.length >= 20 * 3 - 3);
  const ids = new Set<string>();
  for (const item of plan.batch) {
    assert.equal(item.visibility_class, item.target.visibility, item.id);
    assert.equal(item.lighting_class, item.target.lighting, item.id);
    assert.equal(item.route_class, item.target.route_class, item.id);
    // The classes have to follow from the parameters, not just be asserted.
    assert.equal(visibilityClassOf(String(item.params.weather_preset)), item.target.visibility);
    assert.equal(lightingClassOf(String(item.params.time_of_day)), item.target.lighting);
    assert.equal(routeClassOf(Number(item.params.road_curvature), Number(item.params.grade_pct)), item.target.route_class);
    assert.ok(item.family, item.id);
    assert.ok(item.tags.includes("gap_fill"));
    assert.equal(item.review_status, "unreviewed");
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
    assert.match(item.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/, `id ${item.id} would be rejected on import`);
    for (const key of ["traffic_density", "lane_quality", "speed_limit_kph", "lane_width_m", "duration_s"]) {
      assert.ok(Number.isFinite(Number(item.params[key])), `${item.id} is missing ${key}`);
    }
    assert.ok(item.params.sensor_degradation && typeof item.params.sensor_degradation === "object");
  }
});

test("sensor degradation follows the condition rather than a random draw", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { max_targets: 200, gaps_only: false, variants_per_target: 1 });
  const degradation = (v: string, l: string) => {
    const item = plan.batch.find((b) => b.target.visibility === v && b.target.lighting === l)!;
    return item.params.sensor_degradation as Record<string, number>;
  };
  assert.ok(degradation("fog", "night").lidar_noise_m > degradation("clear", "daylight").lidar_noise_m);
  assert.ok(degradation("fog", "night").camera_blur > degradation("clear", "daylight").camera_blur);
  assert.ok(degradation("fog", "daylight").dropout_probability >= 0.02);
});

test("the same catalog always produces the same plan", () => {
  const options = { max_targets: 6, variants_per_target: 2 };
  const a = buildCollectionPlan(scenarioRows, [run("fog", "night", "curve_flat", 1)], library, options);
  const b = buildCollectionPlan(scenarioRows, [run("fog", "night", "curve_flat", 1)], library, options);
  assert.deepEqual(a, b);
});

test("family profiles recover each family's declared conditions from its variants", () => {
  const profiles = familyProfiles(library);
  assert.equal(profiles.length, 24);
  const fog = profiles.find((p) => p.family === "valley_fog")!;
  assert.deepEqual(fog.weather_presets.sort(), ["dense_fog", "valley_fog"]);
  assert.deepEqual(fog.times_of_day.sort(), ["dawn", "day"]);
  assert.equal(fog.group, "weather_light");
  assert.deepEqual(fog.actors.map((a) => a.role), ["lead_vehicle"]);
  assert.ok(fog.expected_events.includes("lead_vehicle_close"));
  assert.equal(fog.variants, 6);
  // Ranges are the observed spread, so a generated variant stays in family.
  const [low, high] = fog.ranges.speed_limit_kph;
  assert.ok(low <= high && low > 0);
});

test("a family is re-parameterised into conditions it never declared, preferring ones that did", () => {
  // Only the fog families declare fog; night glare is the only night family.
  const plan = buildCollectionPlan(scenarioRows, [], library, { max_targets: 200, gaps_only: false, variants_per_target: 2 });
  const fogTarget = plan.targets.find((t) => t.visibility === "fog" && t.lighting === "daylight")!;
  assert.ok(fogTarget.families.includes("valley_fog"), fogTarget.families.join(","));
  const dust = buildCollectionPlan(
    [...scenarioRows, { route_class: "straight_flat", lighting_class: "daylight", visibility_class: "dust", variants: 1 }],
    [],
    library,
    { max_targets: 200, variants_per_target: 1 },
  );
  const dustTargets = dust.targets.filter((t) => t.visibility === "dust");
  assert.ok(dustTargets.length > 0);
  // No family declares dust_haze, but the cell is renderable, so it still gets variants.
  assert.ok(dustTargets.every((t) => t.renderable));
  assert.ok(dust.batch.some((b) => b.target.visibility === "dust" && b.params.weather_preset === "dust_haze"));
});

test("an empty library plans the collection work and says why there is no batch", () => {
  const plan = buildCollectionPlan(scenarioRows, [], [], { max_targets: 5 });
  assert.equal(plan.targets.length, 5);
  assert.equal(plan.batch.length, 0);
  assert.equal(plan.families.length, 0);
  assert.ok(plan.notes.some((n) => n.includes("scenario library is empty")));
  assert.ok(plan.totals.runs_needed > 0);
});

test("with no catalog at all the plan falls back to every route class and says so", () => {
  const plan = buildCollectionPlan([], [], [], { max_targets: 4 });
  assert.equal(plan.targets.length, 0, "an empty catalog has no ODD axes to cross");
  const partial = buildCollectionPlan([{ route_class: null, lighting_class: "night", visibility_class: "fog", variants: 1 }], [], [], { max_targets: 4 });
  assert.ok(partial.notes.some((n) => n.includes("No route classes in the catalog")));
  assert.equal(partial.targets.length, 4);
});

test("route classes and cell inclusion can be narrowed by the caller", () => {
  const plan = buildCollectionPlan(scenarioRows, [], library, { route_classes: ["hairpin_steep_descent", "not_a_class"], max_targets: 200 });
  assert.ok(plan.targets.length > 0);
  assert.ok(plan.targets.every((t) => t.route_class === "hairpin_steep_descent"));
  // A cell the matrix calls covered still has its untouched roads open, unless
  // the caller asks for gaps only.
  const runs = [run("clear", "daylight", "straight_flat", 3)];
  const open = buildCollectionPlan(scenarioRows, runs, library, { max_targets: 200 });
  assert.ok(!open.targets.some((t) => t.visibility === "clear" && t.lighting === "daylight" && t.route_class === "straight_flat"));
  const stillOpen = open.targets.find((t) => t.visibility === "clear" && t.lighting === "daylight" && t.route_class === "hairpin_steep_descent")!;
  assert.equal(stillOpen.cell_status, "covered");
  assert.equal(stillOpen.runs_needed, 3);
  const gapsOnly = buildCollectionPlan(scenarioRows, runs, library, { max_targets: 200, gaps_only: true });
  assert.ok(!gapsOnly.targets.some((t) => t.visibility === "clear" && t.lighting === "daylight"));
});

test("options are clamped and unknown values fall back to the defaults", () => {
  const options = normalizeOptions({ min_runs_per_cell: "500", variants_per_target: "-3", clip_seconds: "", seconds_per_run: "abc", max_targets: 7.4, route_classes: "curve_flat, nope", gaps_only: "true", vehicle_class: " shuttle " });
  assert.equal(options.min_runs_per_cell, 100);
  assert.equal(options.variants_per_target, 0);
  assert.equal(options.clip_seconds, 10);
  assert.equal(options.seconds_per_run, 300);
  assert.equal(options.max_targets, 7);
  assert.deepEqual(options.route_classes, ["curve_flat"]);
  assert.equal(options.gaps_only, true);
  assert.equal(options.vehicle_class, "shuttle");
  const zero = buildCollectionPlan(scenarioRows, [], library, { variants_per_target: 0, max_targets: 2 });
  assert.equal(zero.batch.length, 0);
  assert.equal(zero.targets.length, 2);
});
