# ADR-008: generated text about the user must cite knowledge-hub evidence and pass an independent check

Source: [design-v3](../design-v3.md), section 7.3 (decision record ADR-008).

## Status

Accepted (2026-11-24)

## Context

Cover letters, free-text answers and referral messages are sent without review. Language models readily add plausible but false experience, numbers and enthusiasm.

## Considered options

design-v3 compares no alternatives for this decision. Its text names these, in section 7:

- **A writer that sees the whole knowledge hub or the open web** (section 7.3).
- **Softening unsupported content** instead of deleting it (section 7.3).
- **Company praise with no source** (section 7.3).
- **Web search for company research** (section 7.1).
- **Sending the user's own default cover letter as it is** (section 7).

## Decision

Any generated text that makes a statement about the user or a company is produced with a claims table mapping each sentence to a knowledge-hub evidence id or a fetched source URL. A separate model call verifies each sentence against its support, and a rule-based check requires names, numbers and dates to appear verbatim in the cited evidence. Failing sentences are rewritten once and then removed. Text left with too little supported content is not sent.

### Rejected alternatives

- **A writer that sees the whole hub or the open web**: "The writer cannot see anything it could embellish from. It receives selected evidence items, not the whole hub and not the open web" (section 7.3).
- **Softening unsupported content**: "Unsupported content is deleted, not softened. The system prefers a short true letter to a long impressive one" (section 7.3).
- **Company praise with no source**: "Praise with no source ("your world-class team") is rejected by rule" (section 7.3).
- **Web search**: "No web search is used: LinkedIn is the only job source, so no company-discovery search is needed" (section 7.1).
- **Sending the default cover letter as it is**: it "is source material only: for their voice (section 4.5) and for their own claims ... It is never sent as it is"; "Every letter, optional or required, is written fresh and tailored to the company being applied to" (section 7).

## Consequences

Letters are shorter and plainer than unconstrained output. Each letter costs two extra model calls. Every sentence in every sent document can be traced to its source from the dashboard. What the user has not put in the knowledge hub cannot appear in a letter, so the hub's completeness limits the letters' quality.
