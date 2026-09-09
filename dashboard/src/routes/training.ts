import type { RouteContext } from "../router";
import type { Env } from "../types";
import { authenticate } from "../auth";
import { json, optionalNumber } from "../util";
import {
  DATASET_TIERS,
  GPU_OPTIONS,
  WORKLOADS,
  type CoverageRow,
  type DatasetInventory,
  type PlanOptions,
  planTraining,
  recommendations,
  renderPlanMarkdown,
  summariseCoverage,
} from "../training";

/**
 * Count what the catalog holds, in the units a model team plans in: scenes,
 * sequence length, bytes and coverage of the conditions that decide whether a
 * driving model generalises.
 */
export async function datasetInventory(env: Env, tenant: string): Promise<DatasetInventory> {
  const [runs, clips, conditions] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(duration_s), 0) AS duration_s,
              COALESCE(SUM(distance_km), 0) AS distance_km,
              COALESCE(SUM(CASE WHEN source = 'sim' THEN 1 ELSE 0 END), 0) AS sim_runs,
              COALESCE(SUM(CASE WHEN source != 'sim' THEN 1 ELSE 0 END), 0) AS vehicle_runs
         FROM runs WHERE tenant_id = ?1`,
    ).bind(tenant).first<{ runs: number; duration_s: number; distance_km: number; sim_runs: number; vehicle_runs: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS clips,
              COALESCE(SUM(released), 0) AS released,
              COALESCE(SUM(size_bytes), 0) AS bytes,
              COALESCE(SUM(MAX(COALESCE(t_end, 0) - COALESCE(t_start, 0), 0)), 0) AS seconds,
              COUNT(DISTINCT run_id) AS runs_with_clips
         FROM clips WHERE tenant_id = ?1`,
    ).bind(tenant).first<{ clips: number; released: number; bytes: number; seconds: number; runs_with_clips: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(s.lighting_class, 'unspecified') AS lighting,
              COALESCE(s.visibility_class, 'unspecified') AS visibility,
              COALESCE(s.route_class, 'unspecified') AS route_class,
              COUNT(*) AS n
         FROM runs r
         LEFT JOIN scenarios s ON s.scenario_id = r.scenario_id AND s.tenant_id = r.tenant_id
        WHERE r.tenant_id = ?1
        GROUP BY 1, 2, 3`,
    ).bind(tenant).all<CoverageRow>(),
  ]);

  const runCount = runs?.runs || 0;
  const clipCount = clips?.clips || 0;
  const runsWithClips = Math.min(runCount, clips?.runs_with_clips || 0);
  const unclippedRuns = Math.max(0, runCount - runsWithClips);
  const scenes = clipCount + unclippedRuns;
  const avgRunSeconds = runCount > 0 ? (runs?.duration_s || 0) / runCount : 0;
  const sceneSeconds = (clips?.seconds || 0) + unclippedRuns * avgRunSeconds;

  return {
    scenes,
    clips: clipCount,
    clips_released: clips?.released || 0,
    runs: runCount,
    runs_with_clips: runsWithClips,
    sim_runs: runs?.sim_runs || 0,
    vehicle_runs: runs?.vehicle_runs || 0,
    hours: Math.round(((runs?.duration_s || 0) / 3600) * 10) / 10,
    distance_km: Math.round((runs?.distance_km || 0) * 100) / 100,
    stored_bytes: clips?.bytes || 0,
    measured_bytes_per_scene: clipCount > 0 && clips?.bytes ? Math.round(clips.bytes / clipCount) : null,
    avg_scene_seconds: scenes > 0 && sceneSeconds > 0 ? Math.round((sceneSeconds / scenes) * 10) / 10 : null,
    coverage: summariseCoverage(conditions.results),
  };
}

function planOptions(url: URL): PlanOptions {
  const num = (name: string) => optionalNumber(url.searchParams.get(name)) ?? undefined;
  return {
    scenes: num("scenes"),
    workload: url.searchParams.get("workload") || undefined,
    gpu: url.searchParams.get("gpu") || undefined,
    pricing: url.searchParams.get("pricing") === "interruptible" ? "interruptible" : "on_demand",
    rate_usd_hr: num("rate_usd_hr"),
    bytes_per_scene: num("bytes_per_scene"),
    disk_usd_per_gb_month: num("disk_usd_per_gb_month"),
    retention_days: num("retention_days"),
    preprocess_gpu_s_per_scene: num("preprocess_gpu_s_per_scene"),
  };
}

/**
 * GET /api/training/plan — dataset inventory, tier progress, coverage gaps and
 * a low/typical/high GPU budget. `?format=markdown` returns the same plan as a
 * budget memo for partner reports.
 */
export async function getTrainingPlan(c: RouteContext): Promise<Response> {
  const who = await authenticate(c.request, c.env, "reader");
  const inventory = await datasetInventory(c.env, who.tenant);
  const plan = planTraining(inventory, planOptions(c.url));
  const recs = recommendations(inventory, plan);
  const computedAt = new Date().toISOString();

  if ((c.url.searchParams.get("format") || "").toLowerCase() === "markdown") {
    return new Response(renderPlanMarkdown(inventory, plan, recs, who.tenant, computedAt), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="training-budget-${who.tenant}.md"`,
      },
    });
  }

  return json({
    tenant: who.tenant,
    computed_at: computedAt,
    inventory,
    plan,
    recommendations: recs,
    options: { tiers: DATASET_TIERS, gpus: GPU_OPTIONS, workloads: WORKLOADS },
  });
}
