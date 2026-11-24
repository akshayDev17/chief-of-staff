# ADR-007: answers come only from the user's knowledge hub, with no confirmation step; a missing fact raises an alert once

Source: [design-v3](../design-v3.md), section 6.10 (decision record ADR-007).

## Status

Accepted (2026-11-24)

## Context

Applications are submitted without review, on LinkedIn and on employers' portals. A model that fills gaps with plausible values would put false statements about a user in front of employers, some of them legal declarations. The owner decided that users fill the knowledge hub once and are not asked to confirm what the agent signs.

## Considered options

As in design-v3 section 6, which compares the options for this decision; this record does not restate them.

## Decision

Every value about a user is typed by the `answer` tool from that user's knowledge hub, with its source recorded. Legal and factual questions accept only fact-sheet entries the user gave, in any wording that matches strictly, or a derivation those entries settle for certain, recorded with its source; a generated value is never accepted for them. No answer waits for confirmation. If no source exists the tool returns `MISSING`, `submit` is refused in code, and the user receives one alert with the exact question; the answer is stored with its scope ("just this job" or "every job", the default), written before any waiting application resumes, and releases every application waiting on it. An option is chosen for a stored fact only when exactly one option matches it.

### Rejected alternatives

The options design-v3 section 6 compares other than the one decided above, for the reasons given there.

## Consequences

Early applications stop often; the rate falls as the hub fills. Each new question is answered once. No guessed value can reach a submitted form through the normal path. A fact that has gone out of date keeps being used until the user changes it, and a wrong match can put a true fact in the wrong field; the agent signs either in the user's name. Free-text answers are generated under the citation rule of ADR-008.
