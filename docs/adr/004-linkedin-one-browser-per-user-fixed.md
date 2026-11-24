# ADR-004: each user's LinkedIn work runs in one browser, as fixed scripts, a few short sittings a day, under one page budget; LinkedIn's own email does the reading; the user signs in and no password is stored; any challenge stops everything

Source: [design-v3](../design-v3.md), section 4.10 (decision record ADR-004).

## Status

Accepted (2026-11-24)

## Context

LinkedIn is the only source of roles, the place Easy Apply applications are made, and the place referrals are asked for. All of it must be automatic, and all of it breaches LinkedIn's User Agreement. LinkedIn states that it models request order and timing, limits fast or bulk Easy Apply, challenges unfamiliar devices and proxies, limits people search, and restricts accounts whose invitations are ignored. The owner decided that no LinkedIn password or authenticator secret is stored: an expired session becomes a phone alert and the user signs in (HANDOFF.md:31, :48).

## Considered options

design-v3 compares the options in the table "Options considered and not used" in section 4.3; correction C2 ("Where this design departs from design-v2") and sections 2.5, 4.4 and 6.6 name further alternatives.

- **One dedicated, persistent Chrome profile per user in a Cloudflare Container, driven by fixed scripts** (decided; sections 3.3 and 4.3).
- **Cloudflare Browser Run for LinkedIn** (section 4.3).
- **Reading LinkedIn's public job pages without signing in** (section 4.3).
- **A hosted LinkedIn API vendor such as Unipile** (section 4.3).
- **A second LinkedIn account for the agent** (section 4.3).
- **LinkedIn Premium** (section 4.3).
- **LinkedIn's official data-portability interface, for reading only** (section 4.3).
- **A stored LinkedIn password and authenticator secret**, as in design-v2's ADR-004 (correction C2).
- **A model steering the LinkedIn browser** (sections 2.5 and 6.2).
- **The app requesting or downloading the LinkedIn export itself** (section 4.4).
- **"Sign in with LinkedIn" and "Apply with LinkedIn" buttons on an employer's own site** (section 6.6).

## Decision

One dedicated, persistent Chrome profile per user in a Cloudflare Container does all of that user's LinkedIn work, never Browser Run, one run at a time, through NodeMaven residential sessions in the user's own place. Every LinkedIn action is a fixed script; the model reads extracted text and writes prepared text and never steers the LinkedIn browser. Roles are discovered first from job-alert mail, and acceptances, replies and application updates from notification mail, fetched from the user's Gmail. Work is done in a few short sittings a day inside the user's waking hours, under one daily budget for all LinkedIn pages and a cap per action, enforced by the user's `Chief`. The user signs in through the remote view; the profile is saved encrypted and restored for each sitting; no LinkedIn password or authenticator secret is stored anywhere; a signed-out or expired page stops all of that user's LinkedIn work and raises an urgent alert. Any challenge stops all of that user's LinkedIn work at once; challenges are never worked around (ADR-015).

### Rejected alternatives

- **Cloudflare Browser Run for LinkedIn**: "Every request carries a signature proving it is an automated Cloudflare browser (section 3.1)" (section 4.3).
- **Reading LinkedIn's public job pages without signing in**: "LinkedIn's `robots.txt` opens: "The use of robots or other automated means to access LinkedIn without the express permission of LinkedIn is strictly prohibited", and disallows everything for any crawler it has not named. It would also not remove the need to sign in to apply" (section 4.3).
- **A hosted LinkedIn API vendor such as Unipile**: "It "operates through reverse engineering", needs the user's password or session cookie, and costs a 49 EUR monthly minimum. Handing over credentials is itself a Don't ("sharing log-in credentials or copying cookies")" (section 4.3).
- **A second LinkedIn account for the agent**: ""Create a false identity" is the first Don't; it also defeats the purpose, since applications and referrals depend on the user's real profile" (section 4.3).
- **LinkedIn Premium**: "Declined by the owner (decision 10). Outreach is built for a free account's limits (section 4.8)" (section 4.3).
- **LinkedIn's official data-portability interface, for reading only**: "Open only to members whose profile location is in the EU, the EEA or Switzerland. Raised with T67 only if the owner wants that route (A6)" (section 4.3).
- **A stored LinkedIn password and authenticator secret**: replaced by correction C2: "No stored LinkedIn password or authenticator secret. An expired session stops LinkedIn work and becomes a phone alert; the user signs in" (HANDOFF.md:31, :48). "No LinkedIn password and no authenticator secret is stored anywhere (standing rule 7)" (section 3.5).
- **A model steering the LinkedIn browser**: "LinkedIn's dialog has one shape; a model steering LinkedIn adds risk for nothing (section 4.3)" (section 2.5). Fixed scripts keep "the pattern of page loads on LinkedIn short and the same every time, which matters for the account (section 4.3), and avoids a known limit" (section 6.2).
- **The app requesting or downloading the export itself**: "that would add LinkedIn page loads and account-settings automation, a risk to the account, to save one step (T67)" (section 4.4).
- **"Sign in with LinkedIn" and "Apply with LinkedIn" on employers' sites**: "They would hand a portal a session on the user's main accounts and put the LinkedIn account in front of every portal's bot checks" (section 6.6).

## Consequences

The signed-in footprint is some dozens of page loads a day per user; the risk of restriction is lowered, not removed, and the activity remains a breach of the agreement. A restriction stops that user's system, with no fallback. Throughput is bounded by the page budget and by one-at-a-time use of the browser. Each expired session needs the user to sign in, and how often that happens is measured from M4. The code is public and visible to LinkedIn.
