import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/types";
import { getGpuPrices, latestRates, refreshGpuPrices } from "../src/routes/gpu_prices";
import { VAST } from "../src/gpu_prices";

interface Recorded { sql: string; bindings: unknown[] }

/** A D1 stand-in: records every bound statement and replays canned rows per query. */
function fakeDb(rowsFor: (sql: string) => unknown[], failOn?: RegExp) {
  const statements: Recorded[] = [];
  const make = (sql: string) => ({
    bind: (...bindings: unknown[]) => {
      statements.push({ sql, bindings });
      return make(sql);
    },
    all: async () => {
      if (failOn?.test(sql)) throw new Error("no such table: gpu_price_samples");
      return { results: rowsFor(sql), success: true, meta: {} };
    },
    first: async () => rowsFor(sql)[0] ?? null,
    run: async () => ({ success: true, meta: {} }),
  });
  const db = {
    prepare: (sql: string) => make(sql),
    batch: async (list: unknown[]) => list.map(() => ({ success: true, meta: {} })),
  };
  return { db: db as unknown as D1Database, statements };
}

function env(db: D1Database): Env {
  return { DB: db, APP_NAME: "test", DEFAULT_TENANT: "default" } as unknown as Env;
}

const VAST_BODY = {
  offers: [
    { gpu_name: "A100 PCIE", gpu_ram: 81920, num_gpus: 1, dph_total: 1.4, min_bid: 0.7, storage_cost: 0.16, reliability2: 0.95, rentable: true },
    { gpu_name: "A100 SXM4", gpu_ram: 81920, num_gpus: 2, dph_total: 2.0, min_bid: 1.0, storage_cost: 0.12, reliability2: 0.99, rentable: true },
  ],
};

function stubFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("a refresh stores one sample per source and card, in the column order the table expects", async () => {
  const { db, statements } = fakeDb(() => []);
  const now = new Date("2026-09-11T02:15:00.000Z");
  const result = await refreshGpuPrices(env(db), stubFetch(VAST_BODY), now);

  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].gpu_id, "a100_80gb");
  const insert = statements.find((s) => s.sql.startsWith("INSERT OR REPLACE INTO gpu_price_samples"));
  assert.ok(insert, "the quote is written");
  assert.deepEqual(insert.bindings.slice(0, 4), ["vast.ai", "a100_80gb", now.toISOString(), 2]);
  assert.equal(insert.bindings[6], 1.2, "the median of $1.40 and $1.00 per GPU");
  // RunPod is polled too; its failure here is reported, not thrown.
  assert.ok(result.errors.every((e) => e.source !== "vast.ai"));
});

test("a missing price table leaves the planner on its reference rates instead of failing", async () => {
  const { db } = fakeDb(() => [], /gpu_price_samples/);
  assert.deepEqual(await latestRates(env(db)), {});

  const response = await getGpuPrices({ env: env(db), url: new URL("https://atlas.test/api/gpu-prices"), request: new Request("https://atlas.test/api/gpu-prices"), ctx: {} as ExecutionContext, params: {} });
  assert.equal(response.status, 200);
  const body = await response.json() as { stale: boolean; quotes: unknown[]; reference: unknown[]; sources: unknown[] };
  assert.equal(body.stale, true);
  assert.deepEqual(body.quotes, []);
  assert.equal(body.reference.length, 4, "the reference table is still served so the tab renders");
  assert.equal(body.sources.length, 2);
});

test("stored samples come back as quotes, rates and a drift against the reference table", async () => {
  const observed = new Date(Date.now() - 3600 * 1000).toISOString();
  const row = { source: "vast.ai", gpu_id: "a100_80gb", observed_at: observed, offers: 9, usd_per_hour_min: 0.9, usd_per_hour_p25: 1.1, usd_per_hour_median: 1.4, usd_per_hour_interruptible: 0.7, usd_per_gb_month: 0.16 };
  const { db } = fakeDb(() => [row]);

  assert.equal((await latestRates(env(db))).a100_80gb?.usd_per_hour, 1.4);

  const response = await getGpuPrices({ env: env(db), url: new URL("https://atlas.test/api/gpu-prices?days=7"), request: new Request("https://atlas.test/api/gpu-prices?days=7"), ctx: {} as ExecutionContext, params: {} });
  const body = await response.json() as { stale: boolean; observed_at: string; drift: Array<{ gpu_id: string; drift_pct: number }>; history: unknown[] };
  assert.equal(body.stale, false);
  assert.equal(body.observed_at, observed);
  assert.equal(body.drift[0].gpu_id, "a100_80gb");
  assert.ok(body.drift[0].drift_pct > 0, "1.40 is above the A100 reference rate");
  assert.equal(body.history.length, 1);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
});

test("the Vast.ai request is the public bundle search, with a key only when one is configured", () => {
  const anonymous = VAST.request({})!;
  assert.match(anonymous.url, /console\.vast\.ai\/api\/v0\/bundles\//);
  assert.equal(anonymous.headers.get("authorization"), null);
  const q = JSON.parse(decodeURIComponent(new URL(anonymous.url).searchParams.get("q")!));
  assert.deepEqual(q.rentable, { eq: true });
  assert.equal(q.type, "on-demand");
  assert.equal(VAST.request({ VAST_API_KEY: "secret" })!.headers.get("authorization"), "Bearer secret");
});
