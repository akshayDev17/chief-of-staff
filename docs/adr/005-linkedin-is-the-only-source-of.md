# ADR-005: LinkedIn is the only source of jobs, read first from its own alert emails and then by the signed-in browser

Source: [design-v3](../design-v3.md), section 5.7 (decision record ADR-005).

## Status

Accepted (2026-11-24)

## Context

The owner decided that LinkedIn is the primary and only job source, and that employers' own job feeds are not kept anywhere, even as a reserve. LinkedIn offers individuals no interface for job search and prohibits automated access.

## Considered options

design-v3 compares the ways of reading LinkedIn's jobs in the table in section 5.1; sections 5.1, 4.3 and 4.10 name the sources that are not used.

- **LinkedIn's own job-alert email** (decided; section 5.1).
- **The signed-in LinkedIn browser**, running the user's searches by a fixed script (decided; section 5.1).
- **An official LinkedIn interface for reading jobs** (section 5.1).
- **LinkedIn's public job pages read without signing in** (sections 5.1 and 4.3).
- **LinkedIn's official data-portability interface, for reading only** (section 4.3).
- **Employer feeds, job aggregators, a company-discovery run, a list of companies to maintain, or web search** (section 5.1), kept as the main source or in reserve (section 4.10).

## Decision

Jobs come only from LinkedIn. Up to 20 saved job alerts deliver candidates by email with no page loaded; a fixed script in the single LinkedIn browser runs the user's searches and reads result cards; a cheap screen decides which job pages are opened, each once, within a daily page budget. No employer feed, aggregator, company list or web search is used.

### Rejected alternatives

- **An official LinkedIn interface for reading jobs**: none exists. "The only permissions LinkedIn opens to any developer are sign-in and posting; its job interfaces are for employers' recruiting systems" (section 5.1).
- **LinkedIn's public job pages read without signing in**: "Not used" (section 5.1). LinkedIn's `robots.txt` says "The use of robots or other automated means to access LinkedIn without the express permission of LinkedIn is strictly prohibited", and "It would also not remove the need to sign in to apply" (section 4.3).
- **LinkedIn's official data-portability interface**: "Open only to members whose profile location is in the EU, the EEA or Switzerland" (section 4.3).
- **Employer feeds, aggregators, a company list or web search, as a source or in reserve**: "the owner has ruled out keeping employers' feeds anywhere, even in reserve (HANDOFF.md:26)" (section 5); "The owner has decided that no other source of roles is kept, not even in reserve ... There is no fallback, by decision" (section 4.10). What this costs: "roles that are not on LinkedIn are never seen" (section 5.1).

## Consequences

The system is simpler and looks where the user would look. Jobs not on LinkedIn are missed. Every job costs signed-in activity on the user's account, which raises the account risk described in section 4.2. If LinkedIn restricts the account, role search and applying stop, with nothing to fall back on.
