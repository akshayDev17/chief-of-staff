-- The app's users (design-v3 11.3, T12). Every other user-owned row carries
-- one of these ids, and every query is scoped to one user.
--
-- A user is the verified Cloudflare Access identity: its `sub` claim, which
-- stays the same across sign-ins. The email is kept for display and changes
-- with the identity. A user row is made at the first signed-in request
-- (src/users.ts); invitations (T-later) decide who can sign in at all.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                     -- random UUID, never derived from the email
  access_subject TEXT NOT NULL UNIQUE,     -- the Access token's `sub`
  email TEXT NOT NULL,
  created_at TEXT NOT NULL                 -- ISO 8601 UTC
);
