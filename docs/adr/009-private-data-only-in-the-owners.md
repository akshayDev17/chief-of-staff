# ADR-009: private data lives only in the owner's Cloudflare account, separated per user, with D1 as the system of record

Source: [design-v3](../design-v3.md), section 8.6 (decision record ADR-009).

## Status

Accepted (2026-11-24)

## Context

The repository is public under the MIT licence. The agent handles resumes, legal facts, credentials, private messages and a record of every application, for several users. The agent runtime runs in a container whose disk is wiped when it stops. Models are called at each user's own provider. Secrets Store allows 100 secrets and one store per account.

## Considered options

design-v3 compares no alternatives for this decision. Its text names these, in section 8.4:

- **Personal data, or saved real examples, in the public repository** (section 8.4).
- **Each user's own secret in Cloudflare Secrets Store** (section 8.4).
- **Embeddings and a vector database** for the hub at the start (section 8.4).

## Decision

The repository holds code, schema migrations, generic prompts and a made-up test persona only. All personal data lives in the owner's Cloudflare account: one D1 database as the system of record with every row carrying its user and every query scoped to one user; one private R2 bucket with a prefix and an encryption key per user; each run's working record in its own Durable Object, named by user; a vault per user in D1, encrypted with that user's key, holding provider credentials, residential-exit details, portal passwords and the Gmail token, and never a LinkedIn password. The key that protects the per-user keys sits in Secrets Store. The container holds no key and keeps nothing between runs. The model proxy keeps no prompt or response bodies, only the ledger row. Saved real examples for tests live in a private store, never in the repository.

### Rejected alternatives

- **Personal data or saved real examples in the repository**: "the repository contains code and a made-up test persona, and nothing about any user (standing rule 3)", because "The repository is public under the MIT licence"; saved real examples "are kept in a private test-examples store that only the tests can read, never in the public repository" (section 8.4).
- **Each user's secret in Secrets Store**: "Secrets Store allows "up to 100 secrets per account" and "only be one store per account" (tier report D4), so per-user secrets cannot each sit there. Each user's own key is kept in D1 wrapped by the one key in Secrets Store" (section 8.4).
- **Embeddings and a vector database at the start**: "The hub is expected to hold a few hundred short items per user (an estimate), which a keyword search plus one small-model check handles. If matching proves weak in practice mode, an embedding model at the user's provider is the addition" (section 8.4).

## Consequences

Anyone can read how the agent works; nobody can read any user's data from the repository. A secret scanner and the made-up persona are mandatory parts of continuous integration. The Cloudflare account is the security perimeter for every user, so it needs strong sign-in. The owner runs the deployment and can in principle read every user's data, which the consent page says plainly. Prompts go to each user's own provider under that provider's terms. The cross-user refusal check (M8) shows that one user cannot reach another's run, file, remote view or alert; it is not a security audit. The schema and stored data change only through Cloudflare's D1 migrations run by the pipeline (two releases per change), resumable data-migration jobs run by the shell, and each Durable Object upgrading its own storage when it wakes, with a D1 restore bookmark recorded before any change that alters or removes data (section 8.4).
