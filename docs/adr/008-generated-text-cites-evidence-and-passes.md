# ADR-008: generated text about the user must cite knowledge-hub evidence and pass an independent check

Source: [design-v3](../design-v3.md), section 7.3 (decision record ADR-008).

## Status

Accepted (2026-11-24)

## Context

Cover letters, free-text answers and referral messages are sent without review. Language models readily add plausible but false experience, numbers and enthusiasm.

## Considered options

As in design-v3 section 7, which compares the options for this decision; this record does not restate them.

## Decision

Any generated text that makes a statement about the user or a company is produced with a claims table mapping each sentence to a knowledge-hub evidence id or a fetched source URL. A separate model call verifies each sentence against its support, and a rule-based check requires names, numbers and dates to appear verbatim in the cited evidence. Failing sentences are rewritten once and then removed. Text left with too little supported content is not sent.

### Rejected alternatives

The options design-v3 section 7 compares other than the one decided above, for the reasons given there.

## Consequences

Letters are shorter and plainer than unconstrained output. Each letter costs two extra model calls. Every sentence in every sent document can be traced to its source from the dashboard. What the user has not put in the knowledge hub cannot appear in a letter, so the hub's completeness limits the letters' quality.
