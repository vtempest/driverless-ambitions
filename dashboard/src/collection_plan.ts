/**
 * Collection plan: the ODD coverage gap turned into work.
 *
 * src/coverage.ts answers "which parts of the ODD are missing?" and stops
 * there. This module answers the next three questions, which is what a pilot
 * month is actually planned from:
 *
 *   1. How much is missing per cell — runs, and the clips they cut into —
 *      once the cell is split by route class as well as weather and lighting.
 *   2. Whether that cell is worth waiting for on the road, or has to be
 *      rendered. A night-fog hairpin descent is a few ten-thousandths of
 *      driving time, so waiting for it costs hundreds of hours; clear daylight
 *      on a straight road arrives on its own.
 *   3. Which scenario variants to generate. The output carries a batch of
 *      templates in the shape POST /api/scenarios/import accepts, so the plan
 *      is a runnable next step rather than a reading exercise: import it, then
 *      export each variant as OpenSCENARIO for ScenarioRunner or esmini.
 *
 * The families come from the tenant's own library rather than a copy of the
 * taxonomy: a family's declared conditions, actors, expected events and
 * parameter ranges are all recoverable from the variants already imported, and
 * a new variant for a gap cell is that family re-parameterised into the missing
 * condition. Nothing here reads D1 or the clock — routes/collection_plan.ts
 * supplies the rows and fills in the content hashes.
 */

import { buildCoverage, type CellStatus, type CoverageMatrix, type RunCoverageRow, type ScenarioCoverageRow } from "./coverage";
import { geometryForRouteClass, lightingClassOf, presetsFor, routeClassOf, routeClasses, splitRouteClass, timesFor, visibilityClassOf, type SourceKind } from "./odd";

const UNLABELLED = "unlabelled";

/** A scenario row with everything a new variant of the same family needs. */
export interface LibraryRow extends ScenarioCoverageRow {
  scenario_id?: string | null;
  family: string;
  group_name?: string | null;
  name?: string | null;
  description?: string | null;
  tags?: string[];
  params?: Record<string, unknown> | null;
  actors?: Array<Record<string, unknown>> | null;
  expected_events?: string[] | null;
}

export interface CollectionPlanOptions {
  /** Accepted runs a cell needs before it counts as covered. */
  min_runs_per_cell: number;
  /** Mean length of an accepted run, seconds — how much driving one run is. */
  seconds_per_run: number;
  /** Clip length the corpus is counted in, seconds; matches the planner's. */
  clip_seconds: number;
  /** How many (visibility, lighting, route class) targets to return. */
  max_targets: number;
  /** Scenario variants to generate per target. */
  variants_per_target: number;
  /** Ego class the generated variants are written for. */
  vehicle_class: string;
  /** Above this many expected on-road hours, the cell is recommended for sim. */
  drive_hours_cap: number;
  /** Restrict targets to these route classes; empty means "whatever the catalog uses". */
  route_classes: string[];
  /**
   * Plan only the cells the matrix reports as thin or empty. Off by default,
   * because a cell counts as covered on three accepted runs wherever they were
   * driven: a condition seen only on a straight flat road still has every
   * hairpin and descent open, and those are the runs that matter most.
   */
  gaps_only: boolean;
}

export const DEFAULT_OPTIONS: CollectionPlanOptions = {
  min_runs_per_cell: 3,
  seconds_per_run: 300,
  clip_seconds: 10,
  max_targets: 12,
  variants_per_target: 3,
  vehicle_class: "truck",
  drive_hours_cap: 40,
  route_classes: [],
  gaps_only: false,
};

/**
 * Relative safety value of a condition. Degraded visibility and darkness are
 * where the ODD risk concentrates — they are also what a model trained on
 * clear-daylight footage has never seen — so a run there is worth more than a
 * run in the easy cell. Used only to order the work, never to size it.
 */
