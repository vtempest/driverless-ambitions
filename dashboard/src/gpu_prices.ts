/**
 * Live marketplace GPU prices.
 *
 * The planner prices a training program off a static table of "typical" hourly
 * rates, and that table is wrong the moment it is written: marketplace prices
 * move with supply and demand, and the spread between the cheapest and the
 * median listing for the same card is routinely 2x. This module turns the
 * listings themselves into a quote — median and 25th percentile $/GPU-hour per
 * card, plus the interruptible bid and the disk rent quoted alongside it — so a
 * plan can be costed against what is rentable today and audited against what it
 * was rentable for last week.
 *
 * Everything here is pure except `fetchQuotes`, which takes the fetcher as an
 * argument: the parsers are fed recorded payloads in the tests, and the Worker
 * calls them on the cron trigger.
 */

import type { GpuId } from "./planner";
import { GPUS } from "./planner";

/** One rentable listing, normalised to a per-GPU hourly price. */
export interface Offer {
  source: string;
  gpu_id: GpuId;
  gpu_name: string;
  gpus: number;
  /** On-demand price for ONE GPU, $/hour. */
  usd_per_hour: number;
  /** Interruptible (bid/spot) price for one GPU, when the marketplace quotes one. */
  usd_per_hour_interruptible: number | null;
  /** Disk rent on that host, $/GB-month, when quoted. */
  usd_per_gb_month: number | null;
  /** Host reliability 0–1, when the marketplace publishes one. */
  reliability: number | null;
}

/** What one source knew about one card at one moment. */
export interface Quote {
  source: string;
  gpu_id: GpuId;
  observed_at: string;
  offers: number;
  usd_per_hour_min: number;
  usd_per_hour_p25: number;
  usd_per_hour_median: number;
  usd_per_hour_interruptible: number | null;
  usd_per_gb_month: number | null;
}

/** The rate the planner should use for a card, and where it came from. */
export interface LiveRate {
  usd_per_hour: number;
  usd_per_hour_interruptible: number | null;
  usd_per_gb_month: number | null;
  source: string;
  observed_at: string;
  offers: number;
}

export type LiveRates = Partial<Record<GpuId, LiveRate>>;

/**
 * A quote older than this is reported but no longer priced against: a two-day-old
 * median is a worse estimate than the reference table, because it looks live.
 */
export const MAX_QUOTE_AGE_HOURS = 48;

/**
 * Card matchers. Marketplace listings name cards freely ("A100 SXM4", "H100 NVL",
 * "RTX 4090"), so the memory floor is what separates an A100 80GB from the 40GB
 * part that shares its name. A listing with no memory reported is accepted: the
 * name is all we have, and the price is still informative.
 */
const MATCHERS: Array<{ id: GpuId; test: RegExp; min_ram_mb?: number }> = [
  { id: "h100_80gb", test: /\bh100\b/i, min_ram_mb: 70_000 },
  { id: "a100_80gb", test: /\ba100\b/i, min_ram_mb: 70_000 },
  { id: "l40s", test: /\bl40s\b/i },
  // The 4090D is a slower export SKU, but it is listed as a 4090 and prices with
  // them; the spread between hosts is far wider than the difference between the
  // two parts, so it is counted rather than dropped.
  { id: "rtx4090", test: /\b(?:rtx\s*)?4090\s?d?\b/i },
];

/** Map a marketplace card name (and its reported memory, in MB) onto a planner GPU. */
export function matchGpu(name: unknown, ramMb?: number | null): GpuId | null {
  if (typeof name !== "string" || !name.trim()) return null;
  for (const m of MATCHERS) {
    if (!m.test.test(name)) continue;
    if (m.min_ram_mb && typeof ramMb === "number" && Number.isFinite(ramMb) && ramMb > 0 && ramMb < m.min_ram_mb) continue;
    return m.id;
  }
  return null;
}

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Linear-interpolated quantile over an already sorted ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  return round(quantile([...values].sort((a, b) => a - b), 0.5));
}

/** A marketplace we can ask for listings. */
export interface PriceSource {
  id: string;
  label: string;
  /** Built fresh per refresh so a key read from the environment is never cached. */
  request(env: Record<string, string | undefined>): Request | null;
  parse(payload: unknown): Offer[];
}

