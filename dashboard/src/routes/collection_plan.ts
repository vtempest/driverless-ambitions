import type { RouteContext } from "../router";
import { authenticate } from "../auth";
import { canonicalJson, json, parseJsonColumn, readJson, sha256 } from "../util";
import { DEFAULT_OPTIONS, buildCollectionPlan, type CollectionPlan, type GeneratedScenario, type LibraryRow } from "../collection_plan";
import { coverageBasis } from "./coverage";
import type { Env } from "../types";

/** The scenario library in the shape a generated variant is built from. */
async function library(env: Env, tenant: string): Promise<LibraryRow[]> {
  const rows = await env.DB.prepare(
    "SELECT scenario_id, family, group_name, name, description, tags, params, actors, expected_events, route_class, lighting_class, visibility_class, review_status" +
      " FROM scenarios WHERE tenant_id = ?1 ORDER BY family, scenario_id LIMIT 2000",
  ).bind(tenant).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    scenario_id: String(row.scenario_id || ""),
    family: String(row.family || ""),
    group_name: row.group_name as string | null,
    name: row.name as string | null,
    description: row.description as string | null,
    tags: parseJsonColumn<string[]>(row.tags, []),
    params: parseJsonColumn<Record<string, unknown>>(row.params, {}),
    actors: parseJsonColumn<Array<Record<string, unknown>>>(row.actors, []),
    expected_events: parseJsonColumn<string[]>(row.expected_events, []),
    route_class: row.route_class as string | null,
    lighting_class: row.lighting_class as string | null,
    visibility_class: row.visibility_class as string | null,
    review_status: row.review_status as string | null,
  }));
}

/**
 * Content hash over exactly the fields ScenarioTemplate.content_hash covers in
 * the toolkit, so a generated variant behaves like an imported one: editing a
 * parameter changes the hash and invalidates the expert review, while
 * regenerating the same plan does not.
 */
async function withHashes(batch: GeneratedScenario[]): Promise<GeneratedScenario[]> {
  return Promise.all(
    batch.map(async (item) => ({
      ...item,
      content_hash: await sha256(canonicalJson({ id: item.id, family: item.family, params: item.params, actors: item.actors, seed: item.seed, version: item.version })),
    })),
  );
}

async function plan(c: RouteContext, raw: Record<string, unknown>): Promise<Response> {
  const who = await authenticate(c.request, c.env, "reader");
  const [basis, rows] = await Promise.all([coverageBasis(c.env, who.tenant), library(c.env, who.tenant)]);
  // Default the run length to what this catalog's accepted runs actually are.
  const options = { seconds_per_run: basis.catalog.seconds_per_run ?? DEFAULT_OPTIONS.seconds_per_run, ...raw };
  const result: CollectionPlan = buildCollectionPlan(basis.scenarioRows, basis.runRows, rows, options);
  return json({
    tenant: who.tenant,
    computed_at: new Date().toISOString(),
    catalog: basis.catalog,
    ...result,
    batch: await withHashes(result.batch),
  });
}

/** GET /api/collection-plan?min_runs_per_cell=3&variants_per_target=3 */
export async function getCollectionPlan(c: RouteContext): Promise<Response> {
  return plan(c, Object.fromEntries(c.url.searchParams.entries()));
}

/** POST /api/collection-plan — same plan from a JSON body, for scripts. */
export async function postCollectionPlan(c: RouteContext): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(c.request, 64 * 1024);
  return plan(c, body || {});
}
