/**
 * Live marketplace GPU prices.
 *
 * The planner's reference rates are a snapshot of a market that moves hourly:
 * the same H100 is listed near $0.90/hour on one host and above $2.00 on
 * another, and an interruptible bid is a different number again. This module
 * turns the public listing APIs of Vast.ai and RunPod into a small set of
 * quotes — min, 25th percentile and median $/GPU-hour per GPU class and
 * pricing mode — that the planner can use instead of the static table.
 *
 * The parsing and aggregation here are pure so they can be tested against
 * recorded payloads; only `fetchProviderOffers` touches the network, and it
 * never throws: a provider that is down or that changes its schema simply
 * contributes no offers, and the planner falls back to the reference rate.
 */

import type { GpuId } from "./planner";
import type { Env } from "./types";

export type PriceMode = "on_demand" | "interruptible";
export type ProviderId = "vast.ai" | "runpod";

/** One listing, normalised to a per-GPU hourly price. */
export interface Offer {
  provider: ProviderId;
  gpu: GpuId;
  /** The provider's own name for the card, kept for provenance. */
  gpu_name: string;
  mode: PriceMode;
  usd_per_hour: number;
  num_gpus: number;
  memory_gb: number | null;
  reliability: number | null;
  storage_usd_per_gb_month: number | null;
}

/** Aggregated listings for one GPU class, pricing mode and provider. */
export interface GpuQuote {
  provider: ProviderId;
  gpu: GpuId;
  mode: PriceMode;
  observed_at: string;
  samples: number;
  min_usd_per_hour: number;
  p25_usd_per_hour: number;
  median_usd_per_hour: number;
  max_usd_per_hour: number;
  storage_usd_per_gb_month: number | null;
}

/** What the planner consumes: the best quote for a GPU class and mode. */
export interface Rate {
  usd_per_hour: number;
  provider: ProviderId;
  observed_at: string;
  samples: number;
  min_usd_per_hour: number;
  median_usd_per_hour: number;
  age_hours: number;
}

export type LiveRates = Partial<Record<GpuId, Partial<Record<PriceMode, Rate>>>>;

/** A quote older than this is reported but no longer priced into a plan. */
export const MAX_QUOTE_AGE_HOURS = 72;
/** Offers outside this band are listing errors, not prices. */
const MIN_PRICE = 0.05;
const MAX_PRICE = 100;
/** Vast.ai publishes a reliability score; anything flakier is not worth quoting. */
const MIN_RELIABILITY = 0.9;

export const PROVIDER_ENDPOINTS: Record<ProviderId, string> = {
  "vast.ai": "https://console.vast.ai/api/v0/bundles/",
  runpod: "https://api.runpod.io/graphql",
};

const RUNPOD_QUERY =
  "query GpuTypes { gpuTypes { id displayName memoryInGb lowestPrice(input: {gpuCount: 1}) { minimumBidPrice uninterruptablePrice } } }";

/**
 * Map a marketplace card name onto one of the planner's GPU classes.
 * Names arrive as "A100 SXM4", "NVIDIA A100 80GB PCIe", "RTX 4090", "L40S";
 * memory disambiguates the 40 GB A100 listings, which are a different machine
 * for a training budget.
 */
