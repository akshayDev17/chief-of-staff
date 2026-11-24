# ADR-012: every wait is a long-running tool call recorded outside the model; the shell resumes the run; outside effects are recorded before they are made

Source: [design-v3](../design-v3.md), section 2.7 (decision record ADR-012).

## Status

Accepted (2026-11-24)

## Context

The agent waits on mail, on its user and on strangers, for minutes to weeks. Nothing may be billed while it waits and nothing may be lost if a machine restarts. ADK resumes a run at-least-once, so a step can run twice.

## Considered options

As in design-v3 section 2, which compares the options for this decision; this record does not restate them.

## Decision

Each wait is an ADK `LongRunningFunctionTool` (or, in a fixed step, a `RequestInput`). The tool records what is awaited with the shell and the run ends. The `Run` Durable Object keeps the pending call, its trigger, a timeout and a defined next step; when the trigger arrives it starts a new container and delivers the result as a function response with the same call id and invocation id. Every `ask_owner` during a browser run (a texted code, a missing fact or another question) first waits for the hold time with the page open, the answer reaching the live container through its own long-poll on `sessions.cos`; after that it waits with nothing running, and a cold resume reopens the form, restores the saved browser state and refills from the saved answers to the waiting step. The `Run` object resumes each run on the image tag it started on; an image tag is kept until no parked run uses it (the owner, 2026-11-24: "basically has the ADK-agent-in-python --> TS ---> ADK agent resumed flow been handled properly in the design v3 doc?" and, on the fix, "yes fold it in"). Every tool that acts on the outside world writes an effect key before acting and never repeats an action whose key exists.

### Rejected alternatives

The options design-v3 section 2 compares other than the one decided above, for the reasons given there.

## Consequences

A wait of weeks costs nothing and survives restarts and deployments, including a new agent image. A quick answer finishes an application on the spot. Each wait has a defined end, including when nobody answers. A repeated step cannot send an application or a message twice; at worst an action is left "unconfirmed" for the confirmation path. The long-running tools cannot be placed inside agents wrapped as tools. Replies and incoming codes appear in the run's record as ordinary events.
