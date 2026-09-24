# Pi tracing integration

The existing Pi harness tracing is the starting point for Agentprof's recorder
integration. Its source and sample output have not yet been added here.

## Establish the contract from the implementation

Before designing UI queries, inspect the recorder and one sanitized trace to
document:

- How tracing is enabled, where output is written, and how it is finalized.
- The output encoding and its compatibility with the pinned Perfetto reader.
- Track organization and stable identifiers for sessions, agents, and turns.
- Event names and argument fields for model requests and tool calls.
- How parent/child agents and asynchronous operations are connected.
- Clock units and clock alignment, especially across processes.
- Which usage counters exist and whether values are incremental or cumulative.
- What is recorded for failures, cancellations, retries, and incomplete runs.

These are questions for the existing integration, not a new required schema.
Reuse its conventions wherever possible. Document missing information before
adding instrumentation or making the UI depend on it.

## First fixture and validation

Add a small, sanitized run containing a model request and a tool call. Include
a delegated agent if the harness supports recording one. Store its provenance,
recording command, harness revision, and expected visible events alongside it.

First confirm that upstream Perfetto opens the recording and exposes the
expected slices and arguments. Then verify Agentprof's grouping and links
against those same events. Do not infer parentage solely from overlapping
timestamps or report unrecorded token counts as zero.

Keep trace emission in the harness. Decide whether this repository needs an
adapter only after inspecting the existing format; avoid a conversion step
when the trace is already usable directly.