export const RISK_WEIGHT_VISIBILITY: Record<string, number> = { clear: 1, wet: 1.3, rain: 1.5, heavy_rain: 1.9, fog: 2.2, dust: 1.4, snow: 1.8 };
export const RISK_WEIGHT_LIGHTING: Record<string, number> = { daylight: 1, low_light: 1.5, night: 1.8 };
export const RISK_WEIGHT_GEOMETRY: Record<string, number> = { straight: 1, curve: 1.3, hairpin: 1.6 };
export const RISK_WEIGHT_SLOPE: Record<string, number> = { flat: 1, steep_climb: 1.2, steep_descent: 1.5 };

/**
 * Share of on-road time a condition is expected to hold on the pilot corridor,
 * as a fraction; each table sums to 1. Rough field estimates for a Himalayan
 * monsoon climate, not measurements — they exist to answer "can this cell be
 * waited for?", and the answer is only ever an order of magnitude.
 */
export const NATURAL_SHARE_VISIBILITY: Record<string, number> = { clear: 0.55, wet: 0.12, rain: 0.15, heavy_rain: 0.06, fog: 0.08, dust: 0.01, snow: 0.03 };
export const NATURAL_SHARE_LIGHTING: Record<string, number> = { daylight: 0.62, low_light: 0.13, night: 0.25 };
export const NATURAL_SHARE_GEOMETRY: Record<string, number> = { straight: 0.6, curve: 0.3, hairpin: 0.1 };
export const NATURAL_SHARE_SLOPE: Record<string, number> = { flat: 0.7, steep_climb: 0.15, steep_descent: 0.15 };

/** Parameters a generated variant samples from the family's observed spread. */
const SAMPLED_PARAMS: Array<{ key: string; fallback: number; decimals: number }> = [
  { key: "traffic_density", fallback: 0.2, decimals: 3 },
  { key: "lane_quality", fallback: 0.7, decimals: 3 },
  { key: "speed_limit_kph", fallback: 40, decimals: 0 },
  { key: "lane_width_m", fallback: 3.3, decimals: 2 },
  { key: "payload_kg", fallback: 0, decimals: 0 },
  { key: "duration_s", fallback: 60, decimals: 0 },
];

export interface FamilyProfile {
  family: string;
  group: string;
  name: string;
  description: string;
  tags: string[];
  /** Variants of this family already in the library. */
  variants: number;
  weather_presets: string[];
  times_of_day: string[];
  route_classes: string[];
  actors: Array<Record<string, unknown>>;
  expected_events: string[];
  ranges: Record<string, [number, number]>;
}

export interface GeneratedScenario {
  id: string;
  family: string;
  group: string;
  name: string;
  description: string;
  tags: string[];
  params: Record<string, unknown>;
  actors: Array<Record<string, unknown>>;
  expected_events: string[];
  seed: number;
  version: string;
  schema_version: string;
  review_status: "unreviewed";
  route_class: string;
  lighting_class: string;
  visibility_class: string;
  /** sha256 of the replay-relevant content; filled in by the route layer. */
  content_hash?: string;
  /** The gap cell this variant was generated to close. */
  target: { visibility: string; lighting: string; route_class: string };
}

export interface CollectionTarget {
  visibility: string;
  lighting: string;
  route_class: string;
  /** Status of the (visibility, lighting) cell this target sits in. */
  cell_status: CellStatus;
  scenarios: number;
  runs: number;
  accepted_runs: number;
  runs_needed: number;
  /** Clips of `clip_seconds` the missing runs cut into. */
  scenes_needed: number;
  drive_hours: number;
  /** Fraction of on-road time expected to be in this condition. */
  natural_share: number;
  /** Driving hours expected before the missing runs occur naturally. */
  natural_drive_hours: number;
  recommended_source: SourceKind;
  /** False when no weather preset reaches the cell, so sim cannot render it. */
  renderable: boolean;
  risk_weight: number;
  priority: number;
  families: string[];
  variants: number;
  reason: string;
}

