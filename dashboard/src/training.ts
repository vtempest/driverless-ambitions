/**
 * Training-set sizing and GPU budget planner.
 *
 * Answers the two questions that decide whether the catalog is worth training
 * on and what it costs to do so:
 *
 *   1. How many scenes do we have, how are they spread across day/night,
 *      rain/fog and urban/highway/rural, and which tier of usefulness does
 *      that reach (proof of concept, domain adaptation, robust model)?
 *   2. What would a fine-tune, a medium training job or a from-scratch run
 *      cost on marketplace GPUs (Vast.ai-style A100/H100 listings), including
 *      the disk the dataset needs?
 *
 * Every rate and band here is a *reference* value: marketplace prices move
 * constantly, so each one is overridable per request and echoed back under
 * `assumptions` so a partner report can state what it assumed.
 */

export type TierId = "poc" | "adaptation" | "robust";

export interface DatasetTier {
  id: TierId;
  label: string;
  min_scenes: number;
  /** null for the open-ended top tier. */
  max_scenes: number | null;
  why: string;
}

/** Rule-of-thumb dataset sizes for driving-model work. */
export const DATASET_TIERS: DatasetTier[] = [
  { id: "poc", label: "Proof of concept", min_scenes: 1_000, max_scenes: 10_000, why: "Enough labelled clips to show a pipeline end to end and sanity-check a model." },
  { id: "adaptation", label: "Useful domain adaptation", min_scenes: 10_000, max_scenes: 100_000, why: "Enough local data to move a pre-trained model onto Bhutan roads, signage and traffic mix." },
  { id: "robust", label: "Robust across conditions", min_scenes: 100_000, max_scenes: null, why: "Varied weather, lighting, road types and rare events, not just more of the same corridor." },
];

export interface RateBand {
  low: number;
  typical: number;
  high: number;
}

export interface GpuOption {
  id: string;
  label: string;
  vram_gb: number;
  memory: string;
  bandwidth_tb_s: number | null;
  /** Reference marketplace rates in USD per GPU-hour. */
  on_demand: RateBand;
  note: string;
}

/**
 * Reference Vast.ai-style marketplace rates. Listings are per-host and move
 * with supply, so treat these as a starting bracket and override with
 * `rate_usd_hr` once you have a real listing.
 */
export const GPU_OPTIONS: GpuOption[] = [
  { id: "a100_80gb", label: "A100 80 GB", vram_gb: 80, memory: "HBM2e", bandwidth_tb_s: 2.0, on_demand: { low: 0.7, typical: 1.15, high: 1.6 }, note: "Best cost-to-capability ratio for a first driving-data run." },
  { id: "h100_pcie", label: "H100 PCIe 80 GB", vram_gb: 80, memory: "HBM2e", bandwidth_tb_s: 2.04, on_demand: { low: 0.9, typical: 1.8, high: 2.5 }, note: "Hopper; fastest per-GPU, listings occasionally dip near A100 prices." },
  { id: "l40s_48gb", label: "L40S 48 GB", vram_gb: 48, memory: "GDDR6", bandwidth_tb_s: 0.86, on_demand: { low: 0.6, typical: 0.9, high: 1.3 }, note: "Good for perception fine-tunes that fit in 48 GB." },
  { id: "rtx4090_24gb", label: "RTX 4090 24 GB", vram_gb: 24, memory: "GDDR6X", bandwidth_tb_s: 1.01, on_demand: { low: 0.2, typical: 0.35, high: 0.6 }, note: "Cheapest per hour; only for jobs that fit in 24 GB and tolerate host churn." },
];

/** Interruptible (bid) instances are typically a large discount on on-demand. */
export const INTERRUPTIBLE_FACTOR = 0.6;

export interface WorkloadProfile {
  id: string;
  label: string;
  /** GPU-hours at REFERENCE_SCENES scenes. */
  gpu_hours_low: number;
  gpu_hours_high: number;
  why: string;
}

/** GPU-hour bands are quoted at this dataset size and scaled from there. */
export const REFERENCE_SCENES = 100_000;

