-- Marketplace GPU price history behind the planner's cost bands.
--
-- Market data, not tenant data: one row per observation, provider, GPU class
-- and pricing mode, shared by every tenant and served unauthenticated.

CREATE TABLE IF NOT EXISTS gpu_price_quotes (
  observed_at TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- vast.ai | runpod
  gpu_id TEXT NOT NULL,                   -- a100_80gb | h100_80gb | l40s | rtx4090
  mode TEXT NOT NULL,                     -- on_demand | interruptible
  samples INTEGER NOT NULL,
  min_usd_per_hour REAL NOT NULL,
  p25_usd_per_hour REAL NOT NULL,
  median_usd_per_hour REAL NOT NULL,
  max_usd_per_hour REAL NOT NULL,
  storage_usd_per_gb_month REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (observed_at, provider, gpu_id, mode)
);

CREATE INDEX IF NOT EXISTS gpu_price_quotes_gpu ON gpu_price_quotes(gpu_id, mode, observed_at DESC);
CREATE INDEX IF NOT EXISTS gpu_price_quotes_observed ON gpu_price_quotes(observed_at DESC);
