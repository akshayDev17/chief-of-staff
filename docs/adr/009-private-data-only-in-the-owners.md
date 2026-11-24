# ADR-009: private data lives only in the owner's Cloudflare account, separated per user, with D1 as the system of record

Source: [design-v3](../design-v3.md), section 8.6 (decision record ADR-009).

## Status

Accepted (2026-11-24)

## Context

The repository is public under the MIT licence. The agent handles resumes, legal facts, credentials, private messages and a record of every application, for several users. The agent runtime runs in a container whose disk is wiped when it stops. Models are called at each user's own provider. Secrets Store allows 100 secrets and one store per account.

## Considered options

As in design-v3 section 8, which compares the options for this decision; this record does not restate them.

## Decision

The repository holds code, schema migrations, generic prompts and a made-up test persona only. All personal data lives in the owner's Cloudflare account: one D1 database as the system of record with every row carrying its user and every query scoped to one user; one private R2 bucket with a prefix and an encryption key per user; each run's working record in its own Durable Object, named by user; a vault per user in D1, encrypted with that user's key, holding provider credentials, residential-exit details, portal passwords and the Gmail token, and never a LinkedIn password. The key that protects the per-user keys sits in Secrets Store. The container holds no key and keeps nothing between runs. Gateway logs keep metadata only. Saved real examples for tests live in a private store, never in the repository.

### Rejected alternatives

The options design-v3 section 8 compares other than the one decided above, for the reasons given there.

## Consequences

Anyone can read how the agent works; nobody can read any user's data from the repository. A secret scanner and the made-up persona are mandatory parts of continuous integration. The Cloudflare account is the security perimeter for every user, so it needs strong sign-in. The owner runs the deployment and can in principle read every user's data, which the consent page says plainly. Prompts go to each user's own provider under that provider's terms. The cross-user refusal check (M8) shows that one user cannot reach another's run, file, remote view or alert; it is not a security audit. The schema and stored data change only through Cloudflare's D1 migrations run by the pipeline (two releases per change), resumable data-migration jobs run by the shell, and each Durable Object upgrading its own storage when it wakes, with a D1 restore bookmark recorded before any change that alters or removes data (section 8.4).