export const WORKLOADS: WorkloadProfile[] = [
  { id: "finetune", label: "Fine-tune / domain adaptation", gpu_hours_low: 100, gpu_hours_high: 1_000, why: "Adapt an existing checkpoint to local conditions." },
  { id: "medium", label: "Medium training job", gpu_hours_low: 1_000, gpu_hours_high: 5_000, why: "Retrain most of a model with the local corpus plus public data." },
  { id: "scratch", label: "From scratch / heavy iteration", gpu_hours_low: 5_000, gpu_hours_high: 20_000, why: "Train from random init, or iterate on architecture and losses." },
];

export const DEFAULTS = {
  /** Fallback scene size when the catalog holds no clip bytes yet (~10 s of compressed 1080p). */
  bytes_per_scene: 25_000_000,
  /** Marketplace disk is billed per GB-month and varies by host. */
  disk_usd_per_gb_month: 0.15,
  retention_days: 30,
  /** GPU seconds spent decoding, augmenting and validating each scene before training. */
  preprocess_gpu_s_per_scene: 7,
  /** Vast.ai instances default to a 10 GB disk; anything larger has to be requested. */
  default_instance_disk_gb: 10,
  /** A bucket holding less than this share of the dataset is called a coverage gap. */
  min_bucket_share: 0.05,
  /** Behaviour cloning needs sequences, not frames. */
  min_scene_seconds: 10,
};

export interface CoverageRow {
  lighting: string;
  visibility: string;
  route_class: string;
  n: number;
}

export interface CoverageBucket {
  bucket: string;
  count: number;
  share: number;
  gap: boolean;
}

export interface CoverageDimension {
  dimension: string;
  label: string;
  total: number;
  buckets: CoverageBucket[];
  gaps: string[];
}

export interface CoverageMatrixCell {
  route_class: string;
  lighting: string;
  count: number;
}

export interface Coverage {
  dimensions: CoverageDimension[];
  matrix: { rows: string[]; columns: string[]; cells: CoverageMatrixCell[]; empty_cells: number };
  unspecified_share: number;
}

const DIMENSION_LABELS: Record<keyof Omit<CoverageRow, "n">, string> = {
  lighting: "Lighting",
  visibility: "Visibility and weather",
  route_class: "Route class",
};

/**
 * Fold condition rows into per-dimension shares plus a route-class x lighting
 * matrix, flagging buckets that are thin enough to bias a model.
 */
export function summariseCoverage(rows: CoverageRow[], minShare = DEFAULTS.min_bucket_share): Coverage {
  const total = rows.reduce((n, r) => n + r.n, 0);
  const dimensions: CoverageDimension[] = (Object.keys(DIMENSION_LABELS) as Array<keyof typeof DIMENSION_LABELS>).map((dimension) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const bucket = row[dimension] || "unspecified";
      counts.set(bucket, (counts.get(bucket) || 0) + row.n);
    }
    const buckets: CoverageBucket[] = Array.from(counts, ([bucket, count]) => ({
      bucket,
      count,
      share: total > 0 ? Math.round((count / total) * 1000) / 1000 : 0,
      gap: total > 0 && bucket !== "unspecified" && count / total < minShare,
    })).sort((a, b) => b.count - a.count);
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      total,
      buckets,
      gaps: buckets.filter((b) => b.gap).map((b) => b.bucket),
    };
  });

  const routes = Array.from(new Set(rows.map((r) => r.route_class || "unspecified"))).sort();
  const lightings = Array.from(new Set(rows.map((r) => r.lighting || "unspecified"))).sort();
  const cells: CoverageMatrixCell[] = [];
  for (const route_class of routes) {
    for (const lighting of lightings) {
      const count = rows.filter((r) => (r.route_class || "unspecified") === route_class && (r.lighting || "unspecified") === lighting).reduce((n, r) => n + r.n, 0);
      cells.push({ route_class, lighting, count });
    }
  }
  const unspecified = rows.filter((r) => !r.lighting || !r.visibility || !r.route_class || r.lighting === "unspecified" || r.visibility === "unspecified" || r.route_class === "unspecified").reduce((n, r) => n + r.n, 0);

  return {
    dimensions,
    matrix: { rows: routes, columns: lightings, cells, empty_cells: cells.filter((c) => c.count === 0).length },
    unspecified_share: total > 0 ? Math.round((unspecified / total) * 1000) / 1000 : 0,
  };
}