export function matchGpu(name: string, memoryGb: number | null = null): GpuId | null {
  const n = name.toUpperCase();
  if (n.includes("H100")) return memoryGb !== null && memoryGb < 70 ? null : "h100_80gb";
  if (n.includes("A100")) return memoryGb !== null && memoryGb < 70 ? null : "a100_80gb";
  if (n.includes("L40S")) return "l40s";
  if (n.includes("4090")) return "rtx4090";
  return null;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usable(price: number | null, numGpus: number): number | null {
  if (price === null || numGpus < 1) return null;
  const per = price / numGpus;
  return per >= MIN_PRICE && per <= MAX_PRICE ? Math.round(per * 10000) / 10000 : null;
}

/**
 * Parse a Vast.ai `/api/v0/bundles/` response. `dph_total` is the hourly price
 * of the whole machine, so it is divided by `num_gpus`; `min_bid` is the same
 * machine's interruptible bid.
 */
export function parseVastOffers(payload: unknown): Offer[] {
  const offers = (payload as { offers?: unknown })?.offers;
  if (!Array.isArray(offers)) return [];
  const out: Offer[] = [];
  for (const raw of offers) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const numGpus = Math.round(finite(o.num_gpus) ?? 1);
    const memoryGb = finite(o.gpu_ram) === null ? null : Math.round((finite(o.gpu_ram) as number) / 1024);
    const name = typeof o.gpu_name === "string" ? o.gpu_name : "";
    const gpu = matchGpu(name, memoryGb);
    if (!gpu || numGpus < 1) continue;
    const reliability = finite(o.reliability2 ?? o.reliability);
    if (reliability !== null && reliability < MIN_RELIABILITY) continue;
    const storage = finite(o.storage_cost);
    const base = { provider: "vast.ai" as const, gpu, gpu_name: name, num_gpus: numGpus, memory_gb: memoryGb, reliability, storage_usd_per_gb_month: storage };
    const onDemand = usable(finite(o.dph_total), numGpus);
    if (onDemand !== null) out.push({ ...base, mode: "on_demand", usd_per_hour: onDemand });
    const bid = usable(finite(o.min_bid), numGpus);
    if (bid !== null) out.push({ ...base, mode: "interruptible", usd_per_hour: bid });
  }
  return out;
}

/**
 * Parse a RunPod GraphQL `gpuTypes` response. RunPod publishes one lowest
 * price per card rather than a list of machines, so each card contributes a
 * single offer per mode.
 */
export function parseRunpodOffers(payload: unknown): Offer[] {
  const types = (payload as { data?: { gpuTypes?: unknown } })?.data?.gpuTypes;
  if (!Array.isArray(types)) return [];
  const out: Offer[] = [];
  for (const raw of types) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const memoryGb = finite(t.memoryInGb);
    const name = typeof t.displayName === "string" ? t.displayName : typeof t.id === "string" ? t.id : "";
    const gpu = matchGpu(name, memoryGb);
    if (!gpu) continue;
    const lowest = (t.lowestPrice || {}) as Record<string, unknown>;
    const base = { provider: "runpod" as const, gpu, gpu_name: name, num_gpus: 1, memory_gb: memoryGb, reliability: null, storage_usd_per_gb_month: null };
    const onDemand = usable(finite(lowest.uninterruptablePrice), 1);
    if (onDemand !== null) out.push({ ...base, mode: "on_demand", usd_per_hour: onDemand });
    const bid = usable(finite(lowest.minimumBidPrice), 1);
    if (bid !== null) out.push({ ...base, mode: "interruptible", usd_per_hour: bid });
  }
  return out;
}

/** Nearest-rank percentile over a sorted ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10000) / 10000;
}

/** Collapse offers into one quote per provider, GPU class and pricing mode. */
export function summarizeOffers(offers: Offer[], observedAt: string): GpuQuote[] {
  const groups = new Map<string, Offer[]>();
  for (const offer of offers) {
    const key = `${offer.provider}|${offer.gpu}|${offer.mode}`;
    const list = groups.get(key);
    if (list) list.push(offer);
    else groups.set(key, [offer]);
  }
  const quotes: GpuQuote[] = [];
  for (const [key, list] of groups) {
    const [provider, gpu, mode] = key.split("|") as [ProviderId, GpuId, PriceMode];
    const prices = list.map((o) => o.usd_per_hour).sort((a, b) => a - b);
    const storage = list.map((o) => o.storage_usd_per_gb_month).filter((s): s is number => s !== null).sort((a, b) => a - b);
    quotes.push({
      provider,
      gpu,
      mode,
      observed_at: observedAt,
      samples: prices.length,
      min_usd_per_hour: prices[0],
      p25_usd_per_hour: percentile(prices, 25),
      median_usd_per_hour: median(prices),
      max_usd_per_hour: prices[prices.length - 1],
      storage_usd_per_gb_month: storage.length ? median(storage) : null,
    });
  }
  return quotes.sort((a, b) => a.gpu.localeCompare(b.gpu) || a.mode.localeCompare(b.mode) || a.provider.localeCompare(b.provider));
}

