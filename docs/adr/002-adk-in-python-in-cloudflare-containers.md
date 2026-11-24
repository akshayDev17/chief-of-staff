# ADR-002: the agent is built with Google's ADK in Python and runs in Cloudflare Containers, inside a Worker shell that holds its memory, with one `Chief` per user

Source: [design-v3](../design-v3.md), section 2.7 (decision record ADR-002).

## Status

Accepted (2026-11-24)

## Context

The system must run on Cloudflare with no always-on machine and spends most of its life waiting. ADK is the owner's preferred framework, and the Harness-Engineering course's patterns are to be exercised for real. ADK's Python package cannot be installed in a Python Worker. A container is required in any case for the browser that acts as the user. Cloudflare documents a container-run agent loop with its memory in a Durable Object, and a container reaching Workers storage by plain HTTP. The app serves several users, whose work and faults must stay apart.

## Considered options

As in design-v3 section 2, which compares the options for this decision; this record does not restate them.

## Decision

One container image holds Python, ADK, Playwright and Chrome. Each run is an ADK `Workflow` around at most one model-driven loop, with `single_turn` sub-agents for narrow jobs. A TypeScript Worker is the shell: one `Chief` Durable Object per user for that user's schedule, caps, locks and alerts; one small owner-level object for the base-tier ceiling and user cap; one `Run` Durable Object per run, named by user, holding that run's ADK session and controlling its container; the mail fetch and gate; the dashboard. A container serves one user's run, holds no key and no data between runs, and reaches storage, secrets and models only through names the shell answers for that user. No Kubernetes. The arrangement is proven first on Cloudflare (proof 2, M3); its fallback is Cloudflare's Agents SDK in TypeScript or another container host, each as the owner's decision.

### Rejected alternatives

The options design-v3 section 2 compares other than the one decided above, for the reasons given there.

## Consequences

The course's stack and pattern names are used unchanged. Idle time costs nothing. There are two languages and a seam to keep tight. A lost container costs the step in progress. Start-up takes seconds. Several pieces are new or in beta: ADK workflows and resumability, Cloudflare's per-object container scheduling. One user's load or fault cannot stall another's `Chief`. The agent image is portable to other container hosts.
