# ADR-003: Browser Run reads; a Chrome in a Cloudflare Container acts as the user, through residential proxies (NodeMaven, each user's own sessions in their own place)

Source: [design-v3](../design-v3.md), section 3.7 (decision record ADR-003).

## Status

Accepted (2026-11-24)

## Context

The agent must browse from Cloudflare. Cloudflare Browser Run signs every request as a bot with headers that cannot be removed, uses Cloudflare addresses only, and keeps no sign-in state between sessions. Applicant-tracking systems score data-centre addresses, device signals and automation; LinkedIn challenges unfamiliar devices and locations. Hosted-browser vendors would hold users' sessions outside Cloudflare.

## Considered options

As in design-v3 section 3, which compares the options for this decision; this record does not restate them.

## Decision

Browsing is split by purpose. Browser Run reads public pages and renders documents; no form is filled on it and it never opens LinkedIn. A stock Chrome in a Cloudflare Container, driven by Playwright in the same process as the agent runtime, with the user's own locale and time zone, performs every action taken as a user. Each user has one LinkedIn browser with one dedicated profile, used by one run at a time, and a separate browser per employer-portal application; the two never share cookies. Every LinkedIn and portal browser goes out through NodeMaven residential proxies, a sticky session per LinkedIn sitting and per portal application in the user's own city or country, checked before every start, with no fallback to Cloudflare's addresses, for every user from the first LinkedIn sign-in (decision 3). The remote view serves the user's own LinkedIn sign-in. No captcha is solved in v1 (ADR-016).

### Rejected alternatives

The options design-v3 section 3 compares other than the one decided above, for the reasons given there.

## Consequences

The system stays on Cloudflare. The container browser, its sign-in storage and its remote view are proven live in M4. How sites score this browser through the residential proxies is measured in M4 and M5; their fallback is the user's home connection through a small device, or a hosted browser company, each as the owner's decision. Some applications will stop on challenges; the completion rate is measured and shown. LinkedIn work is strictly one thing at a time per user. Each user pays for their own residential address, about $10 a month.
