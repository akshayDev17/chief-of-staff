# ADR-004: each user's LinkedIn work runs in one browser, as fixed scripts, a few short sittings a day, under one page budget; LinkedIn's own email does the reading; the user signs in and no password is stored; any challenge stops everything

Source: [design-v3](../design-v3.md), section 4.10 (decision record ADR-004).

## Status

Accepted (2026-11-24)

## Context

LinkedIn is the only source of roles, the place Easy Apply applications are made, and the place referrals are asked for. All of it must be automatic, and all of it breaches LinkedIn's User Agreement. LinkedIn states that it models request order and timing, limits fast or bulk Easy Apply, challenges unfamiliar devices and proxies, limits people search, and restricts accounts whose invitations are ignored. The owner decided that no LinkedIn password or authenticator secret is stored: an expired session becomes a phone alert and the user signs in (HANDOFF.md:31, :48).

## Considered options

As in design-v3 section 4, which compares the options for this decision; this record does not restate them.

## Decision

One dedicated, persistent Chrome profile per user in a Cloudflare Container does all of that user's LinkedIn work, never Browser Run, one run at a time, through NodeMaven residential sessions in the user's own place. Every LinkedIn action is a fixed script; the model reads extracted text and writes prepared text and never steers the LinkedIn browser. Roles are discovered first from job-alert mail, and acceptances, replies and application updates from notification mail, fetched from the user's Gmail. Work is done in a few short sittings a day inside the user's waking hours, under one daily budget for all LinkedIn pages and a cap per action, enforced by the user's `Chief`. The user signs in through the remote view; the profile is saved encrypted and restored for each sitting; no LinkedIn password or authenticator secret is stored anywhere; a signed-out or expired page stops all of that user's LinkedIn work and raises an urgent alert. Any challenge stops all of that user's LinkedIn work at once; challenges are never worked around (ADR-015).

### Rejected alternatives

The options design-v3 section 4 compares other than the one decided above, for the reasons given there.

## Consequences

The signed-in footprint is some dozens of page loads a day per user; the risk of restriction is lowered, not removed, and the activity remains a breach of the agreement. A restriction stops that user's system, with no fallback. Throughput is bounded by the page budget and by one-at-a-time use of the browser. Each expired session needs the user to sign in, and how often that happens is measured from M4. The code is public and visible to LinkedIn.