export interface DatasetInventory {
  /** One clip is one scene; a run with no clips counts as one scene sequence. */
  scenes: number;
  clips: number;
  clips_released: number;
  runs: number;
  runs_with_clips: number;
  sim_runs: number;
  vehicle_runs: number;
  hours: number;
  distance_km: number;
  stored_bytes: number;
  /** Measured from clip bytes when the catalog has any, otherwise null. */
  measured_bytes_per_scene: number | null;
  avg_scene_seconds: number | null;
  coverage: Coverage;
}

export interface TierProgress {
  tier: DatasetTier;
  reached: boolean;
  scenes_short: number;
  progress_pct: number;
}

/** The highest tier the scene count satisfies, or null below the first. */
export function tierFor(scenes: number): DatasetTier | null {
  let current: DatasetTier | null = null;
  for (const tier of DATASET_TIERS) if (scenes >= tier.min_scenes) current = tier;
  return current;
}

export function tierProgress(scenes: number): TierProgress[] {
  return DATASET_TIERS.map((tier) => ({
    tier,
    reached: scenes >= tier.min_scenes,
    scenes_short: Math.max(0, tier.min_scenes - scenes),
    progress_pct: Math.min(100, Math.round((scenes / tier.min_scenes) * 1000) / 10),
  }));
}

/**
 * Scale a workload's GPU-hour band from the reference dataset size. Clamped:
 * preprocessing and evaluation overhead do not vanish on a tiny set, and past
 * ~4x the reference you subsample rather than pay linearly.
 */
export function scaleGpuHours(profile: WorkloadProfile, scenes: number): { low: number; high: number; scale: number } {
  const scale = Math.min(4, Math.max(0.25, scenes / REFERENCE_SCENES));
  return {
    low: Math.round(profile.gpu_hours_low * scale),
    high: Math.round(profile.gpu_hours_high * scale),
    scale: Math.round(scale * 100) / 100,
  };
}

export interface PlanOptions {
  scenes?: number;
  workload?: string;
  gpu?: string;
  pricing?: "on_demand" | "interruptible";
  rate_usd_hr?: number;
  bytes_per_scene?: number;
  disk_usd_per_gb_month?: number;
  retention_days?: number;
  preprocess_gpu_s_per_scene?: number;
}

