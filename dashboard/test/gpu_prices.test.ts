import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_QUOTE_AGE_HOURS,
  collectQuotes,
  fetchProviderOffers,
  matchGpu,
  parseRunpodOffers,
  parseVastOffers,
  percentile,
  ratesFromQuotes,
  summarizeOffers,
  type GpuQuote,
} from "../src/gpu_prices";
import { GPUS, INTERRUPTIBLE_DISCOUNT, planProgram } from "../src/planner";

/** A trimmed Vast.ai /api/v0/bundles/ response: the fields the parser reads. */
const VAST = {
  offers: [
    { id: 1, gpu_name: "A100 SXM4", num_gpus: 8, gpu_ram: 81_920, dph_total: 9.6, min_bid: 4.8, reliability2: 0.99, storage_cost: 0.12 },
    { id: 2, gpu_name: "A100 PCIE", num_gpus: 1, gpu_ram: 81_920, dph_total: 1.4, min_bid: 0.7, reliability2: 0.97, storage_cost: 0.2 },
    { id: 3, gpu_name: "A100 PCIE", num_gpus: 1, gpu_ram: 40_960, dph_total: 0.6, min_bid: 0.3, reliability2: 0.98 },   // 40 GB: a different machine
    { id: 4, gpu_name: "H100 PCIE", num_gpus: 2, gpu_ram: 81_920, dph_total: 3.6, min_bid: 2.0, reliability2: 0.99 },
    { id: 5, gpu_name: "H100 SXM", num_gpus: 1, gpu_ram: 81_920, dph_total: 2.4, min_bid: 1.4, reliability2: 0.95 },
    { id: 6, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24_576, dph_total: 0.36, min_bid: 0.18, reliability2: 0.93 },
    { id: 7, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24_576, dph_total: 0.29, min_bid: 0.15, reliability2: 0.42 },  // unreliable host
    { id: 8, gpu_name: "RTX 3090", num_gpus: 1, gpu_ram: 24_576, dph_total: 0.2, min_bid: 0.1, reliability2: 0.99 },    // not a planner GPU
    { id: 9, gpu_name: "H100 NVL", num_gpus: 1, gpu_ram: 94_208, dph_total: 0.0, min_bid: 0.0, reliability2: 0.99 },    // zero price: a listing error
  ],
};

const RUNPOD = {
  data: {
    gpuTypes: [
      { id: "NVIDIA A100 80GB PCIe", displayName: "A100 80GB PCIe", memoryInGb: 80, lowestPrice: { minimumBidPrice: 0.94, uninterruptablePrice: 1.64 } },
      { id: "NVIDIA H100 80GB HBM3", displayName: "H100 SXM", memoryInGb: 80, lowestPrice: { minimumBidPrice: 1.99, uninterruptablePrice: 2.99 } },
      { id: "NVIDIA L40S", displayName: "L40S", memoryInGb: 48, lowestPrice: { minimumBidPrice: 0.51, uninterruptablePrice: 0.86 } },
      { id: "NVIDIA GeForce RTX 3080", displayName: "RTX 3080", memoryInGb: 10, lowestPrice: { minimumBidPrice: 0.1, uninterruptablePrice: 0.2 } },
      { id: "NVIDIA A100-SXM4-40GB", displayName: "A100 40GB", memoryInGb: 40, lowestPrice: { minimumBidPrice: 0.6, uninterruptablePrice: 1.0 } },
    ],
  },
};

test("card names map onto the planner's GPU classes, memory disambiguating the A100s", () => {
  assert.equal(matchGpu("A100 SXM4", 80), "a100_80gb");
  assert.equal(matchGpu("NVIDIA A100 80GB PCIe", 80), "a100_80gb");
  assert.equal(matchGpu("A100 PCIE", 40), null);           // the 40 GB card is not this plan's A100
  assert.equal(matchGpu("A100 PCIE", null), "a100_80gb");  // unknown memory: take the listing at its word
  assert.equal(matchGpu("H100 NVL", 94), "h100_80gb");
  assert.equal(matchGpu("L40S", 48), "l40s");
  assert.equal(matchGpu("RTX 4090", 24), "rtx4090");
  assert.equal(matchGpu("RTX 3090", 24), null);
  assert.equal(matchGpu("", null), null);
});

