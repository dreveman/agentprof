# Following work from a prompt

The recorder emits `prompt-input → prompt`, tool
`preflight → execution`, and `subagent → first child prompt-input` flow endpoints. Prompt text and length live on the operation;
the input event carries its source. Turns and attempts nest inside the operation,
while tool, response, and workflow slices occupy separate tracks.

The emitted first-prompt delegation endpoints describe this path:

```text
prompt-input → prompt
                 ├─ model responses and provider requests
                 ├─ ordinary tool executions
                 └─ subagent tool → child prompt-input
                                     └─ child prompt → …
```

These are causal relationships. Track nesting and overlapping timestamps alone
do not establish delegation or dependencies between parallel tools.

## What the current recordings provide

The bundled example has three `subagent` tool spans with distinct `child_session`
annotations. Each child capture records the matching `parent_session` and has one
input/operation pair. That identifies all three parent-to-child relationships.
Each tool span carries `call_id`, `delegation = true`, and its launch correlation
value. Ordinary asynchronous slices still lack an explicit operation ID.

Delegation IDs are the first eight SHA-256 bytes of
`pi.delegation.first-prompt:<lowercase child session UUID>`, interpreted as an
unsigned little-endian integer (zero maps to one). The parent reserves its tool
lane at execution start and defers writing the BEGIN until the result provides
the child session UUID, using the saved start timestamp. Launches without a returned child UUID, including
interrupted calls, still produce spans without a child flow. The child adds that ID to its
first input only; capture restarts do not reset eligibility, and resumed sessions
with existing user messages do not link another input. Later results naming an
already linked child session do not create additional source endpoints.
The example's three endpoint pairs were added using their recorded child UUIDs.

## One recording across processes

A top-level Pi session and local descendants share a recording directory through
`PI_TRACING_RECORDING_DIR`. Each keeps its bounded writer and periodic flush.
When the owner stops, children finish tracing and the owner publishes one
`.pftrace`, merging complete packets and using a common clock calibration.
No collector service or live packet transport is involved.

Perfetto therefore imports the endpoints in the same trace/machine context and
creates normal `subagent → prompt-input` arrows. The built-in example exercises
all three parent/child links. Tests also cover concurrent siblings, nested
children, running children at stop, and capture restarts.

Independent recordings can still be opened together for comparison. Perfetto's
per-trace flow tracking does not connect matching IDs across those files.
Selecting a slice shows its directly connected flows; area selection and the
Flow Events panel's Show All control show the wider graph. Selection does not
automatically traverse every descendant of a prompt.

Repeated prompts in an existing worker session remain outside this first-prompt
scheme. They need an explicit prompt/launch identifier shared by both ends
before additional links can be recorded reliably.
