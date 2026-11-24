-- The usage ledger (design-v3 1.7, Record A; T12). The model proxy writes one
-- row for every call it sends to a provider, tagged with the user. No prompt
-- or response body is ever stored, here or anywhere.
--
-- A call refused by the provider (a 429, say) is a row too, with its status
-- and no tokens; the fallback's answer is the next row, with `fallback` 1 and
-- the reason it ran. A call the proxy refuses before sending (no budget, no
-- price, not connected) reaches no provider and writes no row.

CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  at TEXT NOT NULL,                        -- ISO 8601 UTC, clock at call start
  task TEXT NOT NULL,                      -- search, rank, map, fill, check, ...
  site TEXT NOT NULL DEFAULT 'none',       -- the site's main domain, or 'none'
  company TEXT,
  run_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  region TEXT NOT NULL,                    -- the region or deployment type priced
  tier TEXT,                               -- Smallest, Middle, Strongest that day
  plugin_version TEXT NOT NULL,            -- the provider plug-in's version label
  status INTEGER NOT NULL,                 -- the provider's HTTP status
  fallback INTEGER NOT NULL CHECK (fallback IN (0, 1)),
  fallback_reason TEXT CHECK (fallback_reason IN ('refused', 'budget_spent')),
  input_tokens INTEGER NOT NULL DEFAULT 0, -- uncached input
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,    -- written to the 5-minute cache
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0, -- written to the 1-hour cache
  output_tokens INTEGER NOT NULL DEFAULT 0,
  long_prompt INTEGER NOT NULL DEFAULT 0 CHECK (long_prompt IN (0, 1)), -- billed at long-prompt rates
  duration_ms INTEGER NOT NULL,
  -- Tokens at the price table's list price; NULL when a kind of token the call
  -- used had none, which stops the provider until the 1st rather than undercount.
  cost_usd REAL CHECK (cost_usd >= 0),
  CHECK ((fallback = 0 AND fallback_reason IS NULL) OR (fallback = 1 AND fallback_reason IS NOT NULL))
);

-- The budget check sums one user's spend at one provider this month.
CREATE INDEX model_calls_spend ON model_calls (user_id, provider, at);