test("Vast.ai bundles become per-GPU-hour offers in both pricing modes", () => {
  const offers = parseVastOffers(VAST);
  const a100OnDemand = offers.filter((o) => o.gpu === "a100_80gb" && o.mode === "on_demand");
  // An 8-GPU machine at $9.60/hour is $1.20 per GPU-hour, not $9.60.
  assert.deepEqual(a100OnDemand.map((o) => o.usd_per_hour).sort((a, b) => a - b), [1.2, 1.4]);
  assert.deepEqual(offers.filter((o) => o.gpu === "a100_80gb" && o.mode === "interruptible").map((o) => o.usd_per_hour).sort((a, b) => a - b), [0.6, 0.7]);
  assert.deepEqual(offers.filter((o) => o.gpu === "h100_80gb" && o.mode === "on_demand").map((o) => o.usd_per_hour).sort((a, b) => a - b), [1.8, 2.4]);

  // Dropped: the 40 GB A100, the RTX 3090, the unreliable 4090 host and the $0 listing.
  assert.equal(offers.filter((o) => o.usd_per_hour === 0.6 && o.mode === "on_demand").length, 0);
  assert.equal(offers.filter((o) => o.gpu === "rtx4090" && o.mode === "on_demand").length, 1);
  assert.equal(offers.every((o) => o.usd_per_hour > 0), true);
  assert.equal(offers[0].provider, "vast.ai");
  assert.equal(offers.find((o) => o.gpu === "a100_80gb")!.storage_usd_per_gb_month, 0.12);

  assert.deepEqual(parseVastOffers({}), []);
  assert.deepEqual(parseVastOffers({ offers: "nope" }), []);
  assert.deepEqual(parseVastOffers(null), []);
});

test("RunPod gpuTypes become one offer per card and mode", () => {
  const offers = parseRunpodOffers(RUNPOD);
  assert.deepEqual(
    offers.map((o) => [o.gpu, o.mode, o.usd_per_hour]),
    [
      ["a100_80gb", "on_demand", 1.64],
      ["a100_80gb", "interruptible", 0.94],
      ["h100_80gb", "on_demand", 2.99],
      ["h100_80gb", "interruptible", 1.99],
      ["l40s", "on_demand", 0.86],
      ["l40s", "interruptible", 0.51],
    ],
  );
  assert.deepEqual(parseRunpodOffers({ data: { gpuTypes: [{ displayName: "H100", memoryInGb: 80, lowestPrice: null }] } }), []);
  assert.deepEqual(parseRunpodOffers({ errors: [{ message: "rate limited" }] }), []);
});

test("offers collapse into one min/p25/median quote per provider, GPU and mode", () => {
  assert.equal(percentile([1, 2, 3, 4], 25), 1);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 50), 0);

  const quotes = summarizeOffers([...parseVastOffers(VAST), ...parseRunpodOffers(RUNPOD)], "2026-09-11T02:15:00.000Z");
  const vastA100 = quotes.find((q) => q.provider === "vast.ai" && q.gpu === "a100_80gb" && q.mode === "on_demand")!;
  assert.equal(vastA100.samples, 2);
  assert.equal(vastA100.min_usd_per_hour, 1.2);
  assert.equal(vastA100.median_usd_per_hour, 1.3);          // even count: the midpoint of 1.2 and 1.4
  assert.equal(vastA100.max_usd_per_hour, 1.4);
  assert.equal(vastA100.storage_usd_per_gb_month, 0.16);
  assert.equal(vastA100.observed_at, "2026-09-11T02:15:00.000Z");

  const runpodA100 = quotes.find((q) => q.provider === "runpod" && q.gpu === "a100_80gb" && q.mode === "on_demand")!;
  assert.equal(runpodA100.samples, 1);
  assert.equal(runpodA100.median_usd_per_hour, 1.64);
  // Both providers are kept, so the cheaper one can be chosen with its provenance intact.
  assert.equal(quotes.filter((q) => q.gpu === "a100_80gb" && q.mode === "on_demand").length, 2);
  assert.deepEqual(summarizeOffers([], "2026-09-11T02:15:00.000Z"), []);
});

const quote = (over: Partial<GpuQuote>): GpuQuote => ({
  provider: "vast.ai",
  gpu: "a100_80gb",
  mode: "on_demand",
  observed_at: "2026-09-11T02:00:00.000Z",
  samples: 12,
  min_usd_per_hour: 0.9,
  p25_usd_per_hour: 1.0,
  median_usd_per_hour: 1.1,
  max_usd_per_hour: 2.4,
  storage_usd_per_gb_month: 0.12,
  ...over,
});

