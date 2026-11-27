# ADR-018: OpenRouter is the only model provider; each user connects their own OpenRouter account with "Connect OpenRouter", authorizing a key on OpenRouter's own consent page, and the key OpenRouter issues goes straight into that user's vault; one proxy in the Worker calls OpenRouter on exactly the chosen model, takes tokens and cost from its reply, enforces the user's budget and keeps the usage ledger

Source: [design-v3](../design-v3.md), section 1.9 (decision record ADR-018).

## Status

Accepted (2026-11-27). Supersedes [ADR-001](001-models-three-providers-registered-per-user.md).

## Context

The owner wants the models with a different vendor from the rest of the system, to see daily and per-job-site usage, and each user to pay for their own model use. From 2026-11-23 the design had three providers, Foundry, Bedrock and Vertex AI, each connected by a grant to the app's own identity inside the user's cloud account (ADR-001). On 2026-11-27 the owner removed all three (the owner, 2026-11-27: "so delete all the three: bedrock, gcp and foundry, and only have openrouter."). OpenRouter issues an app a key tied to the user's own account through OAuth PKCE, billed to the user's own credits; sells every model family through one endpoint; reports tokens and cost in every reply; and offers no way for an app to delete a user's key without a management key. The agent runs in a container that must hold no secret.

## Considered options

design-v3 section 1.4 compares what could sit in front of the provider; sections 1, 1.4, 1.6 and 15.6 name the alternatives for which providers are offered and how a key reaches the app.

- **OpenRouter only, connected through OpenRouter's own consent page (OAuth PKCE)** (decided; section 1).
- **Keeping the three providers, Foundry, Bedrock and Vertex AI** (ADR-001; section 1).
- **A key the user pastes into the app** (sections 1 and 1.6).
- **One proxy in this app's Worker, with a per-user vault** (decided), **Cloudflare AI Gateway**, **nothing in front of the provider**, **a provider's own API gateway product** and **LiteLLM as a proxy server** (section 1.4).
- **OpenRouter's own model fallback** (`models`, `route`) (section 1.4).
- **Revoking the key on Disconnect with a management key** (sections 1.4 and 1.6).
- **A direct Connect OpenAI** and **Connect Anthropic** (sections 1 and 15.6).

## Decision

OpenRouter is the only provider, for the owner and every friend. Each user connects it with one button, Connect OpenRouter, with no field: OpenRouter's own authorization page (OAuth PKCE, S256, a fresh `state`), with the key's label "Chief of staff" and its credit limit prefilled (the user's monthly budget when set, else $10); the user signs in at OpenRouter and authorizes, and the app exchanges the code for a key issued to the app. The key is never typed, pasted, shown, logged or sent to the browser; it goes straight into the user's own vault (the user's own AES-256-GCM key, wrapped by the Worker secret `VAULT_KEY`), and the connection record holds nothing secret. The model list is every model OpenRouter's public models API lists, read daily and on Refresh model list, each with its price and the tier the app works out from its input price; one the app cannot use, or the user's own account leaves out (OpenRouter's per-account list, read with the user's key), is listed but not choosable, with a plain reason. Each chosen model runs its own test call once, Test all models tests them together after showing the estimated cost, and the Connect test runs on one cheap model OpenRouter sells. Every call goes through one proxy in the Worker, straight to OpenRouter, on exactly the chosen model (OpenRouter's own model fallback taken out), and is refused if the model is no longer listed, has no price, the budget is unset or spent, or no key is in the vault. Tokens and cost come from OpenRouter's reply (its `usage.cost`, plus the upstream cost when the user's account routed the call through their own provider key); only a reply with no cost is priced from the price table, never below what OpenRouter can charge; each call writes a D1 ledger row naming how it was costed and OpenRouter's generation id. OpenRouter's Activity page and generation records are the independent check; there is no AI Gateway (the owner, 2026-11-24: "yes drop it", after asking "why we still need this?"). One monthly budget per user; the key's credit limit at OpenRouter is a second cap. For each task the user chooses the provider (OpenRouter only today) and a main and a fallback model from the models that passed a test; the fallback is another model on OpenRouter, never the main model itself. Disconnect deletes the key from the vault, and the screen tells the user to delete it at https://openrouter.ai/settings/keys. The plug-in interface stays, so a new provider is one plug-in and its button; the app's own OpenID Connect issuer stays for the planned Connect Anthropic, and OpenAI's models are reached through OpenRouter. Three rules hold for every provider, now and later: each user pays for their own model use and the owner pays for no one else's, and no user ever pastes a key into the app (the owner, 2026-11-27: "bring ur own model means bring ur own model, i am paying for jack shit. i.e. i am not paying for anybody else. no one would want their privacy to be sacrificed, so pasting a key is a hard no."); a user choosing or authorizing a key at the provider, so that the provider issues it to the app through a consent flow, is allowed and is not giving a key.

### Rejected alternatives

- **Keeping Foundry, Bedrock and Vertex AI**: removed by the owner (the owner, 2026-11-27: "so delete all the three: bedrock, gcp and foundry, and only have openrouter.").
- **A pasted key**: no user ever gives the app a provider key or secret (the owner, 2026-11-27: "bring ur own model means bring ur own model, i am paying for jack shit. i.e. i am not paying for anybody else. no one would want their privacy to be sacrificed, so pasting a key is a hard no."). Authorizing a key on OpenRouter's own page, so that OpenRouter issues it to the app, is not giving a key (section 1).
- **Cloudflare AI Gateway**: "a second count of calls the app does not need: the ledger is the app's count, and OpenRouter's own records are the independent check" (the owner, 2026-11-24: "yes drop it", after asking "why we still need this?") (section 1.4).
- **Nothing in front of the provider**: "then no per-site figures and the key would have to live in the container" (section 1.4).
- **A provider's own API gateway product**: "a further paid service for something the Worker already does" (section 1.4).
- **LiteLLM as a proxy server**: "it needs a server and a database of its own" (section 1.4).
- **OpenRouter's own model fallback**: "taken out of every call, so each call runs on exactly the model the user chose and the ledger names it; a task's fallback is another model the user picked" (section 1.4).
- **Revoking with a management key**: "it would be the user's own account-level secret, which the app never asks for" (section 1.4).
- **A direct Connect OpenAI**: not built; OpenAI's models are reached through OpenRouter (sections 1 and 15.6).
- **Connect Anthropic**: not rejected; planned as a separate build, which is why the app's own OpenID Connect issuer is kept (sections 1.4 and 15.6).

## Consequences

No user types a price or a key. A friend's setup is an OpenRouter account with credits, one button and one Authorize, with no cloud account, role, template or command. No region is chosen. The ledger counts what OpenRouter reports billing, and the budget stop never counts less than OpenRouter can charge. The per-provider bill checks of T118 no longer apply: token honesty is checked against OpenRouter's own Activity page and generation records, from which the ledger's figures come. The app cannot revoke a key, so a user who disconnects deletes it at OpenRouter, and the screen says how. A spent budget or a missing key stops a task's main model and its fallback together. Prompts pass through OpenRouter to the provider it routes to; OpenRouter's data-handling terms are not yet read. The vault key is never rotated casually. The tables only the three earlier providers used stay in D1 until a later contract release, and the ledger keeps past calls to them. Nothing in the owner's AWS, Google or Azure accounts was touched; what remains there is listed for the owner outside the repository.
