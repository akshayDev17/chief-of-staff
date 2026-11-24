# ADR-002: the agent is built with Google's ADK in Python and runs in Cloudflare Containers, inside a Worker shell that holds its memory, with one `Chief` per user

Source: [design-v3](../design-v3.md), section 2.7 (decision record ADR-002).

## Status

Accepted (2026-11-24)

## Context

The system must run on Cloudflare with no always-on machine and spends most of its life waiting. ADK is the owner's preferred framework, and the Harness-Engineering course's patterns are to be exercised for real. ADK's Python package cannot be installed in a Python Worker. A container is required in any case for the browser that acts as the user. Cloudflare documents a container-run agent loop with its memory in a Durable Object, and a container reaching Workers storage by plain HTTP. The app serves several users, whose work and faults must stay apart.

## Considered options

design-v3 compares the options in four tables: section 2.1 (ways of running ADK on Cloudflare), section 2.2 (hosts for ADK agents), section 2.3 (Cloudflare's three arrangements for an agent loop) and section 2.4 (the four arrangements that could meet the requirements).

- **ADK Python inside a Python Worker** (section 2.1).
- **ADK TypeScript inside a Worker** (section 2.1).
- **ADK Python inside a Cloudflare Container** (decided; section 2.1).
- **Hosts** (section 2.2): Google Agent Runtime, Google Cloud Run, Google GKE, Cloudflare Containers (decided), Azure Container Apps, AWS Bedrock AgentCore Runtime.
- **Where the loop and its memory live** (section 2.3): loop in the Durable Object; loop in a container with memory in the Durable Object (decided); everything in one container.
- **Arrangements** (section 2.4): A. ADK (Python) in Cloudflare Containers, inside a Worker shell (decided); B. Cloudflare Agents SDK in TypeScript; C. ADK on a Google runtime, Cloudflare for browser and dashboard; D. ADK on Azure Container Apps, Cloudflare for browser and dashboard.

## Decision

One container image holds Python, ADK, Playwright and Chrome. Each run is an ADK `Workflow` around at most one model-driven loop, with `single_turn` sub-agents for narrow jobs. A TypeScript Worker is the shell: one `Chief` Durable Object per user for that user's schedule, caps, locks and alerts; one small owner-level object for the base-tier ceiling and user cap; one `Run` Durable Object per run, named by user, holding that run's ADK session and controlling its container; the mail fetch and gate; the dashboard. A container serves one user's run, holds no key and no data between runs, and reaches storage, secrets and models only through names the shell answers for that user. No Kubernetes. The arrangement is proven first on Cloudflare (proof 2, M3); its fallback is Cloudflare's Agents SDK in TypeScript or another container host, each as the owner's decision.

### Rejected alternatives

- **ADK Python inside a Python Worker**: "Does not install." It "accepts only "pure and PyEmscripten Python packages on PyPI"", and "ADK depends on a compiled package, `watchdog`, that has no build for that target" (section 2.1, Appendix B.1).
- **ADK TypeScript inside a Worker**: "Not supported, and not a documented route to these models": "nothing from Google says Workers are supported", in TypeScript Claude is reached "through Google Cloud Agent Platform only", and "The course is also written in Python" (section 2.1).
- **B. Cloudflare Agents SDK in TypeScript**: "B is the simpler machine and is the fallback ... But B cannot do what the owner asked: the course teaches ADK in Python, and the owner wants its patterns "tested in reality"; rebuilding them in TypeScript under other names would test Cloudflare's tooling instead" (section 2.4). It stays the fallback if proof 2 fails (section 2.7).
- **C. ADK on a Google runtime** (Google Agent Runtime or Cloud Run): C and D "exercise ADK but move the agent off Cloudflare and add cross-cloud links for every browser action" (section 2.4); "The browser would still be at Cloudflare, a cloud away from the agent that drives it" (section 2.2).
- **D. ADK on Azure Container Apps**: as C, and "The agent would sit beside the models, with one vendor holding both. That is the opposite of the owner's reason for keeping the models with other vendors" (sections 2.2 and 2.4).
- **Google GKE**: "Not an option: this project uses no Kubernetes (T01)" (section 2.2).
- **AWS Bedrock AgentCore Runtime**: "A fourth vendor, for nothing this app needs" (section 2.2).
- **Loop in the Durable Object**: Cloudflare's preferred arrangement, but "Cloudflare itself says where a non-JavaScript agent loop should go: a container driven by a Durable Object, with the memory kept in the Durable Object" (section 2.3); a loop in the Durable Object is arrangement B.
- **Everything in one container**: if the container dies, "The session and the run are lost." (section 2.3).

## Consequences

The course's stack and pattern names are used unchanged. Idle time costs nothing. There are two languages and a seam to keep tight. A lost container costs the step in progress. Start-up takes seconds. Several pieces are new or in beta: ADK workflows and resumability, Cloudflare's per-object container scheduling. One user's load or fault cannot stall another's `Chief`. The agent image is portable to other container hosts.
