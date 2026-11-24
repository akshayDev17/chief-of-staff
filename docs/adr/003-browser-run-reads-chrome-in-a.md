# ADR-003: Browser Run reads; a Chrome in a Cloudflare Container acts as the user, through residential proxies (NodeMaven, each user's own sessions in their own place)

Source: [design-v3](../design-v3.md), section 3.7 (decision record ADR-003).

## Status

Accepted (2026-11-24)

## Context

The agent must browse from Cloudflare. Cloudflare Browser Run signs every request as a bot with headers that cannot be removed, uses Cloudflare addresses only, and keeps no sign-in state between sessions. Applicant-tracking systems score data-centre addresses, device signals and automation; LinkedIn challenges unfamiliar devices and locations. Hosted-browser vendors would hold users' sessions outside Cloudflare.

## Considered options

design-v3 compares the options in section 3.3 (a reader and an actor), section 3.4 (where the actor browser's traffic comes from) and section 3.7 (hosted browser companies); sections 3.1 and 3.3 name the parts of Browser Run that are not used.

- **Browser Run for everything, including acting as the user** (sections 3.1 and 3.3).
- **Two browsers split by purpose**: Browser Run reads, a Chrome in a Cloudflare Container acts (decided; section 3.3).
- **Browser Run's built-in "Human in the Loop" handoff** (section 3.1).
- **Stagehand** with Browser Run (section 3.1).
- **Cloudflare's "Kitesurf" engine** (section 3.1).
- **Network exit** (section 3.4): A. Cloudflare's own addresses; B. a rented residential address in the user's own city or country, NodeMaven residential proxies (decided); C. the user's home connection, through a small always-on device at home.
- **A hosted browser company** (section 3.7): Browserbase; others (Steel, Hyperbrowser, Browserless, Anchor, Kernel).

## Decision

Browsing is split by purpose. Browser Run reads public pages and renders documents; no form is filled on it and it never opens LinkedIn. A stock Chrome in a Cloudflare Container, driven by Playwright in the same process as the agent runtime, with the user's own locale and time zone, performs every action taken as a user. Each user has one LinkedIn browser with one dedicated profile, used by one run at a time, and a separate browser per employer-portal application; the two never share cookies. Every LinkedIn and portal browser goes out through NodeMaven residential proxies, a sticky session per LinkedIn sitting and per portal application in the user's own city or country, checked before every start, with no fallback to Cloudflare's addresses, for every user from the first LinkedIn sign-in (decision 3). The remote view serves the user's own LinkedIn sign-in. No captcha is solved in v1 (ADR-016).

### Rejected alternatives

- **Browser Run as the browser that acts as the user**: "Browser Run is an honest crawler. That is right for reading job descriptions and company pages, and wrong for acting as a person: a site that checks the signature knows with certainty that a Cloudflare automation is filling its form. So no form is ever filled on Browser Run" (section 3.1).
- **Browser Run's built-in handoff**: "its built-in handoff is not used", for the same reason (section 3.1).
- **Stagehand**: "Supported only at `v2.5.x`; "Stagehand `v3` and later are not supported". Stagehand is at 4.x, so the pairing is stale and is not used" (section 3.1).
- **Kitesurf**: "out of scope: it cannot yet "Negotiate a bot-challenge handshake" or "Start a long-running, authenticated session"" (section 3.1).
- **A. Cloudflare's own addresses**: "The signal Greenhouse lists as high-risk and the kind of location LinkedIn challenges. **Not used** for any user's LinkedIn or portal browser" (section 3.4).
- **C. The user's home connection**: not rejected; "**The fallback**, as its own owner decision, if LinkedIn or the portals still challenge or block the browser through option B (proofs 3 and 4)" (section 3.4).
- **A hosted browser company**: "Declined by the owner (decision 14). It would move users' signed-in sessions to another company and depart from "runs on Cloudflare" for the part that matters most. It comes back only as its own decision, if proof 3 or 4 fails (M4, M5 fallbacks)" (section 3.7).

## Consequences

The system stays on Cloudflare. The container browser, its sign-in storage and its remote view are proven live in M4. How sites score this browser through the residential proxies is measured in M4 and M5; their fallback is the user's home connection through a small device, or a hosted browser company, each as the owner's decision. Some applications will stop on challenges; the completion rate is measured and shown. LinkedIn work is strictly one thing at a time per user. Each user pays for their own residential address, about $10 a month.