test("the rate for a GPU is the cheapest provider's median, and stale quotes are dropped", () => {
  const now = new Date("2026-09-11T08:00:00.000Z");
  const rates = ratesFromQuotes(
    [
      quote({}),
      quote({ provider: "runpod", median_usd_per_hour: 1.64, samples: 1 }),
      quote({ gpu: "h100_80gb", mode: "interruptible", median_usd_per_hour: 1.5 }),
      quote({ gpu: "l40s", observed_at: "2026-09-01T02:00:00.000Z", median_usd_per_hour: 0.4 }),   // 10 days old
    ],
    now,
  );
  assert.equal(rates.a100_80gb?.on_demand?.usd_per_hour, 1.1);
  assert.equal(rates.a100_80gb?.on_demand?.provider, "vast.ai");
  assert.equal(rates.a100_80gb?.on_demand?.min_usd_per_hour, 0.9);
  assert.equal(rates.a100_80gb?.on_demand?.age_hours, 6);
  assert.equal(rates.a100_80gb?.interruptible, undefined);
  assert.equal(rates.h100_80gb?.interruptible?.usd_per_hour, 1.5);
  assert.equal(rates.l40s, undefined, `a quote older than ${MAX_QUOTE_AGE_HOURS} h must not price a plan`);
  assert.equal(ratesFromQuotes([quote({ samples: 0 })], now).a100_80gb, undefined);
});

test("a live quote replaces the reference rate, and an explicit rate still wins", () => {
  const now = new Date("2026-09-11T08:00:00.000Z");
  const rates = ratesFromQuotes([quote({ median_usd_per_hour: 1.1 }), quote({ mode: "interruptible", median_usd_per_hour: 0.55, min_usd_per_hour: 0.4 })], now);

  const reference = planProgram({ program: "fine_tune", gpu: "a100_80gb" });
  assert.equal(reference.compute.price_source, "reference");
  assert.equal(reference.compute.usd_per_gpu_hour, GPUS.a100_80gb.usd_per_hour);
  assert.equal(reference.compute.price_quote, null);

  const live = planProgram({ program: "fine_tune", gpu: "a100_80gb" }, rates);
  assert.equal(live.compute.price_source, "live");
  assert.equal(live.compute.usd_per_gpu_hour, 1.1);
  assert.equal(live.compute.reference_usd_per_hour, GPUS.a100_80gb.usd_per_hour);
  assert.equal(live.compute.price_quote?.provider, "vast.ai");
  assert.equal(live.compute.cost_usd.expected, Math.round(live.compute.gpu_hours.expected * 1.1));
  assert.ok(live.assumptions.some((a) => a.includes("median of 12 vast.ai on-demand listing(s)")));

  // A marketplace bid price is already discounted; the reference discount is not applied on top.
  const spot = planProgram({ program: "fine_tune", gpu: "a100_80gb", interruptible: "true" }, rates);
  assert.equal(spot.compute.usd_per_gpu_hour, 0.55);
  assert.notEqual(spot.compute.usd_per_gpu_hour, Math.round(1.1 * INTERRUPTIBLE_DISCOUNT * 10000) / 10000);

  // An explicit rate and opting out both fall back past the live quote.
  assert.equal(planProgram({ gpu: "a100_80gb", usd_per_gpu_hour: "0.9" }, rates).compute.price_source, "override");
  assert.equal(planProgram({ gpu: "a100_80gb", usd_per_gpu_hour: "0.9" }, rates).compute.usd_per_gpu_hour, 0.9);
  assert.equal(planProgram({ gpu: "a100_80gb", live_prices: "false" }, rates).compute.price_source, "reference");
  // A GPU the feed has no quote for keeps its reference rate inside the same comparison.
  const compare = planProgram({ gpu: "a100_80gb" }, rates).input;
  assert.equal(planProgram({ ...compare, gpu: "rtx4090" }, rates).compute.price_source, "reference");
});

test("a provider that is down or broken contributes no offers instead of failing the poll", async () => {
  const responses: Record<string, () => Promise<Response>> = {
    vast: async () => new Response(JSON.stringify(VAST), { headers: { "content-type": "application/json" } }),
    runpodDown: async () => new Response("gateway timeout", { status: 504 }),
  };
  const fakeFetch = (async (url: string | URL | Request) => {
    const href = String(typeof url === "object" && "url" in url ? url.url : url);
    return href.includes("runpod") ? responses.runpodDown() : responses.vast();
  }) as typeof fetch;

  const quotes = await collectQuotes(fakeFetch, "2026-09-11T02:15:00.000Z");
  assert.ok(quotes.length > 0);
  assert.deepEqual(Array.from(new Set(quotes.map((q) => q.provider))), ["vast.ai"]);

  const throwing = (async () => { throw new Error("network down"); }) as typeof fetch;
  assert.deepEqual(await fetchProviderOffers("vast.ai", throwing), []);
  assert.deepEqual(await collectQuotes(throwing, "2026-09-11T02:15:00.000Z"), []);

  const garbage = (async () => new Response("<html>maintenance</html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
  assert.deepEqual(await fetchProviderOffers("runpod", garbage), []);
});
