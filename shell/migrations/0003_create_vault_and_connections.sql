-- The per-user vault and the provider connections (design-v3 1.4, 11.3; T12).
--
-- The vault: each user's own AES-256-GCM key, stored only wrapped by the one
-- vault key that sits in Secrets Store, and that user's items encrypted with
-- it. It holds pasted keys (none for the three v1 providers), and later the
-- portal passwords and the Gmail token. Nothing in it is shown again after
-- entry. See src/vault.ts.

CREATE TABLE vault_keys (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  wrapped_key TEXT NOT NULL,               -- base64: IV then AES-GCM ciphertext
  created_at TEXT NOT NULL
);

CREATE TABLE vault_items (
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,                    -- base64: IV then AES-GCM ciphertext
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

-- One connection per user and provider, written by that provider's Connect
-- method (T16) and read by the proxy; nothing else writes or reads it. For the
-- three v1 providers it holds nothing secret: an AWS role ARN and external
-- ID, a Microsoft tenant ID and endpoint, a Google project ID. Only the
-- fields the provider's plug-in declares are accepted (src/connections.ts).
CREATE TABLE provider_connections (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  fields TEXT NOT NULL,                    -- JSON object of the declared, non-secret fields
  plugin_version TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
