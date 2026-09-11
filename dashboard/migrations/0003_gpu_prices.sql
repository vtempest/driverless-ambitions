-- Marketplace GPU price samples, written by the cron trigger.
--
-- Deliberately not tenant-scoped: a Vast.ai listing is public market data, the
-- same number for every tenant, and the planner's price history is more useful
-- the longer and denser it is. One row per (source, card, observation).

CREATE TABLE IF NOT EXISTS gpu_price_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                          -- vast.ai | runpod.io
  gpu_id TEXT NOT NULL,                          -- planner GpuId: a100_80gb | h100_80gb | l40s | rtx4090
  observed_at TEXT NOT NULL,                     -- ISO 8601, one value per refresh
  offers INTEGER NOT NULL DEFAULT 0,             -- listings behind the quote
  usd_per_hour_min REAL,
  usd_per_hour_p25 REAL,
  usd_per_hour_median REAL,                      -- what the planner prices against
  usd_per_hour_interruptible REAL,               -- median bid/spot price, when quoted
  usd_per_gb_month REAL,                         -- median disk rent on those hosts
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS gpu_price_samples_unique ON gpu_price_samples(source, gpu_id, observed_at);
CREATE INDEX IF NOT EXISTS gpu_price_samples_gpu_t ON gpu_price_samples(gpu_id, observed_at DESC);