export interface TrainingPlan {
  target_scenes: number;
  target_basis: string;
  inventory_scenes: number;
  current_tier: DatasetTier | null;
  next_tier: DatasetTier | null;
  scenes_to_next_tier: number;
  tiers: TierProgress[];
  storage: {
    bytes_per_scene: number;
    bytes_per_scene_source: "measured" | "default" | "override";
    dataset_gb: number;
    instance_disk_gb: number;
    default_instance_disk_gb: number;
    retention_days: number;
    disk_usd_per_gb_month: number;
    disk_usd: number;
  };
  compute: {
    gpu: GpuOption;
    pricing: "on_demand" | "interruptible";
    rate_usd_hr: RateBand;
    rate_source: "reference" | "override";
    workload: WorkloadProfile;
    scale: number;
    training_gpu_hours: { low: number; high: number };
    preprocess_gpu_hours: number;
    gpu_hours: { low: number; high: number };
    cost_usd: { low: number; typical: number; high: number };
  };
  total_usd: { low: number; typical: number; high: number };
  assumptions: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build a budget plan from an inventory and a set of overrides. */
export function planTraining(inventory: DatasetInventory, options: PlanOptions = {}): TrainingPlan {
  const workload = WORKLOADS.find((w) => w.id === options.workload) || WORKLOADS[0];
  const gpu = GPU_OPTIONS.find((g) => g.id === options.gpu) || GPU_OPTIONS[0];
  const pricing = options.pricing === "interruptible" ? "interruptible" : "on_demand";

  const currentTier = tierFor(inventory.scenes);
  const nextTier = DATASET_TIERS.find((t) => inventory.scenes < t.min_scenes) || null;
  let target = options.scenes && options.scenes > 0 ? Math.round(options.scenes) : 0;
  let targetBasis = "requested";
  if (!target) {
    target = nextTier ? nextTier.min_scenes : Math.max(inventory.scenes, REFERENCE_SCENES);
    targetBasis = nextTier ? `next tier: ${nextTier.label}` : "current dataset (top tier reached)";
  }

  const bytesPerScene = options.bytes_per_scene && options.bytes_per_scene > 0
    ? options.bytes_per_scene
    : inventory.measured_bytes_per_scene || DEFAULTS.bytes_per_scene;
  const bytesSource: "measured" | "default" | "override" = options.bytes_per_scene && options.bytes_per_scene > 0
    ? "override"
    : inventory.measured_bytes_per_scene
      ? "measured"
      : "default";

  const datasetGb = round2((target * bytesPerScene) / 1e9);
  // Room for checkpoints, caches and an extracted copy of the archive.
  const instanceDiskGb = Math.max(DEFAULTS.default_instance_disk_gb, Math.ceil(datasetGb * 1.5));
  const retentionDays = options.retention_days && options.retention_days > 0 ? options.retention_days : DEFAULTS.retention_days;
  const diskRate = options.disk_usd_per_gb_month && options.disk_usd_per_gb_month > 0 ? options.disk_usd_per_gb_month : DEFAULTS.disk_usd_per_gb_month;
  const diskUsd = round2(instanceDiskGb * diskRate * (retentionDays / 30));

  const scaled = scaleGpuHours(workload, target);
  const preprocessSeconds = options.preprocess_gpu_s_per_scene !== undefined && options.preprocess_gpu_s_per_scene >= 0
    ? options.preprocess_gpu_s_per_scene
    : DEFAULTS.preprocess_gpu_s_per_scene;
  const preprocessHours = Math.round((target * preprocessSeconds) / 3600);
  const hoursLow = scaled.low + preprocessHours;
  const hoursHigh = scaled.high + preprocessHours;

  const base = gpu.on_demand;
  const factor = pricing === "interruptible" ? INTERRUPTIBLE_FACTOR : 1;
  const override = options.rate_usd_hr && options.rate_usd_hr > 0 ? options.rate_usd_hr : null;
  const rate: RateBand = override
    ? { low: override, typical: override, high: override }
    : { low: round2(base.low * factor), typical: round2(base.typical * factor), high: round2(base.high * factor) };

  const midHours = (hoursLow + hoursHigh) / 2;
  const cost = {
    low: Math.round(hoursLow * rate.low),
    typical: Math.round(midHours * rate.typical),
    high: Math.round(hoursHigh * rate.high),
  };

  const assumptions = [
    `A scene is one catalog clip, or one run that has no clips; the target is ${target.toLocaleString("en-US")} scenes (${targetBasis}).`,
    `GPU-hour bands are quoted for ${REFERENCE_SCENES.toLocaleString("en-US")} scenes and scaled x${scaled.scale} (clamped to 0.25-4x).`,
    `Preprocessing, augmentation and validation add ${preprocessSeconds} GPU-seconds per scene (${preprocessHours} GPU-hours).`,
    `Scene size ${(bytesPerScene / 1e6).toFixed(1)} MB (${bytesSource}); instance disk sized at 1.5x the dataset, minimum ${DEFAULTS.default_instance_disk_gb} GB.`,
    override
      ? `Rate fixed at $${override.toFixed(2)}/GPU-hour (override).`
      : `${gpu.label} reference rate $${rate.low.toFixed(2)}-$${rate.high.toFixed(2)}/hour${pricing === "interruptible" ? ` (interruptible, ${Math.round((1 - INTERRUPTIBLE_FACTOR) * 100)} % off on-demand)` : " (on-demand)"}; marketplace listings move constantly.`,
    `Disk billed at $${diskRate.toFixed(2)}/GB-month for ${retentionDays} days. Network egress and object storage are not included.`,
  ];

  return {
    target_scenes: target,
    target_basis: targetBasis,
    inventory_scenes: inventory.scenes,
    current_tier: currentTier,
    next_tier: nextTier,
    scenes_to_next_tier: nextTier ? nextTier.min_scenes - inventory.scenes : 0,
    tiers: tierProgress(inventory.scenes),
    storage: {
      bytes_per_scene: bytesPerScene,
      bytes_per_scene_source: bytesSource,
      dataset_gb: datasetGb,
      instance_disk_gb: instanceDiskGb,
      default_instance_disk_gb: DEFAULTS.default_instance_disk_gb,
      retention_days: retentionDays,
      disk_usd_per_gb_month: diskRate,
      disk_usd: diskUsd,
    },
    compute: {
      gpu,
      pricing,
      rate_usd_hr: rate,
      rate_source: override ? "override" : "reference",
      workload,
      scale: scaled.scale,
      training_gpu_hours: { low: scaled.low, high: scaled.high },
      preprocess_gpu_hours: preprocessHours,
      gpu_hours: { low: hoursLow, high: hoursHigh },
      cost_usd: cost,
    },
    total_usd: {
      low: Math.round(cost.low + diskUsd),
      typical: Math.round(cost.typical + diskUsd),
      high: Math.round(cost.high + diskUsd),
    },
    assumptions,
  };
}

/** Advice rows the dashboard shows next to the plan: what to collect next. */
export interface Recommendation {
  id: string;
  severity: "info" | "warning";
  message: string;
}

export function recommendations(inventory: DatasetInventory, plan: TrainingPlan): Recommendation[] {
  const out: Recommendation[] = [];
  if (plan.next_tier) {
    out.push({ id: "tier", severity: "warning", message: `${plan.scenes_to_next_tier.toLocaleString("en-US")} more scenes reach "${plan.next_tier.label}" (${plan.next_tier.min_scenes.toLocaleString("en-US")}+): ${plan.next_tier.why}` });
  } else {
    out.push({ id: "tier", severity: "info", message: `The catalog reaches "${DATASET_TIERS[DATASET_TIERS.length - 1].label}". Spend the next collection on rare events rather than volume.` });
  }
  for (const dim of inventory.coverage.dimensions) {
    if (dim.gaps.length) {
      out.push({ id: `coverage:${dim.dimension}`, severity: "warning", message: `${dim.label}: thin coverage of ${dim.gaps.join(", ")} (under ${Math.round(DEFAULTS.min_bucket_share * 100)} % of scenes each). Coverage of conditions matters more than raw count.` });
    }
  }
  if (inventory.coverage.matrix.empty_cells > 0) {
    out.push({ id: "matrix", severity: "warning", message: `${inventory.coverage.matrix.empty_cells} route-class x lighting cells have no scenes at all.` });
  }
  if (inventory.coverage.unspecified_share >= 0.2) {
    out.push({ id: "unspecified", severity: "warning", message: `${Math.round(inventory.coverage.unspecified_share * 100)} % of scenes have no scenario conditions attached, so coverage cannot be verified. Link runs to scenarios on upload.` });
  }
  if (inventory.avg_scene_seconds !== null && inventory.avg_scene_seconds < DEFAULTS.min_scene_seconds) {
    out.push({ id: "sequence", severity: "warning", message: `Scenes average ${inventory.avg_scene_seconds.toFixed(1)} s. Behaviour cloning and end-to-end driving need sequences of at least ~${DEFAULTS.min_scene_seconds} s, not isolated frames.` });
  }
  if (plan.storage.dataset_gb > plan.storage.default_instance_disk_gb) {
    out.push({ id: "disk", severity: "info", message: `The target dataset is ${plan.storage.dataset_gb.toFixed(1)} GB; marketplace instances default to ${plan.storage.default_instance_disk_gb} GB of disk, so request ${plan.storage.instance_disk_gb} GB when you rent.` });
  }
  if (plan.compute.pricing === "on_demand" && plan.compute.rate_source === "reference") {
    out.push({ id: "interruptible", severity: "info", message: `Checkpointed pipelines can use interruptible instances for roughly ${Math.round((1 - INTERRUPTIBLE_FACTOR) * 100)} % less per GPU-hour.` });
  }
  return out;
}

/** Markdown budget memo: the same plan in a form a partner report can paste. */
export function renderPlanMarkdown(inventory: DatasetInventory, plan: TrainingPlan, recs: Recommendation[], tenant: string, computedAt: string): string {
  const usd = (n: number) => "$" + n.toLocaleString("en-US");
  const lines: string[] = [];
  lines.push(`# Training-set and compute budget — ${tenant}`);
  lines.push("");
  lines.push(`Generated ${computedAt} from the Atlas catalog.`);
  lines.push("");
  lines.push("## Dataset today");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Scenes (clips + un-clipped runs) | ${inventory.scenes.toLocaleString("en-US")} |`);
  lines.push(`| Runs (sim / vehicle) | ${inventory.runs.toLocaleString("en-US")} (${inventory.sim_runs} / ${inventory.vehicle_runs}) |`);
  lines.push(`| Recorded hours | ${inventory.hours.toFixed(1)} h |`);
  lines.push(`| Distance | ${inventory.distance_km.toFixed(1)} km |`);
  lines.push(`| Stored clip bytes | ${(inventory.stored_bytes / 1e9).toFixed(2)} GB |`);
  lines.push(`| Tier reached | ${plan.current_tier ? plan.current_tier.label : "below proof of concept"} |`);
  lines.push("");
  lines.push("## Sizing tiers");
  lines.push("");
  lines.push("| Tier | Scenes | Reached | Short by |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of plan.tiers) {
    lines.push(`| ${t.tier.label} | ${t.tier.min_scenes.toLocaleString("en-US")}${t.tier.max_scenes ? "–" + t.tier.max_scenes.toLocaleString("en-US") : "+"} | ${t.reached ? "yes" : "no"} | ${t.scenes_short ? t.scenes_short.toLocaleString("en-US") : "–"} |`);
  }
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  for (const dim of inventory.coverage.dimensions) {
    const buckets = dim.buckets.map((b) => `${b.bucket} ${Math.round(b.share * 100)} %`).join(", ") || "no data";
    lines.push(`* **${dim.label}**: ${buckets}${dim.gaps.length ? ` — thin: ${dim.gaps.join(", ")}` : ""}`);
  }
  lines.push("");
  lines.push("## Budget");
  lines.push("");
  lines.push(`* Target: **${plan.target_scenes.toLocaleString("en-US")} scenes** (${plan.target_basis})`);
  lines.push(`* Workload: **${plan.compute.workload.label}** — ${plan.compute.workload.why}`);
  lines.push(`* GPU: **${plan.compute.gpu.label}**, ${plan.compute.pricing.replace("_", "-")}, $${plan.compute.rate_usd_hr.low.toFixed(2)}–$${plan.compute.rate_usd_hr.high.toFixed(2)}/hour`);
  lines.push(`* GPU-hours: **${plan.compute.gpu_hours.low.toLocaleString("en-US")}–${plan.compute.gpu_hours.high.toLocaleString("en-US")}** (${plan.compute.preprocess_gpu_hours.toLocaleString("en-US")} of them preprocessing)`);
  lines.push(`* Dataset ${plan.storage.dataset_gb.toFixed(1)} GB, instance disk ${plan.storage.instance_disk_gb} GB, disk cost ${usd(plan.storage.disk_usd)}`);
  lines.push("");
  lines.push("| Estimate | Compute | Disk | Total |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| Low | ${usd(plan.compute.cost_usd.low)} | ${usd(plan.storage.disk_usd)} | **${usd(plan.total_usd.low)}** |`);
  lines.push(`| Typical | ${usd(plan.compute.cost_usd.typical)} | ${usd(plan.storage.disk_usd)} | **${usd(plan.total_usd.typical)}** |`);
  lines.push(`| High | ${usd(plan.compute.cost_usd.high)} | ${usd(plan.storage.disk_usd)} | **${usd(plan.total_usd.high)}** |`);
  lines.push("");
  lines.push("## What to do next");
  lines.push("");
  for (const rec of recs) lines.push(`* ${rec.severity === "warning" ? "**Gap** — " : ""}${rec.message}`);
  lines.push("");
  lines.push("## Assumptions");
  lines.push("");
  for (const a of plan.assumptions) lines.push(`* ${a}`);
  lines.push("");
  return lines.join("\n");
}
