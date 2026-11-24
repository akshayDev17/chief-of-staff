# ADR-016: no employer job-site captcha is solved in v1; it stops the application with a push alert and an email. A LinkedIn security check is solved by the user in the remote view

Source: [design-v3](../design-v3.md), section 3.7 (decision record ADR-016).

## Status

Accepted (2026-11-24)

## Context

Portals show captchas, many of them score-based. The owner left captcha-solving open (decision 12), then decided for v1 that captchas stay unsolved and that the user gets an email as well as the push alert (the owner, 2026-11-23), and later made clear that this covers employer job sites only, and that a LinkedIn captcha is solved by the user in the remote view (the owner, 2026-11-24). A captcha-solving service is not approved (standing rule 6).

## Considered options

design-v3 compares no alternatives for this decision in a table; section 3.6 names them, and section 15.6 holds the one chosen for v2.

- **The agent solving the captcha** (section 3.6).
- **A captcha-solving service** (section 3.6).
- **The user solving only the captcha in the remote view, with the filled form held open** (sections 3.6 and 15.6).
- **Stopping the application with a push alert and an email, to finish by hand** (decided; section 3.6).

## Decision

No captcha on an employer's job site is solved in v1, by the agent, by a service, or by the user through the remote view. A portal captcha stops the application at once with nothing typed into it; the user gets the stop alert by push and by email, naming the company, the role, "captcha", the job link and the portal account's sign-in address, with the prepared-answers page linked; the stop page holds everything needed to finish by hand, including the portal password, shown only there. A stop record is written. A LinkedIn security check or captcha stops all of that user's LinkedIn work until the user solves it in the remote view; then LinkedIn pauses for a day and restarts at the lowest caps (decision 9, L19).

### Rejected alternatives

- **The agent or a captcha-solving service solving it**: "Score-based checks such as Greenhouse's invisible reCAPTCHA judge the whole session, not one puzzle; a 2026 study found solver services "largely defeat challenge-based defenses with a 100% success rate, but collapse to an average 23% success rate on reCaptcha v3". A solving service is a further vendor and a clearer breach of portals' intent" (section 3.6). A captcha-solving service is not approved (standing rule 6).
- **The user solving only the captcha in the remote view**: not in v1 (the owner, 2026-11-23: "lets for now v1 sake agree captcha will remain unsolved and lets do an email notification here as well"); it is "The v2 requirement the owner chose" (sections 3.6 and 15.6).

## Consequences

Every captcha means finishing that application by hand, which on a portal is many actions, often on a phone. If no real captcha appears in M13, the captcha stop stays "not proven live" (closing item 1). The stop records give the evidence for the v2 design, in which the user solves only the captcha with the form held open.
