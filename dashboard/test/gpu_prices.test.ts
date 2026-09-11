import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_QUOTE_AGE_HOURS, RUNPOD, VAST, driftFromReference, fetchQuotes, matchGpu, quantile, ratesFromQuotes, summarize, type Offer, type PriceSource, type Quote } from "../src/gpu_prices";
import { GPUS, INTERRUPTIBLE_DISCOUNT, normalizeInput, planProgram, priceFor } from "../src/planner";

/** A Vast.ai bundle search response, trimmed to the fields the parser reads. */
const VAST_PAYLOAD = {
  offers: [
    { id: 1, gpu_name: "A100 SXM4", gpu_ram: 81920, num_gpus: 8, dph_total: 8.0, min_bid: 4.0, storage_cost: 0.12, reliability2: 0.99, rentable: true },
    { id: 2, gpu_name: "A100 PCIE", gpu_ram: 81920, num_gpus: 1, dph_total: 1.4, min_bid: 0.7, storage_cost: 0.2, reliability2: 0.95, rentable: true },
    { id: 3, gpu_name: "A100 PCIE", gpu_ram: 81920, num_gpus: 2, dph_total: 4.0, min_bid: 2.0, storage_cost: 0.16, reliability2: 0.9, rentable: true },
    { id: 4, gpu_name: "A100X", gpu_ram: 40960, num_gpus: 1, dph_total: 0.4, rentable: true },      // 40GB part, not the planner's card
    { id: 5, gpu_name: "H100 SXM", gpu_ram: 81920, num_gpus: 1, dph_total: 1.9, min_bid: 1.1, storage_cost: 0.25, reliability2: 0.98, rentable: true },
    { id: 6, gpu_name: "RTX 4090", gpu_ram: 24564, num_gpus: 1, dph_total: 0.33, min_bid: 0.2, storage_cost: 0.1, reliability2: 0.8, rentable: true },
    { id: 7, gpu_name: "RTX 3090", gpu_ram: 24576, num_gpus: 1, dph_total: 0.2, rentable: true },   // not a card the planner prices
    { id: 8, gpu_name: "H100 PCIE", gpu_ram: 81920, num_gpus: 1, dph_total: 2.5, rentable: false }, // not rentable
  ],
};

const RUNPOD_PAYLOAD = {
  data: {
    gpuTypes: [
      { id: "NVIDIA A100 80GB PCIe", displayName: "A100 80GB PCIe", memoryInGb: 80, lowestPrice: { minimumBidPrice: 0.8, uninterruptablePrice: 1.64 } },
      { id: "NVIDIA H100 80GB HBM3", displayName: "H100 SXM", memoryInGb: 80, lowestPrice: { minimumBidPrice: 1.5, uninterruptablePrice: 2.79 } },
      { id: "NVIDIA A100-SXM4-40GB", displayName: "A100 40GB", memoryInGb: 40, lowestPrice: { minimumBidPrice: 0.4, uninterruptablePrice: 0.9 } },
      { id: "NVIDIA L4", displayName: "L4", memoryInGb: 24, lowestPrice: { minimumBidPrice: 0.2, uninterruptablePrice: 0.43 } },
      { id: "NVIDIA RTX 4090", displayName: "RTX 4090", memoryInGb: 24, lowestPrice: { uninterruptablePrice: null } },  // no price quoted
    ],
  },
};

function stubFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not stubbed", { status: 404 });
    const route = routes[key];
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("card names map onto planner GPUs, and the memory floor keeps the 40GB parts out", () => {
  assert.equal(matchGpu("A100 SXM4", 81920), "a100_80gb");
  assert.equal(matchGpu("A100 PCIE", 40960), null);
  assert.equal(matchGpu("A100 80GB PCIe", null), "a100_80gb");       // no memory reported: trust the name
  assert.equal(matchGpu("H100 NVL", 95830), "h100_80gb");
  assert.equal(matchGpu("L40S", 46068), "l40s");
  assert.equal(matchGpu("RTX 4090", 24564), "rtx4090");
  assert.equal(matchGpu("RTX 4090D", 24564), "rtx4090");
  assert.equal(matchGpu("RTX 3090", 24576), null);
  assert.equal(matchGpu("Tesla V100", 32768), null);
  assert.equal(matchGpu("", 81920), null);
  assert.equal(matchGpu(undefined), null);
});

test("Vast offers are divided down to a per-GPU price and filtered to rentable known cards", () => {
  const offers = VAST.parse(VAST_PAYLOAD);
  assert.deepEqual(
    offers.map((o) => o.gpu_id).sort(),
    ["a100_80gb", "a100_80gb", "a100_80gb", "h100_80gb", "rtx4090"],
  );
  const eightWay = offers.find((o) => o.gpus === 8)!;
  assert.equal(eightWay.usd_per_hour, 1);                    // $8.00 for 8 GPUs
  assert.equal(eightWay.usd_per_hour_interruptible, 0.5);
  assert.equal(eightWay.usd_per_gb_month, 0.12);
  assert.equal(eightWay.reliability, 0.99);
  assert.ok(!offers.some((o) => o.gpu_name === "H100 PCIE"), "an offer that is not rentable is not a price");
  assert.deepEqual(VAST.parse({}), []);
  assert.deepEqual(VAST.parse(null), []);
});