/**
 * Vast.ai's public bundle search. No key is needed to read listings, which is the
 * reason it is the default source: a fresh deployment gets live prices with no
 * configuration. `dph_total` is the whole machine, so every price here is divided
 * by the GPU count to get the per-GPU rate the planner reasons in.
 */
export const VAST: PriceSource = {
  id: "vast.ai",
  label: "Vast.ai",
  request(env) {
    const q = {
      rentable: { eq: true },
      num_gpus: { gte: 1 },
      // Below this the card cannot be one the planner knows about.
      gpu_ram: { gte: 20_000 },
      order: [["dph_total", "asc"]],
      type: "on-demand",
      limit: 512,
    };
    const headers: Record<string, string> = { accept: "application/json" };
    // Reading listings is public; a key only buys a higher rate limit.
    if (env.VAST_API_KEY) headers.authorization = `Bearer ${env.VAST_API_KEY}`;
    return new Request(`https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(JSON.stringify(q))}`, { headers });
  },
  parse(payload: unknown): Offer[] {
    const offers = (payload as { offers?: unknown[] })?.offers;
    if (!Array.isArray(offers)) return [];
    const out: Offer[] = [];
    for (const raw of offers) {
      const o = raw as Record<string, unknown>;
      if (o.rentable === false) continue;
      const gpus = Math.max(1, Math.round(Number(o.num_gpus) || 1));
      const gpuId = matchGpu(o.gpu_name, positive(o.gpu_ram));
      const total = positive(o.dph_total);
      if (!gpuId || total === null) continue;
      const bid = positive(o.min_bid);
      out.push({
        source: VAST.id,
        gpu_id: gpuId,
        gpu_name: String(o.gpu_name),
        gpus,
        usd_per_hour: round(total / gpus),
        usd_per_hour_interruptible: bid === null ? null : round(bid / gpus),
        usd_per_gb_month: positive(o.storage_cost),
        reliability: positive(o.reliability2 ?? o.reliability),
      });
    }
    return out;
  },
};

/**
 * RunPod's public GraphQL catalogue. It quotes one price per card rather than a
 * listing per host, so it contributes a single offer per GPU — useful as a second
 * opinion on whether a Vast median is the market or one cheap host.
 */
export const RUNPOD: PriceSource = {
  id: "runpod.io",
  label: "RunPod",
  request() {
    const query =
      "query GpuTypes { gpuTypes { id displayName memoryInGb secureCloud communityCloud " +
      "lowestPrice(input: { gpuCount: 1 }) { minimumBidPrice uninterruptablePrice } } }";
    return new Request("https://api.runpod.io/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query }),
    });
  },
  parse(payload: unknown): Offer[] {
    const types = (payload as { data?: { gpuTypes?: unknown[] } })?.data?.gpuTypes;
    if (!Array.isArray(types)) return [];
    const out: Offer[] = [];
    for (const raw of types) {
      const t = raw as Record<string, unknown>;
      const memGb = positive(t.memoryInGb);
      const gpuId = matchGpu(t.displayName ?? t.id, memGb === null ? null : memGb * 1000);
      const price = t.lowestPrice as Record<string, unknown> | undefined;
      const onDemand = positive(price?.uninterruptablePrice);
      if (!gpuId || onDemand === null) continue;
      out.push({
        source: RUNPOD.id,
        gpu_id: gpuId,
        gpu_name: String(t.displayName ?? t.id),
        gpus: 1,
        usd_per_hour: round(onDemand),
        usd_per_hour_interruptible: positive(price?.minimumBidPrice),
        usd_per_gb_month: null,
        reliability: null,
      });
    }
    return out;
  },
};

export const SOURCES: PriceSource[] = [VAST, RUNPOD];

/**
 * Offers to one quote per (source, card).
 *
 * The median is what the planner prices against, not the minimum: the cheapest
 * listing on a marketplace is usually a single host with poor reliability or a
 * disk too small for the corpus, and a budget built on it will not survive
 * contact with the queue. The minimum and the 25th percentile are carried
 * alongside so the spread stays visible.
 */
