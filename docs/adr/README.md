# Decision records

The decision records of [design-v3](../design-v3.md), one file each, in the template of the course's `ADR_structure.md`: status, context, considered options, decision, rejected alternatives, consequences. Context, decision and consequences are the design's own wording. The considered options and rejected alternatives are taken from the design's comparison tables, and from the alternatives its text names, with the reasons it gives, in the sections each record cites; where the design compares no alternatives for a decision, the record says so and lists only those its text names.

| Record | Subject | Design section |
| --- | --- | --- |
| [ADR-001](001-models-three-providers-registered-per-user.md) | Models: three providers, registered per user, connected with no key held, one proxy with the app's own price table | 1.9 |
| [ADR-002](002-adk-in-python-in-cloudflare-containers.md) | ADK in Python in Cloudflare Containers, inside a Worker shell, one `Chief` per user | 2.7 |
| [ADR-003](003-browser-run-reads-chrome-in-a.md) | Browser Run reads; Chrome in a container acts, through NodeMaven residential proxies, each user's own sessions | 3.7 |
| [ADR-004](004-linkedin-one-browser-per-user-fixed.md) | LinkedIn: one browser per user, fixed scripts, page budget; the user signs in, no password stored | 4.10 |
| [ADR-005](005-linkedin-is-the-only-source-of.md) | LinkedIn is the only source of roles | 5.7 |
| [ADR-006](006-one-application-per-role-group-unique.md) | One application per role group, unique index and two-step submit | 5.7 |
| [ADR-007](007-answers-only-from-the-users-hub.md) | Answers only from the user's hub; a missing fact raises an alert once | 6.10 |
| [ADR-008](008-generated-text-cites-evidence-and-passes.md) | Generated text cites evidence and passes an independent check | 7.3 |
| [ADR-009](009-private-data-only-in-the-owners.md) | Private data only in the owner's Cloudflare account, separated per user | 8.6 |
| [ADR-010](010-each-users-own-application-email-connect.md) | Each user's own application email; Connect Gmail read-only; discard-first gate | 9.6 |
| [ADR-011](011-the-dashboard-own-screens-and-api.md) | The dashboard: own screens and API, per user, installable, behind the site's sign-in | 10.7 |
| [ADR-012](012-every-wait-is-a-long-running.md) | Every wait is a long-running tool call; effects recorded first | 2.7 |
| [ADR-013](013-personality-style-answers-from-a-presentation.md) | Personality-style answers from a presentation profile, with an item ledger | 8.6 |
| [ADR-014](014-multi-user-invite-only-two-tiers.md) | Multi-user, invite-only, two tiers, per-user objects, a meter on every account | 11.10 |
| [ADR-015](015-keeping-each-linkedin-account-safe-signals.md) | Keeping each LinkedIn account safe: signals, stop rule, learning record | 4.3 |
| [ADR-016](016-no-captcha-solved-in-v1.md) | No captcha solved in v1 | 3.7 |
| [ADR-017](017-components-and-their-release-units-each.md) | Components and their release units, each stated where it is designed | 2.7 |
