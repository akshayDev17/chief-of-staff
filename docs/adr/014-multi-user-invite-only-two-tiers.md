# ADR-014: the app is multi-user and invite-only, with an owner tier and a base tier, per-user objects and data, and one cost meter on every account

Source: [design-v3](../design-v3.md), section 11.10 (decision record ADR-014).

## Status

Accepted (2026-11-24)

## Context

The owner wants to share the app with a small circle of friends, each with their own LinkedIn account, model provider and job search. The owner pays the container time; Cloudflare cannot cap container spending. Friends must never see each other's data, and the owner must not have to manage a guest list by hand. There is no sign-up page.

## Considered options

As in design-v3 section 11, which compares the options for this decision; this record does not restate them.

## Decision

Two tiers: the owner, with no tier caps; and base users, invited by the owner, who bring their own model provider; their browsers go out through NodeMaven residential proxies on the owner's plan, with their own sticky sessions in their own city or country, never sharing an address (section 3.4). Entry is only by an invite bound to the invited email, through the site's sign-in, with the guest list kept by a separate Access-list Worker reachable only through a service binding. Each user has their own `Chief`, `Run` objects, D1 rows, R2 prefix and key, and vault. Every account has an owner-cost meter; each base user has a daily owner-cost cap, the base tier a monthly ceiling, one run at a time, and LinkedIn ceilings they may lower and never raise. Every owner number is set in Admin · Owner settings. A friend switches their own work on after setup, with no owner go; the owner is told the first time a friend goes live on applications. Pause and remove follow tier report D6, with a removal email, a notice page and an export until the grace period ends.

### Rejected alternatives

The options design-v3 section 11 compares other than the one decided above, for the reasons given there.

## Consequences

One deployment serves several people, and the owner can in principle read everyone's data, which the consent page says. Each friend's setup is long (about 43 steps to the first sitting) and includes a cloud account, accepted by the owner as a real cost. The Access token's reach is account-wide even though only one small Worker can use it. The user cap is at most 100 while the Connect Gmail app is unverified. Base-tier behaviour is checked only on the owner's base account, which is not a different person's experience.
