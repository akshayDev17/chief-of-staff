# ADR-001: each user connects their own Foundry, Bedrock or Vertex AI account with a "Connect <Provider>" button and hands the app no key; one proxy in the Worker mints short-lived credentials from those grants, prices every call from the app's own price table, enforces the user's budget and keeps the usage ledger; calls go straight to the provider

Source: [design-v3](../design-v3.md), section 1.9 (decision record ADR-001).

## Status

Accepted (2026-11-24)

## Context

The owner wants the models with a different vendor from the rest of the system, to configure an endpoint rather than put a key in code, to see daily and per-job-site usage, and not to depend on Microsoft alone. The app serves the owner and invited friends, each paying for their own model usage. Foundry, Bedrock and Vertex AI each issue their own endpoint and credential and bill the user's own account; none offers a hard spending cap the app can rely on, and none can attribute cost to a per-request tag. The agent runs in a container that must hold no secret.

## Considered options

As in design-v3 section 1, which compares the options for this decision; this record does not restate them.

## Decision

Foundry, Bedrock and Vertex AI are the only providers in v1, for the owner and every friend; there is no direct Anthropic or OpenAI key (T14). Each user connects providers with a "Connect <Provider>" button and picks models on guided screens with automatic test calls: the user grants the app's own identity a narrow, invoke-only permission in their own account, revocable there at any time, and the app turns it into a credential lasting about an hour; no long-lived key is handed over, and connection records hold nothing secret (the owner, 2026-11-24: "why would a user wanna trust my app with their key? why am i being given the key in the first place? ... shouldn't, just like we have a connect gmail, linkedin, also have a connect <provider>? ... basically principles of extendable design: for any new provider just have a new "Connect <Provider>" button?", then "yes go ahead, keep anthropic in v2" and "yes ma'am please fold it"). Each provider is one plug-in (Connect method, caller, price source) behind a shared core that knows no provider. Every call goes through one proxy in the Worker, straight to the user's own provider, which mints the credential, prices it from the app's own price table (filled from the vendors' price sources, with maintainer-read rows where no automatic source exists), refuses it if the user's budget is spent or the model has no price, and writes a D1 ledger row. Each provider's own console and bill are the independent check of the ledger; there is no AI Gateway in v1 (the owner, 2026-11-24: "yes drop it", after asking "why we still need this?"). The per-task picker proposes a main model and a fallback on another provider. A Foundry key covers its whole resource (to be confirmed live, T13).

### Rejected alternatives

The options design-v3 section 1 compares other than the one decided above, for the reasons given there.

## Consequences

No user types a price, and the budget stop always counts at least what the vendor can charge. A friend's setup includes a cloud account with a payment method, which is an accepted cost (the owner, 2026-11-23). The owner keeps a live account at all three providers so that every guide is walked live. Foundry's Claude prices depend on a weekly maintainer reading of the Marketplace listings. No connection expires on a date; a revoked grant stops that provider at once and raises the urgent alert. Direct Anthropic and OpenAI are a v2 requirement, as pasted-key plug-ins with dedicated, spend-limited keys (section 15.6).
