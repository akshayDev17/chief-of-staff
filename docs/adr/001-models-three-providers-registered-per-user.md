# ADR-001: each user connects their own Foundry, Bedrock or Vertex AI account with a "Connect <Provider>" button and hands the app no key; one proxy in the Worker mints short-lived credentials from those grants, prices every call from the app's own price table, enforces the user's budget and keeps the usage ledger; calls go straight to the provider

Source: [design-v3](../design-v3.md), section 1.9 (decision record ADR-001).

## Status

Accepted (2026-11-24)

## Context

The owner wants the models with a different vendor from the rest of the system, to configure an endpoint rather than put a key in code, to see daily and per-job-site usage, and not to depend on Microsoft alone. The app serves the owner and invited friends, each paying for their own model usage. Foundry, Bedrock and Vertex AI each issue their own endpoint and credential and bill the user's own account; none offers a hard spending cap the app can rely on, and none can attribute cost to a per-request tag. The agent runs in a container that must hold no secret.

## Considered options

design-v3 section 1.4 compares what could sit in front of the providers; sections 1.6, 15.1 (open point 1) and 15.6 name the alternatives for how a provider is connected and which providers are offered.

- **One proxy in this app's Worker, with a per-user vault** (decided): "the only code that holds a provider credential, so the container never holds one" (section 1.4).
- **Cloudflare AI Gateway** as a pass-through in front of the providers (section 1.4).
- **Nothing in front of the providers** (section 1.4).
- **A provider's own API gateway product** (section 1.4).
- **LiteLLM as a proxy server** (section 1.4).
- **A "Connect <Provider>" grant to the app's own identity** (decided) **or a long-lived key the user hands the app** (sections 1.4 and 1.6).
- **Google OAuth with the `cloud-platform` scope**, for connecting Vertex AI (section 1.6).
- **Direct Anthropic and OpenAI keys** (sections 1 and 15.6).
- **Other suppliers on the T14 shortlist**: IBM watsonx, Oracle OCI Generative AI, Alibaba Model Studio, and Cloudflare's own AI services (section 15.1, open point 1).

## Decision

Foundry, Bedrock and Vertex AI are the only providers in v1, for the owner and every friend; there is no direct Anthropic or OpenAI key (T14). Each user connects providers with a "Connect <Provider>" button and picks models on guided screens with automatic test calls: the user grants the app's own identity a narrow, invoke-only permission in their own account, revocable there at any time, and the app turns it into a credential lasting about an hour; no long-lived key is handed over, and connection records hold nothing secret (the owner, 2026-11-24: "why would a user wanna trust my app with their key? why am i being given the key in the first place? ... shouldn't, just like we have a connect gmail, linkedin, also have a connect <provider>? ... basically principles of extendable design: for any new provider just have a new "Connect <Provider>" button?", then "yes go ahead, keep anthropic in v2" and "yes ma'am please fold it"). Each provider is one plug-in (Connect method, caller, price source) behind a shared core that knows no provider. Every call goes through one proxy in the Worker, straight to the user's own provider, which mints the credential, prices it from the app's own price table (filled from the vendors' price sources, with maintainer-read rows where no automatic source exists), refuses it if the user's budget is spent or the model has no price, and writes a D1 ledger row. Each provider's own console and bill are the independent check of the ledger; there is no AI Gateway in v1 (the owner, 2026-11-24: "yes drop it", after asking "why we still need this?"). The per-task picker proposes a main model and a fallback on another provider. A Foundry key covers its whole resource (to be confirmed live, T13).

### Rejected alternatives

- **Cloudflare AI Gateway**: "a second count of calls the app does not need: the ledger is the app's count, and each provider's own console and bill are the independent check" (the owner, 2026-11-24: "yes drop it", after asking "why we still need this?") (section 1.4).
- **Nothing in front of the providers**: "then no per-site figures and the credential would have to live in the container" (section 1.4).
- **A provider's own API gateway product**: "a further paid service for something the Worker already does" (section 1.4).
- **LiteLLM as a proxy server**: "it needs a server and a database of its own" (section 1.4).
- **A long-lived key handed to the app**: "No user hands the app a long-lived key" (the owner, 2026-11-24: "why would a user wanna trust my app with their key? why am i being given the key in the first place?"). A pasted key with the narrowest permission the provider offers stays only as that provider's fallback if its M2 check fails (sections 1.4 and 1.6).
- **Google OAuth with the `cloud-platform` scope**: "it covers the user's whole Google Cloud ("See, edit, configure, and delete your Google Cloud data"), needs Google's app verification, caps an unverified app at 100 users, stops after 7 days in Testing, and Google says "you must not use, or encourage the use of, user credentials for server-to-server deployment."" (section 1.6).
- **Direct Anthropic and OpenAI keys**: not in v1 (the owner, 2026-11-23: "model providers for **everyone**: only the 3 for now"; 2026-11-24: "keep anthropic in v2"). They are a v2 requirement, as pasted-key plug-ins with a dedicated, spend-limited key, "since neither documents a way for a third-party app to call a user's models" (section 15.6).
- **The other suppliers on the T14 shortlist**: Cloudflare's own AI services were "excluded by the owner"; the shortlist put Bedrock and Vertex AI first, then IBM watsonx, Oracle OCI Generative AI and Alibaba Model Studio, and the owner decided on Foundry, Bedrock and Vertex AI (section 15.1). design-v3 gives no further reason for the others.

## Consequences

No user types a price, and the budget stop always counts at least what the vendor can charge. A friend's setup includes a cloud account with a payment method, which is an accepted cost (the owner, 2026-11-23). The owner keeps a live account at all three providers so that every guide is walked live. Foundry's Claude prices depend on a weekly maintainer reading of the Marketplace listings. No connection expires on a date; a revoked grant stops that provider at once and raises the urgent alert. Because every user grants the same app, each connection is used only for the user who proved control of it: Bedrock by the user's own external ID, Foundry by the tenant in the user's own signed Microsoft sign-in, Vertex AI by a role granted to the user's own identity (section 1.4, T116) (the owner, 2026-11-25: "for security point - yes A it is."). Direct Anthropic and OpenAI are a v2 requirement, as pasted-key plug-ins with dedicated, spend-limited keys (section 15.6).
