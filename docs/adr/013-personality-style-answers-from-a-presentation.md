# ADR-013: personality-style questions are answered from a stored presentation profile, with an item ledger for consistency

Source: [design-v3](../design-v3.md), section 8.6 (decision record ADR-013).

## Status

Accepted (2026-11-24)

## Context

Application forms include rating-scale and personality-style questions. The owner decided that the agent answers them to present the candidate well, that no such question waits for the user, and that answers must be consistent across forms. Questionnaires of this kind can score inconsistent or over-favourable answering.

## Considered options

design-v3 compares no alternatives for this decision. Its text names these, in sections 8.5 and 8.6:

- **Fine-tuning a model** on the user's data (section 8.5).
- **A trait baseline measured from the user** (sections 8.5 and 8.6).
- **The model choosing a rating-scale answer** (section 8.5).
- **A profile at the top of every scale** (section 8.5).
- **A stories section or questionnaire for the user** (section 8.5).

## Decision

A presentation profile per role family is stored in the knowledge hub. For a rating-scale item the persona sub-agent only classifies the item (trait and direction); the answer is computed in code from the profile. Every answered item is recorded in an item ledger and looked up before any new answer is computed. Reverse-worded items are mirrored by rule, implausible-virtue items get a moderate answer, and a within-form check blocks contradictions before submit. Open questions use only real events from the hub, under the citation rule, with outlook written to agree with the profile. Anything timed, recorded, proctored, ability-based or hosted by an assessment company is not attempted and goes to the user as a stop alert.

### Rejected alternatives

- **Fine-tuning a model**: the persona sub-agent "is "tuned" by instruction and stored data, not by training a model: fine-tuning on this little data would add cost and a second model to maintain for no measurable gain" (section 8.5).
- **A measured trait baseline**: "These are answered from a **presentation profile**, not from a measurement of the user. No trait baseline is asked for" (section 8.5); the user is never asked "to supply a personality baseline" (section 8.6), since the owner decided "that no such question waits for the user (HANDOFF.md:28)" (section 8.5).
- **The model choosing the answer**: "The sub-agent's only judgement is to classify the item ... The answer is then **computed in code** from the profile score and the scale on the form. The model does not choose the answer" (section 8.5).
- **The top of every scale**: "a few traits are deliberately moderate, because a candidate who claims the top of every scale is the pattern such questionnaires are built to notice" (section 8.5).
- **A stories section or questionnaire**: "No stories section or questionnaire (the owner, 2026-11-24: "remove stories, ask the hub, and writing style. all of them are unnecessarly slop")" (section 8.5).

## Consequences

No personality-style question interrupts the user. Answers are consistent by construction. They describe a chosen presentation, not the user, and the user may be asked about them; every answer is on the fact sheet, marked "personality question", with Edit and Delete, and the presentation profile stays internal. A questionnaire that detects the pattern may count it against the candidate. The public repository shows that this is done.
