# ADR-007: answers come only from the user's knowledge hub, with no confirmation step; a missing fact raises an alert once

Source: [design-v3](../design-v3.md), section 6.10 (decision record ADR-007).

## Status

Accepted (2026-11-24)

## Context

Applications are submitted without review, on LinkedIn and on employers' portals. A model that fills gaps with plausible values would put false statements about a user in front of employers, some of them legal declarations. The owner decided that users fill the knowledge hub once and are not asked to confirm what the agent signs.

## Considered options

design-v3 compares no alternatives for this decision. Its text names these, in sections 2.6, 6.5, 8.1, 8.3 and 8.6:

- **A confirmation step** before an answer is used or an application is sent (sections 8.1 and 8.6).
- **ADK's tool confirmation** (`require_confirmation=True`) (section 2.6).
- **A generated value for a legal or factual question** (section 6.5).
- **Reusing a near-miss wording** of a stored question (section 8.3).
- **Re-asking a fact because of its age** (section 8.1).
- **A separate answer bank** beside the fact sheet (section 8.1).

## Decision

Every value about a user is typed by the `answer` tool from that user's knowledge hub, with its source recorded. Legal and factual questions accept only fact-sheet entries the user gave, in any wording that matches strictly, or a derivation those entries settle for certain, recorded with its source; a generated value is never accepted for them. No answer waits for confirmation. If no source exists the tool returns `MISSING`, `submit` is refused in code, and the user receives one alert with the exact question; the answer is stored with its scope ("just this job" or "every job", the default), written before any waiting application resumes, and releases every application waiting on it. An option is chosen for a stored fact only when exactly one option matches it.

### Rejected alternatives

- **A confirmation step**: "No confirmation steps (HANDOFF.md:29). A fact the user has entered is used as entered, on every form that asks for it, until the user changes it. The cost of that choice, stated plainly: a fact that has gone out of date ... keeps being used until the user updates it" (section 8.1).
- **ADK's tool confirmation**: "The design does not use it: the owner wants no confirmation steps, and the page still says unsupported" (section 2.6).
- **A generated value for a legal or factual question**: "A generated value is never accepted for them. This is the rule the owner asked for: these answers come from the knowledge hub each user fills, with no confirmation step in between, and the agent never invents one" (section 6.5).
- **Reusing a near-miss wording**: "A near miss is not reused: for a legal or factual question it becomes a missing fact and goes to the user once; for a free-text question a fresh answer is written from evidence" (section 8.3).
- **Re-asking a fact because of its age**: "Nothing is blocked or re-asked because of age"; the daily digest lists facts older than a year, "for information only" (section 8.1).
- **A separate answer bank**: "One fact sheet, no separate answer bank"; the owner, 2026-11-24, found it a duplicate of the fact sheet ("answer bank: how come is this not a fact sheet?") (section 8.1).

## Consequences

Early applications stop often; the rate falls as the hub fills. Each new question is answered once. No guessed value can reach a submitted form through the normal path. A fact that has gone out of date keeps being used until the user changes it, and a wrong match can put a true fact in the wrong field; the agent signs either in the user's name. Free-text answers are generated under the citation rule of ADR-008.