export interface PlanTotals {
  targets: number;
  runs_needed: number;
  scenes_needed: number;
  sim_scenes: number;
  vehicle_scenes: number;
  /** Driving hours for the cells recommended for on-road collection. */
  drive_hours: number;
}

export interface CollectionPlan {
  options: CollectionPlanOptions;
  coverage: {
    cells: number;
    covered_cells: number;
    thin_cells: number;
    gap_cells: number;
    coverage_pct: number;
    min_runs_per_cell: number;
  };
  targets: CollectionTarget[];
  totals: PlanTotals & {
    /** Expected on-road hours if every returned target were waited for. */
    natural_drive_hours: number;
    unrenderable_targets: number;
    batch_size: number;
  };
  /**
   * The same figures over every open target, not just the `max_targets`
   * returned. Priority puts the hard, render-only cells first, so a short
   * target list can read as "nothing to drive" while most of the driving work
   * sits below the cut.
   */
  backlog: PlanTotals;
  batch: GeneratedScenario[];
  families: FamilyProfile[];
  notes: string[];
  assumptions: string[];
}

export function normalizeOptions(raw: Record<string, unknown> = {}): CollectionPlanOptions {
  const num = (key: keyof CollectionPlanOptions, min: number, max: number, fallback: number, round = false): number => {
    const given = raw[key];
    if (given === undefined || given === null || given === "") return fallback;
    const value = Number(given);
    if (!Number.isFinite(value)) return fallback;
    const clamped = Math.min(max, Math.max(min, value));
    return round ? Math.round(clamped) : clamped;
  };
  const list = (value: unknown): string[] => {
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return items.map((v) => String(v).trim()).filter((v) => v && routeClasses().includes(v));
  };
  return {
    min_runs_per_cell: num("min_runs_per_cell", 1, 100, DEFAULT_OPTIONS.min_runs_per_cell, true),
    seconds_per_run: num("seconds_per_run", 1, 86400, DEFAULT_OPTIONS.seconds_per_run),
    clip_seconds: num("clip_seconds", 0.1, 600, DEFAULT_OPTIONS.clip_seconds),
    max_targets: num("max_targets", 1, 200, DEFAULT_OPTIONS.max_targets, true),
    variants_per_target: num("variants_per_target", 0, 20, DEFAULT_OPTIONS.variants_per_target, true),
    vehicle_class: typeof raw.vehicle_class === "string" && raw.vehicle_class.trim() ? raw.vehicle_class.trim().slice(0, 32) : DEFAULT_OPTIONS.vehicle_class,
    drive_hours_cap: num("drive_hours_cap", 0, 100000, DEFAULT_OPTIONS.drive_hours_cap),
    route_classes: list(raw.route_classes),
    gaps_only: raw.gaps_only === true || raw.gaps_only === "true",
  };
}

const label = (value: string | null | undefined): string => (value && value.trim() ? value : UNLABELLED);

/** Stable string hash; port of bhutan_sim.taxonomy.hash_str. */
export function hashStr(value: string): number {
  let acc = 0;
  for (let i = 0; i < value.length; i++) acc = (acc * 31 + value.charCodeAt(i)) % 2 ** 31;
  return acc;
}

/** Small deterministic PRNG, so the same plan always generates the same batch. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Recover each family's declared conditions and parameter spread from the
 * variants already imported. A family that only ever appears in clear daylight
 * still describes a reusable situation — narrow lane, livestock, stalled truck —
 * and can be re-parameterised into a missing condition; the ranking in
 * `candidateFamilies` prefers the families that already declare it.
 */