export function summarize(offers: Offer[], observedAt: string): Quote[] {
  const groups = new Map<string, Offer[]>();
  for (const offer of offers) {
    const key = `${offer.source} ${offer.gpu_id}`;
    const list = groups.get(key);
    if (list) list.push(offer);
    else groups.set(key, [offer]);
  }
  const quotes: Quote[] = [];
  for (const list of groups.values()) {
    const prices = list.map((o) => o.usd_per_hour).sort((a, b) => a - b);
    quotes.push({
      source: list[0].source,
      gpu_id: list[0].gpu_id,
      observed_at: observedAt,
      offers: list.length,
      usd_per_hour_min: round(prices[0]),
      usd_per_hour_p25: round(quantile(prices, 0.25)),
      usd_per_hour_median: round(quantile(prices, 0.5)),
      usd_per_hour_interruptible: median(list.map((o) => o.usd_per_hour_interruptible).filter((n): n is number => n !== null)),
      usd_per_gb_month: median(list.map((o) => o.usd_per_gb_month).filter((n): n is number => n !== null)),
    });
  }
  return quotes.sort((a, b) => (a.gpu_id === b.gpu_id ? a.source.localeCompare(b.source) : a.gpu_id.localeCompare(b.gpu_id)));
}

export interface FetchResult {
  quotes: Quote[];
  errors: Array<{ source: string; error: string }>;
  observed_at: string;
}

/** Ask every source for listings. One source failing never fails the refresh. */
export async function fetchQuotes(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch,
  sources: PriceSource[] = SOURCES,
  now: Date = new Date(),
): Promise<FetchResult> {
  const observedAt = now.toISOString();
  const offers: Offer[] = [];
  const errors: FetchResult["errors"] = [];
  await Promise.all(
    sources.map(async (source) => {
      try {
        const request = source.request(env);
        if (!request) return;                       // not configured (missing key)
        const response = await fetcher(request);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = source.parse(await response.json());
        if (!parsed.length) throw new Error("no recognised GPUs in the response");
        offers.push(...parsed);
      } catch (error) {
        errors.push({ source: source.id, error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return { quotes: summarize(offers, observedAt), errors, observed_at: observedAt };
}

/**
 * The rate the planner uses per card: the cheapest fresh median across sources.
 *
 * "Cheapest median" is the decision a buyer actually makes — if RunPod's H100
 * catalogue sits under Vast's median, that is where the run should be launched —
 * and the source is recorded on the rate so the plan says where its price came
 * from. Quotes older than MAX_QUOTE_AGE_HOURS are dropped rather than aged into
 * the answer.
 */
export function ratesFromQuotes(quotes: Quote[], now: Date = new Date()): LiveRates {
  const rates: LiveRates = {};
  const cutoff = now.getTime() - MAX_QUOTE_AGE_HOURS * 3600 * 1000;
  for (const quote of quotes) {
    if (!(quote.gpu_id in GPUS)) continue;
    const observed = Date.parse(quote.observed_at);
    if (!Number.isFinite(observed) || observed < cutoff) continue;
    if (!(quote.usd_per_hour_median > 0)) continue;
    const current = rates[quote.gpu_id];
    if (current && current.usd_per_hour <= quote.usd_per_hour_median) continue;
    rates[quote.gpu_id] = {
      usd_per_hour: quote.usd_per_hour_median,
      usd_per_hour_interruptible: quote.usd_per_hour_interruptible,
      usd_per_gb_month: quote.usd_per_gb_month,
      source: quote.source,
      observed_at: quote.observed_at,
      offers: quote.offers,
    };
  }
  return rates;
}

/** How far the live median has drifted from the reference table, per card. */
export function driftFromReference(rates: LiveRates): Array<{ gpu_id: GpuId; label: string; reference: number; live: number; drift_pct: number; source: string }> {
  const out: Array<{ gpu_id: GpuId; label: string; reference: number; live: number; drift_pct: number; source: string }> = [];
  for (const [id, rate] of Object.entries(rates) as Array<[GpuId, LiveRate]>) {
    const reference = GPUS[id].usd_per_hour;
    out.push({
      gpu_id: id,
      label: GPUS[id].label,
      reference,
      live: rate.usd_per_hour,
      drift_pct: Math.round(((rate.usd_per_hour - reference) / reference) * 1000) / 10,
      source: rate.source,
    });
  }
  return out.sort((a, b) => Math.abs(b.drift_pct) - Math.abs(a.drift_pct));
}
