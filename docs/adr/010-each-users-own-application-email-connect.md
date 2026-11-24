# ADR-010: each user applies with their own email; the app reads matching mail from that user's Gmail with a read-only token, behind a discard-first gate

Source: [design-v3](../design-v3.md), section 9.6 (decision record ADR-010).

## Status

Accepted (2026-11-24)

## Context

The agent needs one-time codes, verification links, confirmations and LinkedIn's notices, for several users. No Gmail scope is narrower than the whole mailbox. The owner decided that each user applies with the email they set in a dashboard field, that the app owns no address on applications, that Gmail is connected with one button, and that a gate discards everything that is not job mail before it is stored (2026-11-23).

## Considered options

design-v3 compares no alternatives for this decision. Its text names these, in sections 9.2, 9.3, 9.6, 15.1 (decision 7) and 15.6:

- **A dedicated address on the owner's domain, copied to the inbox**, on every application (section 15.1, decision 7).
- **A separate alert email** for the app's own mail (section 9.2).
- **A list of senders the user keeps** (section 9.3).
- **A Gmail scope narrower than the whole mailbox** (section 9.3).
- **Google verification of the Connect Gmail app in v1** (sections 9.3 and 15.6).
- **The Google project left in "Testing" status** (section 9.3).
- **An application email that is not Gmail, in v1** (sections 9.6 and 15.6).

## Decision

Each user sets their application email, offered from the Gmail account they connect at Google and confirmed by them. Connect Gmail stores a `gmail.readonly` token in the user's vault; Disconnect revokes it. The app fetches only mail matching LinkedIn's senders, the applicant-tracking systems on a fixed list in the app's code, companies the user applied to or contacted, and the sites the user's runs worked on, through Gmail's own search; the user keeps no list of senders. A run that hears nothing within a short wait gets one narrower search of its own time window by company or site name before the inbox alert. The Worker's fixed rules pass only such mail with `dmarc=pass`; everything else is discarded unstored with one log line. Passed codes, links and notices wake only that user's waiting runs. The app's own mail goes only to each user's application email, which the app verifies with Cloudflare itself. The Google project stays unverified in v1, in production status. Gmail only in v1.

### Rejected alternatives

- **A dedicated address on the owner's domain**: "Approved as recommended on 2026-11-21 (a dedicated address on the owner's domain, copied to the inbox); the owner's decision of 2026-11-23 replaces it: each user's own application email, set in a dashboard field, with no app-owned address on applications (C13)" (section 15.1).
- **A separate alert email**: "there is no separate alert email (the owner, 2026-11-24: "drop the step entirely because why shouldnt the application email be used? ...")" (section 9.2).
- **A list of senders the user keeps**: "The sources are automatic and the user keeps no list of senders on any screen (the owner, 2026-11-23)" (section 9.3).
- **A narrower Gmail scope**: not available. "No Gmail scope is limited to a sender, a label or a search. So **the stored token can technically read the whole mailbox**; only the app's own search and gate keep it to job mail" (section 9.3).
- **Google verification in v1**: it requires "an annual security assessment from an independent, third-party assessor that is approved by Google", and "can potentially take several weeks"; "v1 does not seek it; it is a v2 item" (the owner, 2026-11-23: "skip it for v1, but document it as a v2 item") (sections 9.3 and 15.6).
- **"Testing" status**: a project in it "is issued a refresh token expiring in 7 days", so "the Google project is set to production, not Testing (T39)" (section 9.3).
- **An application email that is not Gmail**: "v1 supports Gmail only; anything else is a v2 requirement" (section 9.6), with the points for designing it in section 15.6.

## Consequences

The token can technically read the whole mailbox; only the app's search and gate keep it to job mail, and the consent screens say so. Every user sees Google's unverified-app screen, and at most 100 users can connect while unverified. A user whose application email is not Gmail finishes each portal verification by hand. A connection Google ends gives an urgent alert. Portal mail lands in the user's own inbox as well, where the user sees it first.
