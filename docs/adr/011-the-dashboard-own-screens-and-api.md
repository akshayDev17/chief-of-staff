# ADR-011: the dashboard is this app's own screens and API, per user, installable on the phone with push alerts, behind the site's sign-in, with Cloudflare Access allowing only the owner until that sign-in exists

Source: [design-v3](../design-v3.md), section 10.7 (decision record ADR-011).

## Status

Accepted (2026-11-24)

## Context

Each user wants a dashboard on the portfolio site and alerts on their phone, answered from it, whenever the agent cannot proceed. The site's route and sign-in belong to another team, whose current design for this route is not known. The dashboard exposes personal data and can trigger submissions and messages. There is no sign-up page; people enter only by invite. On an iPhone, web push works only for a site added to the Home Screen, opened as its own page, and notifications there carry no reply buttons.

## Considered options

design-v3 compares the routes for phone alerts in the table in section 10.5; section 15.6 names a later route.

- **Installable dashboard + Web Push** (decided; section 10.5).
- **A Telegram bot** (section 10.5).
- **Pushover or ntfy** (section 10.5).
- **Text messages** (section 10.5).
- **A native app** (section 10.5).
- **App Store wrappers around the same sites** (section 15.6).

## Decision

This app ships the dashboard screens, a web app manifest, a service worker and a single API from its own Worker. Until the site's sign-in exists, one Cloudflare Access rule in front of the whole app admits only the owner's email. The site is asked for a route at one fixed address, served as a page of its own, a sign-in for invited people only that works and lasts inside an installed phone app, a signed identity token on every request, and the R1 to R10 requirements, including Sign in with Google beside emailed codes. The API verifies the token on every call and WebSocket upgrade, maps it to a user record and refuses anyone without one. Every screen is per user; the admin screens are the owner's only. Alerts are sent by the Worker as Web Push, in the declarative form where the phone supports it, each naming the company, the stage and what is needed and opening the matching screen; undelivered or unopened urgent alerts fall back to email. Everything that expires or can be cut off follows one rule of advance alert, urgent alert, one tap to fix, and a digest line.

### Rejected alternatives

- **A Telegram bot**: "Works, including typed replies, but every alert's text (company, question, sometimes a code) would pass through and rest on Telegram's servers, and the reply screen could not show the remote browser view" (section 10.5).
- **Pushover or ntfy**: "Notification only; the reply would still need the dashboard, so they add an app and remove nothing. ntfy's own pages describe delayed delivery on iPhone unless its central server is used" (section 10.5).
- **Text messages**: "Costs money, needs a sender registration, and a text cannot carry the remote view" (section 10.5).
- **A native app**: "A second codebase and a yearly fee, to gain reply buttons on the notification itself" (section 10.5).
- **App Store wrappers**: a v2 requirement, not v1: it "needs an Apple Developer account at $99 a year, announced before anything is set up, and Apple's app review for each app" (the owner, 2026-11-24: "v1: androind behaves as i want, apple fuck apple. yes, agreed with the v2 item as well") (section 15.6).

## Consequences

The site team's work is routing and sign-in for invited people. No app store, no fee and no second codebase. Every user must install the dashboard on a phone and allow notifications. On an iPhone every reply needs a tap into the app. A change in the site's token format or session length breaks access or makes alerts open a sign-in page. Two layers must fail before anyone uninvited can reach the controls.
