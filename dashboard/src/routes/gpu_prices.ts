import type { RouteContext } from "../router";
import type { Env } from "../types";
import { authenticate } from "../auth";
import { json } from "../util";
import { GPUS, type GpuId } from "../planner";
import { MAX_QUOTE_AGE_HOURS, SOURCES, driftFromReference, fetchQuotes, ratesFromQuotes, type LiveRates, type Quote } from "../gpu_prices";

interface SampleRow {
  source: string;
  gpu_id: string;
  observed_at: string;
  offers: number;
  usd_per_hour_min: number | null;
  usd_per_hour_p25: number | null;
  usd_per_hour_median: number | null;
  usd_per_hour_interruptible: number | null;
  usd_per_gb_month: number | null;
}

function toQuote(row: SampleRow): Quote {
  return {
    source: row.source,
    gpu_id: row.gpu_id as GpuId,
    observed_at: row.observed_at,
    offers: row.offers,
    usd_per_hour_min: row.usd_per_hour_min ?? 0,
    usd_per_hour_p25: row.usd_per_hour_p25 ?? 0,
    usd_per_hour_median: row.usd_per_hour_median ?? 0,
    usd_per_hour_interruptible: row.usd_per_hour_interruptible,
    usd_per_gb_month: row.usd_per_gb_month,
  };
}

/** The most recent sample for every (source, card) pair. */
export async function latestQuotes(env: Env): Promise<Quote[]> {
  const rows = await env.DB.prepare(
    "SELECT s.source, s.gpu_id, s.observed_at, s.offers, s.usd_per_hour_min, s.usd_per_hour_p25, s.usd_per_hour_median, s.usd_per_hour_interruptible, s.usd_per_gb_month" +
      " FROM gpu_price_samples s JOIN (SELECT source, gpu_id, MAX(observed_at) AS observed_at FROM gpu_price_samples GROUP BY source, gpu_id) m" +
      " ON m.source = s.source AND m.gpu_id = s.gpu_id AND m.observed_at = s.observed_at",
  ).all<SampleRow>();
  return rows.results.map(toQuote);
}

/**
 * The rates the planner should price against right now.
 *
 * A missing table (a deployment that has not run migration 0003) or an empty one
 * is not an error: the planner falls back to its reference rates and says so.
 */
export async function latestRates(env: Env): Promise<LiveRates> {
  try {
    return ratesFromQuotes(await latestQuotes(env));
  } catch (error) {
    console.error("gpu price lookup failed", error);
    return {};
  }
}

/** Fetch every source, store one sample per (source, card), return what was stored. */
export async function refreshGpuPrices(env: Env, fetcher: typeof fetch = fetch, now: Date = new Date()) {
  const result = await fetchQuotes(env as unknown as Record<string, string | undefined>, fetcher, SOURCES, now);
  if (result.quotes.length) {
    await env.DB.batch(
      result.quotes.map((q) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO gpu_price_samples (source, gpu_id, observed_at, offers, usd_per_hour_min, usd_per_hour_p25, usd_per_hour_median, usd_per_hour_interruptible, usd_per_gb_month)" +
            " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        ).bind(q.source, q.gpu_id, q.observed_at, q.offers, q.usd_per_hour_min, q.usd_per_hour_p25, q.usd_per_hour_median, q.usd_per_hour_interruptible, q.usd_per_gb_month),
      ),
    );
  }
  return result;
}

function referenceTable() {
  return (Object.keys(GPUS) as GpuId[]).map((id) => ({ gpu_id: id, label: GPUS[id].label, usd_per_hour: GPUS[id].usd_per_hour, speed: GPUS[id].speed }));
}

/**
 * GET /api/gpu-prices?days=30
 *
 * Market data, not tenant data: served without a token for the same reason the
 * demo scenes are, so the planner tab shows a real price on a fresh deployment.
 */
export async function getGpuPrices(c: RouteContext): Promise<Response> {
  const days = Math.min(365, Math.max(1, Math.round(Number(c.url.searchParams.get("days") || 30)) || 30));
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  let quotes: Quote[] = [];
  let history: SampleRow[] = [];
  try {
    const [latest, rows] = await Promise.all([
      latestQuotes(c.env),
      c.env.DB.prepare(
        "SELECT source, gpu_id, observed_at, offers, usd_per_hour_min, usd_per_hour_p25, usd_per_hour_median, usd_per_hour_interruptible, usd_per_gb_month" +
          " FROM gpu_price_samples WHERE observed_at >= ?1 ORDER BY observed_at ASC LIMIT 5000",
      ).bind(since).all<SampleRow>(),
    ]);
    quotes = latest;
    history = rows.results;
  } catch (error) {
    console.error("gpu price read failed", error);
  }
  const rates = ratesFromQuotes(quotes);
  const newest = quotes.reduce<string | null>((max, q) => (max === null || q.observed_at > max ? q.observed_at : max), null);
  return json(
    {
      sources: SOURCES.map((s) => ({ id: s.id, label: s.label })),
      max_age_hours: MAX_QUOTE_AGE_HOURS,
      observed_at: newest,
      stale: newest === null || Date.now() - Date.parse(newest) > MAX_QUOTE_AGE_HOURS * 3600 * 1000,
      quotes,
      rates,
      drift: driftFromReference(rates),
      reference: referenceTable(),
      history: history.map((r) => ({ source: r.source, gpu_id: r.gpu_id, observed_at: r.observed_at, usd_per_hour_median: r.usd_per_hour_median, usd_per_hour_min: r.usd_per_hour_min, offers: r.offers })),
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

/** POST /api/gpu-prices/refresh — poll the marketplaces now instead of waiting for the cron. */
export async function postGpuPricesRefresh(c: RouteContext): Promise<Response> {
  await authenticate(c.request, c.env, "writer");
  const result = await refreshGpuPrices(c.env);
  const status = result.quotes.length ? 200 : 502;
  return json({ observed_at: result.observed_at, stored: result.quotes.length, quotes: result.quotes, errors: result.errors }, status);
}
