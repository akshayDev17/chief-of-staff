# ADR-015: keeping each LinkedIn account safe is a designed system, with signals, a stop rule and a learning record, per account

Source: [design-v3](../design-v3.md), section 4.3 (decision record ADR-015).

## Status

Accepted (2026-11-24)

## Context

LinkedIn is the only job source and the place of Easy Apply and referrals; automation breaches its User Agreement and can restrict the account. LinkedIn publishes no limits, and a challenge must never be provoked to learn its behaviour. The owner asked that the account risk be treated as a system design problem and a learning experience. Several users each drive their own account.

## Considered options

design-v3 compares the options in the table "Options considered and not used" at the end of section 4.3, the section that designs account safety. They are other ways of doing a user's LinkedIn work; the same table is recorded in ADR-004.

- **Each account's own controls, signals, stop rule and learning record** (decided; section 4.3).
- **Cloudflare Browser Run for LinkedIn** (section 4.3).
- **Reading LinkedIn's public job pages without signing in** (section 4.3).
- **A hosted LinkedIn API vendor such as Unipile** (section 4.3).
- **A second LinkedIn account for the agent** (section 4.3).
- **LinkedIn Premium** (section 4.3).
- **LinkedIn's official data-portability interface, for reading only** (section 4.3).
- **Provoking a challenge to learn LinkedIn's behaviour** (section 4.3).

## Decision

Each account has its own controls (alert and notification mail does the reading; one steady profile, from Residential addresses in the user's own place; a few short sittings within the user's waking hours; one daily page budget and a cap per action, as ceilings for base users; fixed scripts; no stored password; high acceptance; practice mode first). Every sitting records its signals. Any challenge stops that account's LinkedIn work before the next page load, with the stop alert and a stop record, under decision 9's stop rule. A learning record keeps what each sitting taught, the exit address used and what preceded each challenge, and is summarised at every gate from M4 on.

### Rejected alternatives

- **Cloudflare Browser Run for LinkedIn**: "Every request carries a signature proving it is an automated Cloudflare browser (section 3.1)" (section 4.3).
- **Reading LinkedIn's public job pages without signing in**: "LinkedIn's `robots.txt` opens: "The use of robots or other automated means to access LinkedIn without the express permission of LinkedIn is strictly prohibited", and disallows everything for any crawler it has not named. It would also not remove the need to sign in to apply" (section 4.3).
- **A hosted LinkedIn API vendor such as Unipile**: "It "operates through reverse engineering", needs the user's password or session cookie, and costs a 49 EUR monthly minimum. Handing over credentials is itself a Don't ("sharing log-in credentials or copying cookies")" (section 4.3).
- **A second LinkedIn account for the agent**: ""Create a false identity" is the first Don't; it also defeats the purpose, since applications and referrals depend on the user's real profile" (section 4.3).
- **LinkedIn Premium**: "Declined by the owner (decision 10). Outreach is built for a free account's limits (section 4.8)" (section 4.3).
- **LinkedIn's official data-portability interface, for reading only**: "Open only to members whose profile location is in the EU, the EEA or Switzerland. Raised with T67 only if the owner wants that route (A6)" (section 4.3).
- **Provoking a challenge**: "A challenge must never be provoked to see what happens: provoking a real challenge harms the account. So the stop path cannot be tested on purpose, and stays **not proven live** per account until LinkedIn really shows a challenge (M4)" (section 4.3).

## Consequences

The risk is lowered and measured, not removed. Throughput is bounded by the page budget and by one-at-a-time use of each browser. The halt path stays not proven live per account until a real challenge occurs. Caps fall on evidence and rise only by the owner's decision (or, for a base user, never above the ceilings).
