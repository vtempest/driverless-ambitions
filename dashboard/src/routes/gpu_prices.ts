import type { RouteContext } from "../router";
import { authenticate } from "../auth";
import { audit } from "../audit";
import { json } from "../util";
import { GPUS, type GpuId } from "../planner";
import { HISTORY_DAYS, MAX_QUOTE_AGE_HOURS, latestQuotes, priceHistory, ratesFromQuotes, refreshGpuPrices, type GpuQuote, type PriceMode } from "../gpu_prices";

/** One series per GPU class and pricing mode, cheapest provider per observation. */
function seriesFrom(points: Awaited<ReturnType<typeof priceHistory>>) {
  const byKey = new Map<string, Map<string, number>>();
  for (const p of points) {
    const key = `${p.gpu}:${p.mode}`;
    const series = byKey.get(key) || new Map<string, number>();
    const existing = series.get(p.observed_at);
    if (existing === undefined || p.median_usd_per_hour < existing) series.set(p.observed_at, p.median_usd_per_hour);
    byKey.set(key, series);
  }
  return Array.from(byKey.entries()).map(([key, series]) => {
    const [gpu, mode] = key.split(":") as [GpuId, PriceMode];
    return {
      gpu,
      mode,
      label: `${GPUS[gpu]?.label || gpu} ${mode === "interruptible" ? "interruptible" : "on demand"}`,
      points: Array.from(series.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([observed_at, usd_per_hour]) => ({ observed_at, usd_per_hour })),
    };
  });
}

function body(quotes: GpuQuote[], history: Awaited<ReturnType<typeof priceHistory>>, now: Date) {
  const rates = ratesFromQuotes(quotes, now);
  const observedAt = quotes.reduce<string | null>((newest, q) => (newest === null || q.observed_at > newest ? q.observed_at : newest), null);
  const ageHours = observedAt ? Math.round(((now.getTime() - Date.parse(observedAt)) / 3_600_000) * 10) / 10 : null;
  return {
    observed_at: observedAt,
    age_hours: ageHours,
    /** Nothing recent enough to price a plan with; the planner stays on reference rates. */
    stale: ageHours === null || ageHours > MAX_QUOTE_AGE_HOURS,
    max_age_hours: MAX_QUOTE_AGE_HOURS,
    providers: Array.from(new Set(quotes.map((q) => q.provider))),
    quotes,
    rates,
    reference: Object.entries(GPUS).map(([id, g]) => ({ id, label: g.label, usd_per_hour: g.usd_per_hour })),
    history_days: HISTORY_DAYS,
    history: seriesFrom(history),
  };
}

/**
 * GET /api/gpu-prices — the latest marketplace quote per GPU class and pricing
 * mode, plus the history behind the planner's price chart. Market data with no
 * tenant in it, so like /api/scenes it needs no token: a fresh deployment can
 * show real prices before anyone has uploaded a run.
 */
export async function getGpuPrices(c: RouteContext): Promise<Response> {
  const now = new Date();
  try {
    const [quotes, history] = await Promise.all([latestQuotes(c.env, now), priceHistory(c.env, HISTORY_DAYS, now)]);
    return json(body(quotes, history, now), 200, { "cache-control": "public, max-age=600" });
  } catch (error) {
    // Before migration 0003 the table does not exist. An empty feed is the
    // honest answer — the planner is already built to price without it.
    console.error("gpu price feed unavailable", error);
    return json(body([], [], now), 200, { "cache-control": "no-store" });
  }
}

/**
 * POST /api/gpu-prices/refresh — poll the marketplaces now instead of waiting
 * for the nightly cron. Admin only: it spends the Worker's egress and writes
 * shared rows that every tenant's plan then prices against.
 */
export async function postGpuPricesRefresh(c: RouteContext): Promise<Response> {
  const who = await authenticate(c.request, c.env, "admin");
  const now = new Date();
  const quotes = await refreshGpuPrices(c.env, fetch, now.toISOString());
  await audit(c.env, who, "gpu_prices.refresh", null, { quotes: quotes.length, providers: Array.from(new Set(quotes.map((q) => q.provider))) });
  const history = await priceHistory(c.env, HISTORY_DAYS, now);
  return json({ refreshed: quotes.length, ...body(quotes.length ? quotes : await latestQuotes(c.env, now), history, now) });
}