/**
 * The rate a plan should use: the lowest median among the providers quoting
 * that GPU and mode. The median rather than the minimum because the cheapest
 * single listing is usually gone by the time a job starts; the minimum is kept
 * alongside so a reader can see the headline price too.
 */
export function ratesFromQuotes(quotes: GpuQuote[], now: Date = new Date()): LiveRates {
  const rates: LiveRates = {};
  for (const quote of quotes) {
    if (!quote.samples) continue;
    const ageHours = Math.round(((now.getTime() - Date.parse(quote.observed_at)) / 3_600_000) * 10) / 10;
    if (!Number.isFinite(ageHours) || ageHours > MAX_QUOTE_AGE_HOURS) continue;
    const byMode = rates[quote.gpu] || (rates[quote.gpu] = {});
    const current = byMode[quote.mode];
    if (current && current.usd_per_hour <= quote.median_usd_per_hour) continue;
    byMode[quote.mode] = {
      usd_per_hour: quote.median_usd_per_hour,
      provider: quote.provider,
      observed_at: quote.observed_at,
      samples: quote.samples,
      min_usd_per_hour: quote.min_usd_per_hour,
      median_usd_per_hour: quote.median_usd_per_hour,
      age_hours: Math.max(0, ageHours),
    };
  }
  return rates;
}

/**
 * Fetch one provider's listings. Never throws: a network failure, a non-200 or
 * an unexpected shape all return an empty list, which leaves the planner on its
 * reference rates instead of on a wrong price.
 */