test("RunPod's catalogue contributes one offer per card it quotes a price for", () => {
  const offers = RUNPOD.parse(RUNPOD_PAYLOAD);
  assert.deepEqual(offers.map((o) => o.gpu_id), ["a100_80gb", "h100_80gb"]);
  assert.equal(offers[0].usd_per_hour, 1.64);
  assert.equal(offers[0].usd_per_hour_interruptible, 0.8);
  assert.equal(offers[1].usd_per_hour, 2.79);
  assert.deepEqual(RUNPOD.parse({ data: {} }), []);
});

test("quantiles interpolate, and a quote reports the spread rather than only the median", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(quantile([7], 0.9), 7);

  const quotes = summarize(VAST.parse(VAST_PAYLOAD), "2026-09-11T02:15:00.000Z");
  const a100 = quotes.find((q) => q.gpu_id === "a100_80gb")!;
  assert.equal(a100.offers, 3);
  assert.equal(a100.usd_per_hour_min, 1);                    // $8.00 / 8 GPUs
  assert.equal(a100.usd_per_hour_median, 1.4);               // 1.0, 1.4, 2.0
  assert.equal(a100.usd_per_hour_p25, 1.2);
  assert.equal(a100.usd_per_hour_interruptible, 0.7);        // 0.5, 0.7, 1.0
  assert.equal(a100.usd_per_gb_month, 0.16);
  assert.equal(a100.source, "vast.ai");
  assert.equal(a100.observed_at, "2026-09-11T02:15:00.000Z");
  assert.ok(a100.usd_per_hour_min <= a100.usd_per_hour_p25 && a100.usd_per_hour_p25 <= a100.usd_per_hour_median);
  // One quote per (source, card), and none for cards nobody listed.
  assert.equal(quotes.filter((q) => q.gpu_id === "a100_80gb").length, 1);
  assert.equal(quotes.find((q) => q.gpu_id === "l40s"), undefined);
});

test("fetchQuotes merges the sources and survives one of them failing", async () => {
  const now = new Date("2026-09-11T02:15:00.000Z");
  const ok = await fetchQuotes({}, stubFetch({ "vast.ai": { body: VAST_PAYLOAD }, "runpod.io": { body: RUNPOD_PAYLOAD } }), [VAST, RUNPOD], now);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.observed_at, now.toISOString());
  assert.deepEqual(ok.quotes.map((q) => `${q.gpu_id}@${q.source}`), ["a100_80gb@runpod.io", "a100_80gb@vast.ai", "h100_80gb@runpod.io", "h100_80gb@vast.ai", "rtx4090@vast.ai"]);

  const degraded = await fetchQuotes({}, stubFetch({ "vast.ai": { body: VAST_PAYLOAD }, "runpod.io": { status: 500, body: {} } }), [VAST, RUNPOD], now);
  assert.equal(degraded.errors.length, 1);
  assert.equal(degraded.errors[0].source, "runpod.io");
  assert.match(degraded.errors[0].error, /HTTP 500/);
  assert.ok(degraded.quotes.length >= 3, "the surviving source still produces quotes");

  // A response that parses but contains nothing we price is an error, not silence.
  const empty = await fetchQuotes({}, stubFetch({ "vast.ai": { body: { offers: [] } } }), [VAST], now);
  assert.equal(empty.quotes.length, 0);
  assert.match(empty.errors[0].error, /no recognised GPUs/);

  // A source that is not configured is skipped without being reported as broken.
  const unconfigured: PriceSource = { id: "keyed", label: "Keyed", request: (env) => (env.SOME_KEY ? new Request("https://example.invalid/") : null), parse: () => [] };
  const skipped = await fetchQuotes({}, stubFetch({}), [unconfigured], now);
  assert.deepEqual(skipped.errors, []);
  assert.deepEqual(skipped.quotes, []);
});

