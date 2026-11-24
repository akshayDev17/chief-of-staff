# ADR-013: personality-style questions are answered from a stored presentation profile, with an item ledger for consistency

Source: [design-v3](../design-v3.md), section 8.6 (decision record ADR-013).

## Status

Accepted (2026-11-24)

## Context

Application forms include rating-scale and personality-style questions. The owner decided that the agent answers them to present the candidate well, that no such question waits for the user, and that answers must be consistent across forms. Questionnaires of this kind can score inconsistent or over-favourable answering.

## Considered options

As in design-v3 section 8, which compares the options for this decision; this record does not restate them.

## Decision

A presentation profile per role family is stored in the knowledge hub. For a rating-scale item the persona sub-agent only classifies the item (trait and direction); the answer is computed in code from the profile. Every answered item is recorded in an item ledger and looked up before any new answer is computed. Reverse-worded items are mirrored by rule, implausible-virtue items get a moderate answer, and a within-form check blocks contradictions before submit. Open questions use only real events from the hub, under the citation rule, with outlook written to agree with the profile. Anything timed, recorded, proctored, ability-based or hosted by an assessment company is not attempted and goes to the user as a stop alert.

### Rejected alternatives

The options design-v3 section 8 compares other than the one decided above, for the reasons given there.

## Consequences

No personality-style question interrupts the user. Answers are consistent by construction. They describe a chosen presentation, not the user, and the user may be asked about them; every answer is on the fact sheet, marked "personality question", with Edit and Delete, and the presentation profile stays internal. A questionnaire that detects the pattern may count it against the candidate. The public repository shows that this is done.
