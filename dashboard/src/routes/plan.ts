import type { RouteContext } from "../router";
import { authenticate } from "../auth";
import { json } from "../util";
import {
  GPUS,
  RESOLUTIONS,
  TIERS,
  WORKLOADS,
  buildCoverage,
  planDataset,
  tierFor,
  type CoverageMatrix,
  type PlanInput,
  type RunCoverageRow,
  type ScenarioCoverageRow,
  type WorkloadId,
} from "../dataset_plan";
import type { Env } from "../types";

interface CatalogBasis {
  /** Accepted runs — the unit a "scene" is counted in. */
  accepted_runs: number;
  runs: number;
  scenarios: number;
  clips: number;
  /** Mean released-clip size, when clips carry bytes; drives MB per scene. */
  mb_per_clip: number | null;
  /** Mean accepted-run duration, when known; drives seconds per scene. */
  seconds_per_run: number | null;
}

/** Coverage matrix plus the catalog counts the planner defaults come from. */
export async function coverageFor(env: Env, tenant: string, minRunsPerCell: number): Promise<{ coverage: CoverageMatrix; catalog: CatalogBasis }> {
  const [scenarioRows, runRows, clips, runStats] = await Promise.all([
    env.DB.prepare(
      "SELECT route_class, lighting_class, visibility_class, review_status, COUNT(*) AS variants FROM scenarios WHERE tenant_id = ?1 GROUP BY route_class, lighting_class, visibility_class, review_status",
    ).bind(tenant).all<ScenarioCoverageRow>(),
    env.DB.prepare(
      "SELECT s.route_class AS route_class, s.lighting_class AS lighting_class, s.visibility_class AS visibility_class, r.source AS source, r.quality_status AS quality_status," +
        " COUNT(*) AS runs, COALESCE(SUM(r.duration_s), 0) AS duration_s, COALESCE(SUM(r.distance_km), 0) AS distance_km" +
        " FROM runs r LEFT JOIN scenarios s ON s.scenario_id = r.scenario_id AND s.tenant_id = r.tenant_id" +
        " WHERE r.tenant_id = ?1 GROUP BY 1, 2, 3, 4, 5",
    ).bind(tenant).all<RunCoverageRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n, AVG(NULLIF(size_bytes, 0)) AS avg_bytes FROM clips WHERE tenant_id = ?1").bind(tenant).first<{ n: number; avg_bytes: number | null }>(),
    env.DB.prepare("SELECT COUNT(*) AS n, AVG(NULLIF(duration_s, 0)) AS avg_duration FROM runs WHERE tenant_id = ?1 AND quality_status = 'accepted'").bind(tenant).first<{ n: number; avg_duration: number | null }>(),
  ]);

  const coverage = buildCoverage(scenarioRows.results, runRows.results, minRunsPerCell);
  return {
    coverage,
    catalog: {
      accepted_runs: runStats?.n || 0,
      runs: coverage.totals.runs,
      scenarios: coverage.totals.scenarios,
      clips: clips?.n || 0,
      mb_per_clip: clips?.avg_bytes ? Math.round((clips.avg_bytes / 1e6) * 100) / 100 : null,
      seconds_per_run: runStats?.avg_duration ? Math.round(runStats.avg_duration * 10) / 10 : null,
    },
  };
}

function minRunsParam(c: RouteContext): number {
  const n = Number(c.url.searchParams.get("min_runs") || 3);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 3;
}

/** GET /api/coverage — ODD coverage matrix (visibility x lighting) and gaps. */
export async function getCoverage(c: RouteContext): Promise<Response> {
  const who = await authenticate(c.request, c.env, "reader");
  const { coverage, catalog } = await coverageFor(c.env, who.tenant, minRunsParam(c));
  return json({ tenant: who.tenant, computed_at: new Date().toISOString(), catalog, ...coverage });
}

const num = (params: URLSearchParams, name: string): number | undefined => {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * GET /api/plan — dataset-scale and GPU-budget plan for the current catalog.
 * Defaults are taken from what the tenant already holds (clip size, run
 * duration, accepted runs) so the estimate is calibrated, not generic.
 */
export async function getPlan(c: RouteContext): Promise<Response> {
  const who = await authenticate(c.request, c.env, "reader");
  const params = c.url.searchParams;
  const { coverage, catalog } = await coverageFor(c.env, who.tenant, minRunsParam(c));

  const scenes = num(params, "scenes");
  // An explicit scene count wins over the tier it was picked from, so the tier
  // shown always matches the number being costed.
  const tier = scenes ? tierFor(scenes).id : params.get("tier");
  const input: PlanInput = {
    tier: tier || undefined,
    scenes,
    have_scenes: num(params, "have") ?? catalog.accepted_runs,
    workload: (params.get("workload") as WorkloadId) || undefined,
    gpu: params.get("gpu") || undefined,
    interruptible: params.get("interruptible") === "1" || params.get("interruptible") === "true",
    seconds_per_scene: num(params, "seconds_per_scene") ?? catalog.seconds_per_run ?? undefined,
    resolution: params.get("resolution") || undefined,
    camera_streams: num(params, "camera_streams"),
    rate_usd_per_hour: num(params, "rate"),
    storage_usd_per_gb_month: num(params, "storage_rate"),
    preprocess_overhead: num(params, "preprocess_overhead"),
  };
  // Only trust a measured clip size when the caller has not described the capture.
  if (input.resolution === undefined && num(params, "mb_per_scene") === undefined && catalog.mb_per_clip) {
    input.mb_per_scene = catalog.mb_per_clip;
  } else if (num(params, "mb_per_scene") !== undefined) {
    input.mb_per_scene = num(params, "mb_per_scene");
  }

  const plan = planDataset(input);
  return json({
    tenant: who.tenant,
    computed_at: new Date().toISOString(),
    catalog,
    coverage: { totals: coverage.totals, gaps: coverage.gaps.slice(0, 24), min_runs_per_cell: coverage.min_runs_per_cell },
    plan,
    options: {
      tiers: TIERS,
      workloads: Object.values(WORKLOADS),
      gpus: Object.values(GPUS),
      resolutions: Object.entries(RESOLUTIONS).map(([id, mbps]) => ({ id, mbps })),
    },
  });
}
