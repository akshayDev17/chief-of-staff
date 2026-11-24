# ADR-015: keeping each LinkedIn account safe is a designed system, with signals, a stop rule and a learning record, per account

Source: [design-v3](../design-v3.md), section 4.3 (decision record ADR-015).

## Status

Accepted (2026-11-24)

## Context

LinkedIn is the only job source and the place of Easy Apply and referrals; automation breaches its User Agreement and can restrict the account. LinkedIn publishes no limits, and a challenge must never be provoked to learn its behaviour. The owner asked that the account risk be treated as a system design problem and a learning experience. Several users each drive their own account.

## Considered options

As in design-v3 section 4, which compares the options for this decision; this record does not restate them.

## Decision

Each account has its own controls (alert and notification mail does the reading; one steady profile, from Residential addresses in the user's own place; a few short sittings within the user's waking hours; one daily page budget and a cap per action, as ceilings for base users; fixed scripts; no stored password; high acceptance; practice mode first). Every sitting records its signals. Any challenge stops that account's LinkedIn work before the next page load, with the stop alert and a stop record, under decision 9's stop rule. A learning record keeps what each sitting taught, the exit address used and what preceded each challenge, and is summarised at every gate from M4 on.

### Rejected alternatives

The options design-v3 section 4 compares other than the one decided above, for the reasons given there.

## Consequences

The risk is lowered and measured, not removed. Throughput is bounded by the page budget and by one-at-a-time use of each browser. The halt path stays not proven live per account until a real challenge occurs. Caps fall on evidence and rise only by the owner's decision (or, for a base user, never above the ceilings).