export async function fetchProviderOffers(provider: ProviderId, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<Offer[]> {
  const url = PROVIDER_ENDPOINTS[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit =
      provider === "runpod"
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: RUNPOD_QUERY }), signal: controller.signal }
        : { method: "GET", headers: { accept: "application/json" }, signal: controller.signal };
    const response = await fetchImpl(url, init);
    if (!response.ok) return [];
    const payload = await response.json();
    return provider === "runpod" ? parseRunpodOffers(payload) : parseVastOffers(payload);
  } catch (error) {
    console.error("gpu price fetch failed", provider, error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Poll every provider and aggregate; the caller decides whether to store the result. */
export async function collectQuotes(fetchImpl: typeof fetch = fetch, observedAt: string = new Date().toISOString()): Promise<GpuQuote[]> {
  const providers = Object.keys(PROVIDER_ENDPOINTS) as ProviderId[];
  const lists = await Promise.all(providers.map((p) => fetchProviderOffers(p, fetchImpl)));
  return summarizeOffers(lists.flat(), observedAt);
}

// ---------------------------------------------------------------- storage
// Quotes are market data, shared by every tenant, so the rows carry no
// tenant_id and the history is kept for trend lines rather than for evidence.

/** How much history a sparkline reads back. */
export const HISTORY_DAYS = 45;

export interface PricePoint {
  gpu: GpuId;
  mode: PriceMode;
  provider: ProviderId;
  observed_at: string;
  median_usd_per_hour: number;
  min_usd_per_hour: number;
}

function isoDaysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export async function storeQuotes(env: Env, quotes: GpuQuote[]): Promise<number> {
  if (!quotes.length) return 0;
  const statement = env.DB.prepare(
    "INSERT OR REPLACE INTO gpu_price_quotes (observed_at, provider, gpu_id, mode, samples, min_usd_per_hour, p25_usd_per_hour, median_usd_per_hour, max_usd_per_hour, storage_usd_per_gb_month)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  );
  await env.DB.batch(
    quotes.map((q) => statement.bind(q.observed_at, q.provider, q.gpu, q.mode, q.samples, q.min_usd_per_hour, q.p25_usd_per_hour, q.median_usd_per_hour, q.max_usd_per_hour, q.storage_usd_per_gb_month)),
  );
  return quotes.length;
}

/**
 * The most recent quote for every GPU class, pricing mode and provider. A
 * provider that failed on the last poll keeps its previous row rather than
 * disappearing, which is why this is a per-partition latest and not simply the
 * rows of the newest observation.
 */
export async function latestQuotes(env: Env, now: Date = new Date()): Promise<GpuQuote[]> {
  const { results } = await env.DB.prepare(
    "SELECT provider, gpu_id, mode, observed_at, samples, min_usd_per_hour, p25_usd_per_hour, median_usd_per_hour, max_usd_per_hour, storage_usd_per_gb_month FROM (" +
      " SELECT *, ROW_NUMBER() OVER (PARTITION BY gpu_id, mode, provider ORDER BY observed_at DESC) AS rn FROM gpu_price_quotes WHERE observed_at >= ?1" +
      ") WHERE rn = 1",
  )
    .bind(isoDaysAgo(HISTORY_DAYS, now))
    .all<{ provider: ProviderId; gpu_id: GpuId; mode: PriceMode; observed_at: string; samples: number; min_usd_per_hour: number; p25_usd_per_hour: number; median_usd_per_hour: number; max_usd_per_hour: number; storage_usd_per_gb_month: number | null }>();
  return results.map((r) => ({
    provider: r.provider,
    gpu: r.gpu_id,
    mode: r.mode,
    observed_at: r.observed_at,
    samples: r.samples,
    min_usd_per_hour: r.min_usd_per_hour,
    p25_usd_per_hour: r.p25_usd_per_hour,
    median_usd_per_hour: r.median_usd_per_hour,
    max_usd_per_hour: r.max_usd_per_hour,
    storage_usd_per_gb_month: r.storage_usd_per_gb_month,
  }));
}

/** Rates the planner can price a run with; empty when the feed has never run. */
export async function liveRates(env: Env, now: Date = new Date()): Promise<LiveRates> {
  try {
    return ratesFromQuotes(await latestQuotes(env, now), now);
  } catch (error) {
    // A missing table (migration not applied yet) must not take the planner down.
    console.error("live GPU rates unavailable", error);
    return {};
  }
}

export async function priceHistory(env: Env, days = HISTORY_DAYS, now: Date = new Date()): Promise<PricePoint[]> {
  const { results } = await env.DB.prepare(
    "SELECT gpu_id, mode, provider, observed_at, median_usd_per_hour, min_usd_per_hour FROM gpu_price_quotes WHERE observed_at >= ?1 ORDER BY observed_at ASC LIMIT 2000",
  )
    .bind(isoDaysAgo(days, now))
    .all<{ gpu_id: GpuId; mode: PriceMode; provider: ProviderId; observed_at: string; median_usd_per_hour: number; min_usd_per_hour: number }>();
  return results.map((r) => ({ gpu: r.gpu_id, mode: r.mode, provider: r.provider, observed_at: r.observed_at, median_usd_per_hour: r.median_usd_per_hour, min_usd_per_hour: r.min_usd_per_hour }));
}

/** Poll the marketplaces and store what came back. Returns the stored quotes. */
export async function refreshGpuPrices(env: Env, fetchImpl: typeof fetch = fetch, observedAt: string = new Date().toISOString()): Promise<GpuQuote[]> {
  const quotes = await collectQuotes(fetchImpl, observedAt);
  await storeQuotes(env, quotes);
  return quotes;
}
