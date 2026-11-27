# ADR-017: components and their release units, each designed and released where it lives

Source: [design-v3](../design-v3.md), section 2.7 (decision record ADR-017).

## Status

Accepted (2026-11-24). Amended 2026-11-27: with OpenRouter the only model provider (ADR-018), the Bedrock template, the Entra registration and the Vertex AI assets are no longer release units. The issuer key is no longer a unit: the app's own OpenID Connect issuer was kept that day for a planned Connect Anthropic, then removed the same day when the owner parked it ("ok, so lets not do the anthropic one just yet, lets get the openrouter one working at least"). The vault key, the Worker secret `VAULT_KEY`, is a secret, never a release, and is never rotated casually.

## Context

The app spans a TypeScript Worker, a Python container image, a database, an installed phone app, keys and data on their own clocks, and pieces owned by the site team. Each changes at a different pace and rolls back differently, and some cannot roll back at all. A single pipeline would couple them; a separate list of components would drift from the design (the owner, 2026-11-24: "i agree with the components as demaracated in the cos-release-units report. by i disagree with a separate section. why should we do that? why cant we bake it into the design v3 doc within the appropriate sections?").

## Considered options

design-v3 compares no alternatives for this decision. The record's own context, in section 2.7, names two:

- **A single pipeline for every component** (section 2.7).
- **A separate section listing the components** (section 2.7).
- **Each component's boundary, contract and release facts stated in the section that designs it** (decided; section 2.7).

## Decision

Each component's boundary, contract and release facts are stated in the section that designs it: the shell Worker, the agent image and Durable Object migrations (2.4), prompts (2.5), the price table (1.3), the provider plug-in and the vault key (1.4), NodeMaven (3.4), LinkedIn fixed scripts (4.10), portal paths (6.3), D1 migrations, data migrations, the objects' own storage upgrades, the saved-example store and secrets (8.4), email templates (9.5), the dashboard and installed app, the Web Push key pair, guides and static assets (10.5), the site team's pieces (10.3), owner settings (10.1) and the Access-list Worker (11.7). Units with their own pipeline and version tag: the shell Worker, the agent image, the dashboard front end, D1 migrations, Durable Object migrations, the Access-list Worker, the price table data (dated snapshots), the saved-example store and the Web Push key pair. Deploy order: schema migrations before the Worker that needs them, each schema change in two releases (expand, then contract), a D1 restore bookmark recorded before any migration that changes or removes data, and every migration run first on a fresh test database in CI; the Worker before the image that needs it; every Worker release still accepts the previous image and the previous dashboard; a parked run resumes on the image tag it started on, and a tag is kept until no parked run uses it. The repository has one shared CI skeleton; each unit's build ticket owns its own pipeline, tag and rollback.

### Rejected alternatives

- **A single pipeline**: it "would couple them" (section 2.7).
- **A separate section listing the components**: it "would drift from the design (the owner, 2026-11-24: "i agree with the components as demaracated in the cos-release-units report. by i disagree with a separate section. why should we do that? why cant we bake it into the design v3 doc within the appropriate sections?")" (section 2.7).

## Consequences

Each unit can be released and rolled back alone, and a broken image or dashboard never forces a backend rollback. Migrations, the vault key and the Web Push key are the irreversible or user-visible changes, so they are planned events. The design and the plan are documents, not releases. The site team's pieces are not ours to release; the site-themes package is pinned at a version and bumped deliberately.
