# ADR-006: one application per role group, guarded by a unique index and a two-step submit

Source: [design-v3](../design-v3.md), section 5.7 (decision record ADR-006).

## Status

Accepted (2026-11-24)

## Context

Applications are submitted without review, runs can stop at any point and are resumed at-least-once, and the same role appears under several job numbers. A duplicate application harms the user, and an Easy Apply application cannot be withdrawn.

## Considered options

design-v3 compares no alternatives for this decision: sections 5.4 and 5.5 list the guards it uses, all of them together. The only alternative its text names is retrying a submit whose outcome was never confirmed (section 5.5).

## Decision

Jobs are grouped into role groups; the applications table has a unique index on the role group. The submit click is bracketed by two durable writes ("submitting", then "submitted" with the confirmation). A run that finds "submitting" without "submitted" never clicks again; it looks for LinkedIn's applied mark, a confirmation email or a portal notice, and otherwise reports the application as unconfirmed for the user. LinkedIn's own list of applied jobs is compared with the app's records weekly. Caps are enforced by the user's `Chief`. A confirmation mail the agent did not cause marks the job "applied by you", and the stop page's "I finished it" marks it "finished by you"; the duplicate guard never applies to either again.

### Rejected alternatives

- **Retrying an unconfirmed submit automatically**: "If neither appears, the application is shown to the user as *submitted, unconfirmed* and is never retried automatically. A missed application is recoverable; a duplicate is not, and LinkedIn says a submitted Easy Apply application cannot be edited or withdrawn" (section 5.5).

## Consequences

A crash can at worst leave one application unconfirmed, never doubled. Some genuine variants of a role are skipped unless the user asks otherwise. Confirmation of portal applications depends on the user's Gmail connection (section 9).
