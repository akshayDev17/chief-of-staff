# ADR-010: each user applies with their own email; the app reads matching mail from that user's Gmail with a read-only token, behind a discard-first gate

Source: [design-v3](../design-v3.md), section 9.6 (decision record ADR-010).

## Status

Accepted (2026-11-24)

## Context

The agent needs one-time codes, verification links, confirmations and LinkedIn's notices, for several users. No Gmail scope is narrower than the whole mailbox. The owner decided that each user applies with the email they set in a dashboard field, that the app owns no address on applications, that Gmail is connected with one button, and that a gate discards everything that is not job mail before it is stored (2026-11-23).

## Considered options

As in design-v3 section 9, which compares the options for this decision; this record does not restate them.

## Decision

Each user sets their application email, offered from the Gmail account they connect at Google and confirmed by them. Connect Gmail stores a `gmail.readonly` token in the user's vault; Disconnect revokes it. The app fetches only mail matching LinkedIn's senders, the applicant-tracking systems on a fixed list in the app's code, companies the user applied to or contacted, and the sites the user's runs worked on, through Gmail's own search; the user keeps no list of senders. A run that hears nothing within a short wait gets one narrower search of its own time window by company or site name before the inbox alert. The Worker's fixed rules pass only such mail with `dmarc=pass`; everything else is discarded unstored with one log line. Passed codes, links and notices wake only that user's waiting runs. The app's own mail goes only to each user's application email, which the app verifies with Cloudflare itself. The Google project stays unverified in v1, in production status. Gmail only in v1.

### Rejected alternatives

The options design-v3 section 9 compares other than the one decided above, for the reasons given there.

## Consequences

The token can technically read the whole mailbox; only the app's search and gate keep it to job mail, and the consent screens say so. Every user sees Google's unverified-app screen, and at most 100 users can connect while unverified. A user whose application email is not Gmail finishes each portal verification by hand. A connection Google ends gives an urgent alert. Portal mail lands in the user's own inbox as well, where the user sees it first.