test("the planner rate is the cheapest fresh median, and stale quotes are dropped", () => {
  const now = new Date("2026-09-11T12:00:00.000Z");
  const fresh = new Date(now.getTime() - 3600 * 1000).toISOString();
  const stale = new Date(now.getTime() - (MAX_QUOTE_AGE_HOURS + 1) * 3600 * 1000).toISOString();
  const quote = (over: Partial<Quote>): Quote => ({
    source: "vast.ai", gpu_id: "a100_80gb", observed_at: fresh, offers: 12,
    usd_per_hour_min: 0.9, usd_per_hour_p25: 1.0, usd_per_hour_median: 1.4, usd_per_hour_interruptible: 0.7, usd_per_gb_month: 0.16, ...over,
  });

  const rates = ratesFromQuotes(
    [
      quote({}),
      quote({ source: "runpod.io", usd_per_hour_median: 1.64, usd_per_hour_interruptible: 0.8 }),
      quote({ gpu_id: "h100_80gb", source: "runpod.io", usd_per_hour_median: 2.3, usd_per_hour_interruptible: null }),
      quote({ gpu_id: "h100_80gb", source: "vast.ai", usd_per_hour_median: 2.6 }),
      quote({ gpu_id: "l40s", observed_at: stale, usd_per_hour_median: 0.55 }),
      quote({ gpu_id: "rtx4090", usd_per_hour_median: 0 }),
    ],
    now,
  );
  assert.equal(rates.a100_80gb!.usd_per_hour, 1.4);
  assert.equal(rates.a100_80gb!.source, "vast.ai");
  assert.equal(rates.h100_80gb!.source, "runpod.io");
  assert.equal(rates.h100_80gb!.usd_per_hour_interruptible, null);
  assert.equal(rates.l40s, undefined, "a quote older than the freshness window is worse than the reference rate");
  assert.equal(rates.rtx4090, undefined, "a zero median is not a price");

  const drift = driftFromReference(rates);
  assert.equal(drift[0].gpu_id, "h100_80gb");                // biggest move from the reference table first
  assert.equal(drift[0].reference, GPUS.h100_80gb.usd_per_hour);
  assert.equal(drift[0].drift_pct, Math.round(((2.3 - GPUS.h100_80gb.usd_per_hour) / GPUS.h100_80gb.usd_per_hour) * 1000) / 10);
});

test("a plan prices against a live quote, and an explicit rate still wins", () => {
  const rates = {
    a100_80gb: { usd_per_hour: 1.4, usd_per_hour_interruptible: 0.7, source: "vast.ai", observed_at: "2026-09-11T02:15:00.000Z", offers: 12 },
    h100_80gb: { usd_per_hour: 2.3, usd_per_hour_interruptible: null, source: "runpod.io", observed_at: "2026-09-11T02:15:00.000Z", offers: 1 },
  };

  const live = planProgram({ program: "fine_tune", gpu: "a100_80gb" }, { rates });
  assert.equal(live.compute.usd_per_gpu_hour, 1.4);
  assert.equal(live.compute.price_source, "live:vast.ai");
  assert.equal(live.compute.price_offers, 12);
  assert.equal(live.compute.reference_usd_per_hour, GPUS.a100_80gb.usd_per_hour);
  assert.equal(live.compute.cost_usd.expected, Math.round(live.compute.gpu_hours.expected * 1.4));
  assert.ok(live.assumptions.some((a) => a.includes("median of 12 vast.ai listing(s)")));

  // Interruptible: a quoted bid is used as quoted; without one the live median
  // takes the same discount the reference table takes.
  assert.equal(planProgram({ gpu: "a100_80gb", interruptible: "true" }, { rates }).compute.usd_per_gpu_hour, 0.7);
  assert.equal(planProgram({ gpu: "h100_80gb", interruptible: "true" }, { rates }).compute.usd_per_gpu_hour, Math.round(2.3 * INTERRUPTIBLE_DISCOUNT * 10000) / 10000);

  // No quote for that card, live prices switched off, or an explicit rate.
  assert.equal(planProgram({ gpu: "l40s" }, { rates }).compute.price_source, "reference");
  assert.equal(planProgram({ gpu: "l40s" }, { rates }).compute.usd_per_gpu_hour, GPUS.l40s.usd_per_hour);
  const pinned = planProgram({ gpu: "a100_80gb", live_prices: "false" }, { rates });
  assert.equal(pinned.compute.price_source, "reference");
  assert.equal(pinned.compute.usd_per_gpu_hour, GPUS.a100_80gb.usd_per_hour);
  const quoted = planProgram({ gpu: "a100_80gb", usd_per_gpu_hour: "0.9" }, { rates });
  assert.equal(quoted.compute.price_source, "override");
  assert.equal(quoted.compute.usd_per_gpu_hour, 0.9);

  // The side-by-side comparison is priced the same way, card by card.
  const compare = planProgram({ gpu: "a100_80gb" }, { rates });
  assert.equal(normalizeInput({}).live_prices, true);
  assert.equal(priceFor(compare.input, { rates }).source, "live:vast.ai");
  assert.equal(priceFor({ ...compare.input, gpu: "rtx4090" }, { rates }).source, "reference");
});

test("offers with no interruptible bid or disk price leave those fields null", () => {
  const offers: Offer[] = [
    { source: "x", gpu_id: "l40s", gpu_name: "L40S", gpus: 1, usd_per_hour: 0.8, usd_per_hour_interruptible: null, usd_per_gb_month: null, reliability: null },
    { source: "x", gpu_id: "l40s", gpu_name: "L40S", gpus: 1, usd_per_hour: 1.0, usd_per_hour_interruptible: null, usd_per_gb_month: null, reliability: null },
  ];
  const [quote] = summarize(offers, "2026-09-11T00:00:00.000Z");
  assert.equal(quote.usd_per_hour_median, 0.9);
  assert.equal(quote.usd_per_hour_interruptible, null);
  assert.equal(quote.usd_per_gb_month, null);
});
