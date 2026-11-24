# ADR-005: LinkedIn is the only source of jobs, read first from its own alert emails and then by the signed-in browser

Source: [design-v3](../design-v3.md), section 5.7 (decision record ADR-005).

## Status

Accepted (2026-11-24)

## Context

The owner decided that LinkedIn is the primary and only job source, and that employers' own job feeds are not kept anywhere, even as a reserve. LinkedIn offers individuals no interface for job search and prohibits automated access.

## Considered options

As in design-v3 section 5, which compares the options for this decision; this record does not restate them.

## Decision

Jobs come only from LinkedIn. Up to 20 saved job alerts deliver candidates by email with no page loaded; a fixed script in the single LinkedIn browser runs the user's searches and reads result cards; a cheap screen decides which job pages are opened, each once, within a daily page budget. No employer feed, aggregator, company list or web search is used.

### Rejected alternatives

The options design-v3 section 5 compares other than the one decided above, for the reasons given there.

## Consequences

The system is simpler and looks where the user would look. Jobs not on LinkedIn are missed. Every job costs signed-in activity on the user's account, which raises the account risk described in section 4.2. If LinkedIn restricts the account, role search and applying stop, with nothing to fall back on.