export function familyProfiles(rows: LibraryRow[]): FamilyProfile[] {
  const byFamily = new Map<string, FamilyProfile>();
  for (const row of rows) {
    if (!row.family) continue;
    let profile = byFamily.get(row.family);
    if (!profile) {
      profile = {
        family: row.family,
        group: row.group_name || "",
        name: row.name || row.family,
        description: row.description || "",
        tags: [],
        variants: 0,
        weather_presets: [],
        times_of_day: [],
        route_classes: [],
        actors: [],
        expected_events: [],
        ranges: {},
      };
      byFamily.set(row.family, profile);
    }
    profile.variants += 1;
    const params = (row.params || {}) as Record<string, unknown>;
    const preset = typeof params.weather_preset === "string" ? params.weather_preset : "";
    const time = typeof params.time_of_day === "string" ? params.time_of_day : "";
    if (preset && !profile.weather_presets.includes(preset)) profile.weather_presets.push(preset);
    if (time && !profile.times_of_day.includes(time)) profile.times_of_day.push(time);
    const routeClass = label(row.route_class);
    if (routeClass !== UNLABELLED && !profile.route_classes.includes(routeClass)) profile.route_classes.push(routeClass);
    for (const tag of row.tags || []) if (!profile.tags.includes(tag)) profile.tags.push(tag);
    for (const event of row.expected_events || []) if (!profile.expected_events.includes(event)) profile.expected_events.push(event);
    // The first variant's actor list stands for the family: the taxonomy
    // declares roles and lanes per family and only jitters the distances.
    if (!profile.actors.length && Array.isArray(row.actors)) profile.actors = row.actors;
    for (const { key } of SAMPLED_PARAMS) {
      const value = Number(params[key]);
      if (!Number.isFinite(value)) continue;
      const range = profile.ranges[key];
      profile.ranges[key] = range ? [Math.min(range[0], value), Math.max(range[1], value)] : [value, value];
    }
  }
  return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** Families best able to carry a gap cell, best first. */
function candidateFamilies(profiles: FamilyProfile[], visibility: string, lighting: string, routeClass: string): FamilyProfile[] {
  const scored = profiles.map((profile) => {
    const declaresVisibility = profile.weather_presets.some((p) => visibilityClassOf(p) === visibility);
    const declaresLighting = profile.times_of_day.some((t) => lightingClassOf(t) === lighting);
    const declaresRoute = profile.route_classes.includes(routeClass);
    // Condition match first, then road shape, then the bigger family — a family
    // with more variants has the wider parameter spread to sample from.
    const score = (declaresVisibility ? 0 : 4) + (declaresLighting ? 0 : 2) + (declaresRoute ? 0 : 1);
    return { profile, score };
  });
  return scored.sort((a, b) => a.score - b.score || b.profile.variants - a.profile.variants || a.profile.family.localeCompare(b.profile.family)).map((s) => s.profile);
}

/** A road the classifier does not recognise is treated as an average one. */
const road = (routeClass: string) => splitRouteClass(routeClass) || { geometry: "", slope: "" };

function naturalShare(visibility: string, lighting: string, routeClass: string): number {
  const { geometry, slope } = road(routeClass);
  return (NATURAL_SHARE_VISIBILITY[visibility] ?? 0.02)
    * (NATURAL_SHARE_LIGHTING[lighting] ?? 0.1)
    * (NATURAL_SHARE_GEOMETRY[geometry] ?? 0.1)
    * (NATURAL_SHARE_SLOPE[slope] ?? 0.15);
}

function riskWeight(visibility: string, lighting: string, routeClass: string): number {
  const { geometry, slope } = road(routeClass);
  return (RISK_WEIGHT_VISIBILITY[visibility] ?? 1.2)
    * (RISK_WEIGHT_LIGHTING[lighting] ?? 1.2)
    * (RISK_WEIGHT_GEOMETRY[geometry] ?? 1.1)
    * (RISK_WEIGHT_SLOPE[slope] ?? 1.1);
}

/** Sensor degradation that matches the condition, not a random draw. */
function degradationFor(visibility: string, lighting: string, draw: () => number): Record<string, number> {
  const wet = visibility === "rain" || visibility === "heavy_rain" || visibility === "wet";
  const obscured = visibility === "fog" || visibility === "heavy_rain" || visibility === "dust";
  const dark = lighting === "night";
  return {
    camera_blur: round((dark ? 0.3 : 0) + (wet ? 0.2 : 0) + draw() * 0.1, 3),
    gnss_noise_m: round(1 + draw() * 2, 2),
    imu_accel_noise: round(0.05 + draw() * 0.05, 3),
    imu_gyro_noise: round(0.002 + draw() * 0.008, 4),
    lidar_noise_m: round((obscured ? 0.04 : 0.01) + draw() * 0.02, 3),
    dropout_probability: round((obscured ? 0.02 : 0) + draw() * 0.01, 3),
  };
}

function generateVariant(
  profile: FamilyProfile,
  target: { visibility: string; lighting: string; route_class: string },
  preset: string,
  timeOfDay: string,
  index: number,
  options: CollectionPlanOptions,
): GeneratedScenario {
  const seedKey = `${profile.family}|${target.visibility}|${target.lighting}|${target.route_class}|${index}`;
  const seed = hashStr(seedKey);
  const draw = rng(seed);
  const geometry = geometryForRouteClass(target.route_class) || { road_curvature: 0.01, grade_pct: 0 };
  const params: Record<string, unknown> = {
    weather_preset: preset,
    time_of_day: timeOfDay,
    vehicle_class: options.vehicle_class,
    road_curvature: geometry.road_curvature,
    grade_pct: geometry.grade_pct,
  };
  for (const { key, fallback, decimals } of SAMPLED_PARAMS) {
    const [low, high] = profile.ranges[key] || [fallback, fallback];
    params[key] = round(low + draw() * (high - low), decimals);
  }
  params.sensor_degradation = degradationFor(target.visibility, target.lighting, draw);
  const actors = (profile.actors || []).map((actor) => ({ ...actor }));
  const slug = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const id = `bt-gap-${slug(target.visibility)}-${slug(target.lighting)}-${slug(target.route_class)}-${slug(profile.family)}-${String(index + 1).padStart(2, "0")}`;
  return {
    id,
    family: profile.family,
    group: profile.group,
    name: `${profile.name.replace(/\s*\(variant \d+\)\s*$/, "")} — ${target.visibility.replace(/_/g, " ")} / ${target.lighting.replace(/_/g, " ")}`,
    description: `${profile.description} Generated to close the ${target.visibility} / ${target.lighting} gap on a ${target.route_class.replace(/_/g, " ")} road.`.trim(),
    tags: [...profile.tags.filter((t) => t !== "gap_fill"), "gap_fill"],
    params,
    actors,
    expected_events: [...profile.expected_events],
    seed,
    version: "1",
    schema_version: "1.0",
    review_status: "unreviewed",
    route_class: routeClassOf(Number(params.road_curvature), Number(params.grade_pct)),
    lighting_class: lightingClassOf(timeOfDay),
    visibility_class: visibilityClassOf(preset),
    target,
  };
}

/**
 * Build the plan. `scenarios` and `runs` are the same rows src/coverage.ts
 * consumes; `library` carries the scenario detail a generated variant is built
 * from, and may be empty (the plan then reports targets with no batch).
 */
export function buildCollectionPlan(
  scenarios: ScenarioCoverageRow[],
  runs: RunCoverageRow[],
  library: LibraryRow[] = [],
  rawOptions: Record<string, unknown> = {},
): CollectionPlan {
  const options = normalizeOptions(rawOptions);
  const coverage: CoverageMatrix = buildCoverage(scenarios, runs, options.min_runs_per_cell);
  const notes: string[] = [];

  // Three-way tally: the matrix crosses visibility with lighting, but a cell is
  // only closed when the missing *road* is driven in it too.
  const key = (v: string, l: string, r: string) => `${v} ${l} ${r}`;
  const tally = new Map<string, { scenarios: number; runs: number; accepted_runs: number }>();
  const bump = (v: string, l: string, r: string, field: "scenarios" | "runs" | "accepted_runs", n: number) => {
    const k = key(v, l, r);
    const entry = tally.get(k) || { scenarios: 0, runs: 0, accepted_runs: 0 };
    entry[field] += n;
    tally.set(k, entry);
  };
  const catalogRoutes = new Set<string>();
  for (const s of scenarios) {
    const route = label(s.route_class);
    if (route !== UNLABELLED) catalogRoutes.add(route);
    bump(label(s.visibility_class), label(s.lighting_class), route, "scenarios", s.variants ?? 1);
  }
  for (const r of runs) {
    const route = label(r.route_class);
    if (route !== UNLABELLED) catalogRoutes.add(route);
    const n = r.runs ?? 1;
    bump(label(r.visibility_class), label(r.lighting_class), route, "runs", n);
    if (r.quality_status === "accepted") bump(label(r.visibility_class), label(r.lighting_class), route, "accepted_runs", n);
  }

  // Route classes to plan for: the operator's choice, else the corridors the
  // catalog already knows, else every class the taxonomy can describe.
  let targetRoutes = options.route_classes;
  if (!targetRoutes.length) targetRoutes = [...catalogRoutes].filter((r) => routeClasses().includes(r)).sort();
  if (!targetRoutes.length) {
    targetRoutes = routeClasses();
    notes.push("No route classes in the catalog yet — planning against every class the taxonomy can describe. Import the scenario library or profile a GNSS trace to narrow this.");
  }

  const profiles = familyProfiles(library);
  if (!profiles.length) notes.push("The scenario library is empty for this tenant, so no variants could be generated. Import it with POST /api/scenarios/import (scripts/generate_library.py) and re-run the plan.");

  const cells = coverage.cells.filter((c) => c.odd && (!options.gaps_only || c.status !== "covered"));
  const candidates: CollectionTarget[] = [];
  for (const cell of cells) {
    const renderablePresets = presetsFor(cell.visibility, cell.lighting);
    for (const routeClass of targetRoutes) {
      const counts = tally.get(key(cell.visibility, cell.lighting, routeClass)) || { scenarios: 0, runs: 0, accepted_runs: 0 };
      const runsNeeded = Math.max(0, options.min_runs_per_cell - counts.accepted_runs);
      if (runsNeeded === 0) continue;
      // Every table entry has a positive default, so the share never reaches 0
      // and the expected on-road time is always finite.
      const share = naturalShare(cell.visibility, cell.lighting, routeClass);
      const driveHours = (runsNeeded * options.seconds_per_run) / 3600;
      const naturalDriveHours = driveHours / share;
      const renderable = renderablePresets.length > 0;
      const source: SourceKind = !renderable ? "vehicle" : naturalDriveHours > options.drive_hours_cap ? "sim" : "vehicle";
      const weight = riskWeight(cell.visibility, cell.lighting, routeClass);
      candidates.push({
        visibility: cell.visibility,
        lighting: cell.lighting,
        route_class: routeClass,
        cell_status: cell.status,
        scenarios: counts.scenarios,
        runs: counts.runs,
        accepted_runs: counts.accepted_runs,
        runs_needed: runsNeeded,
        scenes_needed: Math.ceil((runsNeeded * options.seconds_per_run) / options.clip_seconds),
        drive_hours: round(driveHours, 2),
        natural_share: round(share, 6),
        // A cheap cell is the interesting case at one decimal ("1.4 h, just
        // drive it"); an expensive one does not need the precision.
        natural_drive_hours: round(naturalDriveHours, naturalDriveHours < 10 ? 1 : 0),
        recommended_source: source,
        renderable,
        risk_weight: round(weight, 2),
        priority: round(weight * runsNeeded, 2),
        families: [],
        variants: 0,
        reason: !renderable
          ? `No weather preset renders ${cell.visibility.replace(/_/g, " ")}, so this cell can only be closed on the road.`
          : source === "sim"
            ? `About ${Math.round(naturalDriveHours).toLocaleString("en-US")} h of driving before this occurs on its own — render it instead.`
            : `Common enough to collect on the road: about ${round(naturalDriveHours, 1)} h of driving.`,
      });
    }
  }

  const targets = candidates
    .sort((a, b) => b.priority - a.priority || b.runs_needed - a.runs_needed || a.visibility.localeCompare(b.visibility) || a.route_class.localeCompare(b.route_class))
    .slice(0, options.max_targets);
  if (candidates.length > targets.length) {
    notes.push(`${candidates.length - targets.length} further targets are open below the top ${targets.length}; raise max_targets to plan them too.`);
  }

  const batch: GeneratedScenario[] = [];
  for (const target of targets) {
    // Only a renderable cell gets templates: a variant that cannot be rendered
    // in the condition it was generated for would be a scenario in name only.
    if (!target.renderable) continue;
    const families = candidateFamilies(profiles, target.visibility, target.lighting, target.route_class);
    if (!families.length) continue;
    const presets = presetsFor(target.visibility, target.lighting);
    const combos: Array<[string, string]> = [];
    for (const preset of presets) for (const time of timesFor(preset, target.lighting)) combos.push([preset, time]);
    for (let i = 0; i < options.variants_per_target; i++) {
      const profile = families[i % families.length];
      const [preset, time] = combos[i % combos.length];
      batch.push(generateVariant(profile, { visibility: target.visibility, lighting: target.lighting, route_class: target.route_class }, preset, time, i, options));
      if (!target.families.includes(profile.family)) target.families.push(profile.family);
      target.variants += 1;
    }
  }

  const sum = (list: CollectionTarget[], field: "runs_needed" | "scenes_needed" | "drive_hours" | "natural_drive_hours") =>
    list.reduce((n, t) => n + Math.max(0, t[field]), 0);
  const totalsOf = (list: CollectionTarget[]): PlanTotals => {
    const drive = list.filter((t) => t.recommended_source === "vehicle");
    return {
      targets: list.length,
      runs_needed: sum(list, "runs_needed"),
      scenes_needed: sum(list, "scenes_needed"),
      sim_scenes: sum(list.filter((t) => t.recommended_source === "sim"), "scenes_needed"),
      vehicle_scenes: sum(drive, "scenes_needed"),
      drive_hours: round(sum(drive, "drive_hours"), 1),
    };
  };

  return {
    options,
    coverage: {
      cells: coverage.totals.cells,
      covered_cells: coverage.totals.covered_cells,
      thin_cells: coverage.totals.thin_cells,
      gap_cells: coverage.totals.gap_cells,
      coverage_pct: coverage.totals.coverage_pct,
      min_runs_per_cell: coverage.min_runs_per_cell,
    },
    targets,
    totals: {
      ...totalsOf(targets),
      natural_drive_hours: Math.round(sum(targets, "natural_drive_hours")),
      unrenderable_targets: targets.filter((t) => !t.renderable).length,
      batch_size: batch.length,
    },
    backlog: totalsOf(candidates),
    batch,
    families: profiles,
    notes,
    assumptions: [
      `A cell is closed at ${options.min_runs_per_cell} accepted runs, and a run is ${options.seconds_per_run} s long — ${Math.round(options.seconds_per_run / options.clip_seconds)} clips of ${options.clip_seconds} s.`,
      "Targets are (visibility × lighting × route class): the matrix cell says the condition is missing, the route class says on what road.",
      "Priority is the missing runs weighted by how much the condition matters — degraded visibility, darkness, curvature and grade each multiply it. It orders the work; it does not size it.",
      "Expected on-road hours divide the driving needed by the share of time the condition is expected to hold on the corridor (rough field estimates, not measurements).",
      `Above ${options.drive_hours_cap} expected on-road hours a cell is recommended for simulation; below it, for collection. A condition no weather preset can render is always collection.`,
      "Generated variants re-parameterise a family from this tenant's own library into the missing condition, keeping its actors and expected events, with sensor degradation matched to the weather.",
      "The batch imports through POST /api/scenarios/import and each variant then exports as OpenSCENARIO 1.2, so the plan is runnable in ScenarioRunner or esmini.",
    ],
  };
}
