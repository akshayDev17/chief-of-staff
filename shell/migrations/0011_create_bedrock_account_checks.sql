-- Bedrock's "Refresh model list" (src/providers/bedrock-account.ts): what
-- the user's own AWS account says, read through their own role, of the
-- models Bedrock offers. One row per user, replaced on each refresh, and its
-- `checked_at` also spaces refreshes a minute apart.
--
-- `form` is Anthropic's one-time use-case form for the account: `filled`,
-- `not_filled` or `unknown` (a stack older than template 1.2.0, or no
-- answer). `models` is JSON keyed by the price table's model name: each
-- Marketplace-sold model's agreement, authorization, entitlement and region
-- availability as GetFoundationModelAvailability gives them, or "unknown".
-- `note` is the plain sentence shown when the account could not be read.
-- `catalog_error` is why the model list itself could not be read again.

CREATE TABLE bedrock_account_checks (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,            -- ISO 8601 UTC
  form TEXT NOT NULL,
  models TEXT NOT NULL,                -- JSON, see above
  note TEXT,
  catalog_error TEXT
);
