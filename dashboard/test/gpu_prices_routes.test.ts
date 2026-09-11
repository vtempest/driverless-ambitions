import { test } from "node:test";
import assert from "node:assert/strict";
import type { RouteContext } from "../src/router";
import type { Env } from "../src/types";
import { getGpuPrices } from "../src/routes/gpu_prices";
import { liveRates, storeQuotes, type GpuQuote } from "../src/gpu_prices";

/** A D1 stub: every prepared statement answers from a table keyed by a phrase in its SQL. */
function fakeDb(answers: Array<{ match: string; rows: unknown[] }>, onBind?: (sql: string, args: unknown[]) => void) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          statements.push({ sql, args });
          onBind?.(sql, args);
          return stmt;
        },
        async all<T>() {
          const answer = answers.find((a) => sql.includes(a.match));
          if (!answer) throw new Error(`no such table: ${sql}`);
          return { results: answer.rows as T[], success: true, meta: {} };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
    async batch(prepared: unknown[]) {
      return prepared.map(() => ({ success: true, meta: {} }));
    },
  };
  return { db: db as unknown as Env["DB"], statements };
}

const row = (over: Record<string, unknown> = {}) => ({
  provider: "vast.ai",
  gpu_id: "a100_80gb",
  mode: "on_demand",
  observed_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
  samples: 14,
  min_usd_per_hour: 0.9,
  p25_usd_per_hour: 1.02,
  median_usd_per_hour: 1.18,
  max_usd_per_hour: 2.6,
  storage_usd_per_gb_month: 0.12,
  ...over,
});

function context(env: Env, path = "/api/gpu-prices"): RouteContext {
  const url = new URL(`https://atlas.example${path}`);
  return { request: new Request(url), env, ctx: {} as never, params: {}, url };
}

test("the price endpoint reports the latest quote, its age and the history series", async () => {
  const history = [
    { gpu_id: "a100_80gb", mode: "on_demand", provider: "vast.ai", observed_at: "2026-09-09T02:15:00.000Z", median_usd_per_hour: 1.3, min_usd_per_hour: 1.0 },
    { gpu_id: "a100_80gb", mode: "on_demand", provider: "runpod", observed_at: "2026-09-09T02:15:00.000Z", median_usd_per_hour: 1.64, min_usd_per_hour: 1.64 },
    { gpu_id: "a100_80gb", mode: "on_demand", provider: "vast.ai", observed_at: "2026-09-10T02:15:00.000Z", median_usd_per_hour: 1.18, min_usd_per_hour: 0.9 },
    { gpu_id: "a100_80gb", mode: "interruptible", provider: "vast.ai", observed_at: "2026-09-10T02:15:00.000Z", median_usd_per_hour: 0.62, min_usd_per_hour: 0.45 },
  ];
  const { db } = fakeDb([
    { match: "ROW_NUMBER()", rows: [row(), row({ provider: "runpod", median_usd_per_hour: 1.64, samples: 1 }), row({ mode: "interruptible", median_usd_per_hour: 0.62 })] },
    { match: "ORDER BY observed_at ASC", rows: history },
  ]);

  const body = (await getGpuPrices(context({ DB: db } as Env)).then((r) => r.json())) as Record<string, any>;
  assert.equal(body.stale, false);
  assert.ok(body.age_hours >= 5.9 && body.age_hours <= 6.1);
  assert.deepEqual(body.providers.sort(), ["runpod", "vast.ai"]);
  // The plan-facing rate is the cheaper provider's median, per GPU and mode.
  assert.equal(body.rates.a100_80gb.on_demand.usd_per_hour, 1.18);
  assert.equal(body.rates.a100_80gb.on_demand.provider, "vast.ai");
  assert.equal(body.rates.a100_80gb.interruptible.usd_per_hour, 0.62);

  const onDemand = body.history.find((s: any) => s.gpu === "a100_80gb" && s.mode === "on_demand");
  assert.equal(onDemand.label, "A100 80GB on demand");
  // One point per observation — the cheaper provider wins the day both quoted.
  assert.deepEqual(onDemand.points.map((p: any) => p.usd_per_hour), [1.3, 1.18]);
  assert.equal(body.history.find((s: any) => s.mode === "interruptible").points.length, 1);
  assert.equal(body.reference.find((g: any) => g.id === "a100_80gb").label, "A100 80GB");
});

test("an empty or missing price table leaves the planner on reference rates instead of failing", async () => {
  const { db: empty } = fakeDb([
    { match: "ROW_NUMBER()", rows: [] },
    { match: "ORDER BY observed_at ASC", rows: [] },
  ]);
  const body = (await getGpuPrices(context({ DB: empty } as Env)).then((r) => r.json())) as Record<string, any>;
  assert.equal(body.observed_at, null);
  assert.equal(body.stale, true);
  assert.deepEqual(body.quotes, []);
  assert.deepEqual(body.rates, {});

  // Before migration 0003 is applied the table does not exist at all: the feed
  // answers empty and the planner keeps its reference rates, rather than 500.
  const { db: missing } = fakeDb([]);
  assert.deepEqual(await liveRates({ DB: missing } as Env), {});
  const missingResponse = await getGpuPrices(context({ DB: missing } as Env));
  assert.equal(missingResponse.status, 200);
  const missingBody = (await missingResponse.json()) as Record<string, any>;
  assert.equal(missingBody.stale, true);
  assert.deepEqual(missingBody.quotes, []);
  assert.deepEqual(missingBody.history, []);
});

test("quotes are written with the observation as part of the key, so a re-poll updates in place", async () => {
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  const { db } = fakeDb([], (sql, args) => binds.push({ sql, args }));
  const quotes: GpuQuote[] = [
    { provider: "vast.ai", gpu: "a100_80gb", mode: "on_demand", observed_at: "2026-09-11T02:15:00.000Z", samples: 14, min_usd_per_hour: 0.9, p25_usd_per_hour: 1.02, median_usd_per_hour: 1.18, max_usd_per_hour: 2.6, storage_usd_per_gb_month: 0.12 },
    { provider: "runpod", gpu: "h100_80gb", mode: "interruptible", observed_at: "2026-09-11T02:15:00.000Z", samples: 1, min_usd_per_hour: 1.99, p25_usd_per_hour: 1.99, median_usd_per_hour: 1.99, max_usd_per_hour: 1.99, storage_usd_per_gb_month: null },
  ];
  assert.equal(await storeQuotes({ DB: db } as Env, quotes), 2);
  assert.equal(binds.length, 2);
  assert.match(binds[0].sql, /INSERT OR REPLACE INTO gpu_price_quotes/);
  assert.deepEqual(binds[0].args.slice(0, 5), ["2026-09-11T02:15:00.000Z", "vast.ai", "a100_80gb", "on_demand", 14]);
  assert.equal(binds[1].args[9], null);
  assert.equal(await storeQuotes({ DB: db } as Env, []), 0);
});
