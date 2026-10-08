# Agent trace data contract

This is the first Agent Profiler data contract, grounded in the Pi recorder. It is
an evolving adapter convention, not a claim that all coding harnesses expose
the same lifecycle. Traces remain ordinary Perfetto protobuf recordings.

Category prefixes identify the recording harness: Pi writes `pi.*`, and the
Claude Code writes `claude.metadata` and `claude.activity`.
Codex writes `codex.metadata` and `codex.activity` using the same capture schema.
The interactive plugin records scoped lifecycle hooks and transcript usage,
without a native OTLP exporter. Hooks supply prompt boundaries, tool dispatch
intervals, compaction spans and child relationships. Tool intervals are labeled
`timing = hook-dispatch`, including hook/permission delays. Codex supplies the
parent session ID on subagent hooks, so their separate `agent_id` identifies
the child. Recording controls are excluded from tool activity. Interrupted
work is marked incomplete. Transcript completions carry reported token counts
but no measured model-request duration or TTFT. Its input tokens include
cached input; cache fields must not be added again. The effective context
window comes from captured session metadata. The separate exec recorder can
still capture native telemetry and prewarming. See the
[Codex recording guide](../packages/codex-tracing/README.md) for timing boundaries.
All four use the same version-1 capture markers and event kinds. Readers also
recognize `agentprof.*` categories from earlier Claude Code prototype recordings.
Claude Code's OpenTelemetry request intervals carry `timing = request-including-retries`;
direct mod streams use `timing = mod-request-including-retries`. Both boundaries
differ from Pi's message spans. Direct capture measures first content/text from
the request start to the corresponding streamed chunk. Tools use the reported
execution duration, positioned at the post-tool hook; `Tool dispatch` preserves
the observed interval including permission and hook delays. Compaction usage
contributes to token counters without counting as assistant turns. Main-session
context limits come from Claude's session API and are not assigned to subagents.
Claude's recording continues across clear/resume/branch as separate capture
windows in one file. Revisited native session IDs use a segment suffix for
unambiguous joins, with `native_session_id` retaining the original identity.
Starts during a prompt or child session use `started_before_capture`; reload
interruptions and work unfinished at stop are marked incomplete. Buffered
observations survive mod reloads, and file journals support recovery after an
abrupt process exit. Recording controls are excluded from tool activity.
See the [Claude recording guide](../packages/claude-tracing/README.md) for coverage.

Muse Code writes `muse.metadata` and `muse.activity`. Its native export supplies
per-response usage and measured model durations, positioned backwards from the
completion journal timestamp (`timing = native-duration`). Tool intervals use
native lifecycle timestamps. First-content latency is not inferred. Input
includes cached tokens and provides sampled context size; the context limit
comes from the model catalog. Lightweight hooks supply effort and compaction
boundaries. Export omissions of live output deltas are recorded separately from
missing journal records; missing child logs are counted in
`unavailable_child_sessions`. Partial responses exclude usage from the capture.
See the [Muse recording guide](../packages/muse-tracing/README.md) for boundaries
and recovery.

## Existing timeline model

| Track | Recorded meaning |
| --- | --- |
| `Requests` | `request` spans, from provider request start to response headers, including status and observed context count |
| `Responses` | `response` spans, from assistant-message start through message end |
| `Tools` | Tool execution spans; sibling descriptors merge into one visual track per capture |
| `Child workflows` | Optional workflow-only child intervals; sibling lanes merge visually. Older `workflow.child.N` tracks remain readable |
| `Workflow` | Optional orchestration events; child correlation also lives on the child's capture span |
| Main OS thread, named `pi` | Capture, prompt, attempt, turn, input, and tool-dispatch flow events; `Session` fallback when the OS thread ID is unavailable |
| **Runtime** | RSS and heap in bytes; sampled CPU usage in microseconds |
| **Tracing** | Dropped events, queue depth, lane overflows, and configuration changes |
| `Input tokens`, `Output tokens` | Cumulative reported tokens observed since capture began |
| `Context size` | Latest available context-size estimate, in tokens |
| `Context window` | Active model's context limit, in tokens; changes with the model |
| `Compaction` | `compact` spans for successful, failed, or aborted Pi compactions |

Track and counter labels use sentence case. The Agent Profiler workspace keeps
the main thread, **Requests**, **Responses**, **Tools**, **Context size**,
and **Context window**
directly visible. **Token usage** holds cumulative input/output counters.
Requests, Workflow, Child workflows, and the main thread (or Session fallback)
sit directly under the process or capture. A physical thread shared by captures
appears once in the process.
Selecting a hidden event can reveal its track through the usual timeline navigation.
The Pi recorder writes prompt, attempt, and turn spans on the main thread.
Configuration changes use the collapsed **Tracing** group so their intervals
cannot cross and prematurely close those spans. Older recordings with an
**Agent** track remain readable.

Runtime counters are grouped under **Runtime**: **Resident memory**, **JS heap**,
and **CPU time (interval)**. The CPU counter measures microseconds consumed since
the preceding sample, not utilization. **Tracing** contains **Dropped events**,
**Queue depth**, **Lane overflows**, and optional configuration intervals.
Both diagnostic groups start collapsed
in the Agent Profiler workspace and appear only when they contain samples.

Internal counter keys remain stable (for example `llm.tokens.input`); emitted
track labels are human-readable. The reader recognizes both old dotted names
and current labels, including flat diagnostic tracks in older recordings.
Request track descriptions explain that intervals end at response headers.

Each capture has a unique `agentprof.capture` parent track containing its
asynchronous activity and counters, with sibling merging disabled. OS-thread
events belong to their capture through the enclosing `profile (N)` span, where
N counts recordings started by that recorder. Older `tracing` spans remain readable.
Only real OS processes receive process descriptors and PIDs. Pi's
main agent and subprocess workers use their actual process tracks, with
`process_labels` (imported as `chrome.process_label`) describing the session and
optional role. These labels describe agents only when the agent/process mapping
is one-to-one; agents sharing a process must use generic tracks and per-agent
metadata instead of synthetic processes or process-wide agent labels.

The Agent Profiler workspace reuses upstream process summary rows and labels.
Multiple captures within a process stay in generic groups named **Session** or
**Subagent session**, using the recorded label or a shortened session ID. They
represent logical sessions, alongside one native row for each actual OS thread. If a loaded
recording maps several sessions to one process, or one session to several
processes, its process row does not use the labels to identify an individual
agent. Capture metadata remains the authoritative session/capture join key.
Tool descriptors are siblings under the capture root, all named `Tools` with
`SIBLING_MERGE_BEHAVIOR_BY_TRACK_NAME`. Concurrent calls keep separate UUIDs;
Perfetto multiplexes analysis tracks and the native renderer packs their slices
into one visual row. Capture roots disable sibling merging, so independent
captures remain separate. Older `tools.lane.*` descriptors remain readable.
Tool-triggered child launches use the existing tool span with `delegation = true`,
launch metadata, and the returned `child_session`. They have no duplicate delegate
interval; the tool's original start/end define the launch duration. The workflow
category controls this metadata and can record these calls on tool lanes even if
the general tools category is disabled. Orchestration outside tool hooks retains
its separate workflow events. Older `workflow.child.*` tracks remain readable.
The recorder reserves a tool lane immediately but defers the delegation BEGIN
until completion, when the child UUID is available. The original timestamp is
preserved, and a deterministic flow ID connects it to the child's first input.
Interrupted launches still close with an incomplete span, without a child flow.
See [prompt flows](prompt-flows.md) for ID derivation and separate-file limits.
Child annotations include `parent_session`,
`child_session`, and correlation fields when available. Local descendants join the owner's recording and are published in one file. Tool flows connect preflight instants to execution slices. The preflight
timestamp is reconstructed one nanosecond before execution because Pi invokes
the preflight hook after its execution-start hook; it is not a measured queue wait.

Codemode scripts use `kind = script`; children retain their tool name and carry
`parent_call_id` from Pi's `parentToolCallId`. A flow connects the calling script's
BEGIN to the child's preflight and execution BEGIN. Tool BEGIN packets are deferred
until completion or capture shutdown so these links can use the original start
timestamp. The lane is reserved at execution start. The default limit is 64
simultaneous calls, including scripts; excess calls increment **Lane overflows**.
Script duration includes nested work and is excluded from tool totals and tool
concurrency. The activity split includes **Scripts only** for measured script
time without a concurrent tool or model-response interval.

Pi's `models.classify` and `models.generateImages` publish lifecycle snapshots
instead of tool hooks. Observed running/completed transitions produce
`kind = model-call` spans with `timing = codemode-lifecycle`, model identity when
available, and a flow from the script. They may include queue time and do not
contribute to response speed or model-busy calculations. A completion without an
observed running snapshot does not fabricate a start. Unfinished observed calls
are marked incomplete. Snapshot tracking is bounded to 4,096 model calls per
script. Pi's tool-reported usage adds once to session counters; per-call token
usage is not inferred from the script's aggregate.

Assistant-message spans carry TTFT, usage, streaming statistics, and stop reason on
their END. The overview reads their actual interval; older summary instants remain
supported using their recorded duration annotation. Responses interrupted before
message end are marked incomplete and excluded from measured activity. A completion
without a captured start remains an instant with `start_not_recorded`,
without fabricated duration or TTFT.

Prompt length (`length`, UTF-16 code units) belongs to
`prompt`; the connected `prompt-input` only carries
`source`. The default-enabled `prompt-data` category additionally
records `text` on the operation and adds `pi.prompt-data` to its
categories. This is the task prompt observed by `before_agent_start`, not the
system prompt or entire conversation. Disabling the category retains length and
timing. Text is capped at 65,536 UTF-16 code units without splitting a surrogate
pair; `truncated = true` marks truncation and length remains the
full original length. Pi's legacy `captureContents` controls tool arguments
independently; the shared `AGENTPROF_CAPTURE_CONTENTS=0` opt-out also disables
prompt text across all four harnesses. Tool END annotations include `is_error`,
`updates`, and `bytes`; when content capture is off, `bytes_unavailable`
marks zero as unknown because cumulative tool results are not encoded for
sizing. `middleware_is_error`
separately records the outcome seen by the result middleware hook. The provider
span's `context_messages` is the count observed by our context hook,
before later handlers may modify the transcript. Configuration spans replace
duplicate model/thinking markers. Child identity annotations live on every capture
span, including captures started manually after session startup.

## Structured fields, version 1

Event names identify operations, never their arguments or results. For example,
`tool-preflight` carries `name`, `call_id`, `bytes`, and
`keys` as debug annotations. Tool execution slices retain the tool's name
(such as `read` or `subagent`) as their operation name. Missing-start completions
use the normal `response`, `request`, `tool-result`, or
`tool-middleware` name with `start_not_recorded = true`.

Workflow-category spans describe observed `subagent` or explicitly configured
child-tool executions, with bounded delegation identifiers and returned child
session IDs when available. No external orchestrator lifecycle is inferred from
unrelated events. `user_bash` records `executable` and
`length` (UTF-16 code units), never the command body in its name.

Annotation values use protobuf integers for integral counts/status codes,
booleans for flags, doubles for fractional values, and strings for text and IDs.
Argument key lists are arrays. Tool-content capture is enabled by default;
`args` on the execution span is a typed dictionary/array/scalar rather than
serialized JSON. This includes bash command lines, edit paths and old/new text,
and script source. Capture is bounded to 128 values, eight nesting levels, and
65,536 UTF-16 code units for keys/text. `args_truncated` marks omitted data,
including null values (which DebugAnnotation
cannot represent as a scalar). Arrays preserve a prefix so indices never shift.
When content capture is enabled, `bytes` measures the complete JSON-serialized
input in UTF-8 bytes, including metadata-only preflight for an already-started
tool; unserializable input records `serializable = false`. When content capture
is disabled, argument values are not traversed or JSON-serialized, so `args`,
`bytes`, and key lists are absent rather than guessed.
If the execution start was not recorded, preflight retains the arguments with
`truncated` instead. Readers also support arguments on preflight in older traces.
Disable Pi argument values only with `PI_TRACING_CAPTURE_CONTENTS=0` or
`/tracing categories contents off`; metadata-only preflight sizes/key lists
remain only while content capture is otherwise enabled. To omit prompt and argument values in **new** Pi, Claude, Codex and
Muse recordings, set `AGENTPROF_CAPTURE_CONTENTS=0` before launching the
harness. Default behavior remains content-on unless the harness-specific
config/category or this shared switch opts out. Claude also accepts plugin
`capture_contents: false`; Muse persists `configure --no-content`. Prompt
lengths (when observed), operation names/IDs, token usage, timing and model
metadata remain. File output paths and session identifiers remain in capture
metadata; Pi workflow IDs and source-key lists can still identify work.
Claude's direct/legacy and Codex plugin collectors omit content before their
retained raw journals; older journals are not rewritten. Muse omits content
from the published trace and parsed state but its native export temporarily
contains raw content, and Muse's own session journal is outside Agent
Profiler's control. Codex's own session log is similarly unaffected. In
content-on mode, Claude/Codex raw journals may contain more than the bounded
final trace; the separate Codex exec recorder can include native tool output.
Assistant response text and tool-result
bodies are not intentionally stored in final traces, but Muse reminder prompts
can quote the main conversation, including tool results.

| Harness | Default prompt and argument values | Content-off final trace | Content-off local intermediates |
| --- | --- | --- | --- |
| Pi | Task prompt text; tool input, including commands, edit paths/text and scripts | Prompt length; tool names/IDs; disabled argument values are not serialized for sizes/keys | Private part/spool contains no prompt or argument values |
| Claude | Main and subagent prompts; tool inputs/descriptions | Prompt length; tool name/IDs, timing and usage | Direct checkpoint/journal and legacy hook/OTLP journal omit values; response/tool-result bodies are not collected intentionally |
| Codex | Main/child prompts and hook tool input | Prompt length when a hook supplies it; tool names/IDs, dispatch timing, transcript usage and outcomes | Plugin hook journal omits prompt and argument values; Codex's own session logs are unaffected |
| Muse | Main and reminder prompts (which may quote conversation/tool results); tool inputs | Prompt length; tool name/ID, timing and usage; raw string argument length when supplied (no parsed keys or object size) | Parsed plugin state omits values; temporary native export and Muse's own journal still contain them |

In every mode, the requested output path, process/machine identity, session and
workflow IDs, model/provider settings, token usage, duration and errors may
remain as metadata. Raw journals are local/private, but are not safe to publish
without separate review. Existing content-on files are never retroactively
redacted by changing the setting.

Harnesses may record an optional `intent` string on a tool or script span to
describe why it was invoked. The Tools tab prefers that text, falling back to
an excerpt of `args` for ordinary tools. Scripts instead show their `language`
and `line_count`. Pi codemode executes JavaScript; pi-tracing always records the
language, but omits the source-derived line count when capture is disabled to
avoid scanning uncaptured code. When recorded, line counts include blank
lines, but a final newline does not add an extra line. Older traces can use
recorded source to count lines, with partial source marked as a lower bound.
Pi's current hooks do not supply intent, so pi-tracing
records arguments without inventing an explanation. Timeline links reveal the
full recorded arguments; tool results are not captured.

The `tracing` span on Pi's main OS thread covers capture start through manual stop
or Pi exit. It records `kind = capture`, `schema_version = 1`,
`recorder_version`, harness name,
enabled categories, and effective content-capture setting, even when session
events are disabled. Its end records `stop_reason`. Normal stop
closes this span without marking it incomplete; a missing end remains visibly open.
The UI also accepts older recordings with a `tracing-start` instant.
On Linux, the main thread's TID equals the process PID. The extension uses this
only when running on the main JavaScript thread; otherwise it keeps the generic
`Session` track rather than inventing an OS thread ID. The process and
thread names both use the constant `pi`; neither is read from the OS. Windows
also uses the generic fallback until native thread IDs are supported. OS track UUIDs
remain stable across captures of the same process lifetime. Capture spans carry
the identity needed to associate their child events with each recording even
when Perfetto combines them onto one thread track. These spans measure recording
wall time, not CPU execution time.

It also records `model`, `provider`, and `effort` when Pi supplies
them. Effort is Pi's configured thinking level (for example `high` or `off`), not
an inference about the provider's reasoning behavior. Initial configuration is
sampled for automatic, command, and shortcut capture starts. Model/effort changes
and configuration changes observed before requests emit `run-configuration`
spans with the same fields, lasting until the next change or capture end. They nest
inside `tracing`; the capture's configuration attributes describe its initial state.
These spans are independent of category filters. The capture span also records
`capture_id` (unique per recording),
`session_id` (the full harness session ID), and optional
`label` from `/tracing start <name>`. Use labels such as
`code-mode` and `classic` to identify comparison variants. Labels are explicit;
loaded plugins/extensions are not yet inventoried automatically. `machine_id`,
`clock`, and `clock_uncertainty_ns` describe
capture provenance. Snapshot uncertainty measures local sampling, not host clock skew.
Unknown fields remain absent; no settings are inferred from filenames.

Annotation names are local to the event: no recorder or event-name prefixes.
The UI accepts the older prefixed names for compatibility. The recorder writes
`call_id`; SQL reads
`EXTRACT_ARG(arg_set_id, 'debug.call_id')`.

Recorder-owned debug annotation names use `snake_case`, including workflow
fields such as `parent_session`, `child_session`, `subagent_type`, `task_id`,
`root_id`, and `duration_ms`. Keep names local to the event and include units
where needed. Values retain their native protobuf types. Captured tool argument
objects under `args` preserve the tool's original keys; those keys are source
data, not recorder metadata. Readers accept older camelCase workflow fields.

| Recorder annotation | Meaning |
| --- | --- |
| `kind` | `turn`, `provider-request`, `tool-execution`, `script`, `model-call`, `assistant-message`, or `context` |
| `index` | Pi's turn index; not a globally unique turn ID |
| `call_id`, `name`, `is_error` | Tool identity and observed boolean outcome |
| `parent_call_id` | Immediate calling tool's ID, scoped to the same capture; links scripts to nested calls |
| `intent` | Optional harness-provided description of why a tool or script was invoked |
| `language`, `line_count` | Script language and, when content capture is enabled, total physical source lines |
| `args`, `args_truncated` | Recorded tool input and whether any argument data was omitted |
| `session_labels` | Harness-provided string array on capture/configuration spans; the UI displays its values directly as session subtitles |
| `phase` | `response-headers`: this interval excludes consuming the response stream |
| `status_code` | HTTP status reported at response headers |
| `peak_context_tokens` | Highest observed context estimate in one profile, including Pi's pre-compaction estimate |
| `context_window_tokens` | Active model's maximum context capacity from Pi model metadata; recorded on the profile and each configuration change when known |
| `tokens_before`, `tokens_after` | Compaction estimates; `tokens_after` is absent when Pi reports unknown |
| `provider`, `model`, `stop_reason` | Bounded metadata from the model context or assistant message |
| `duration_ns` | Message start to message end, in nanoseconds |
| `first_content_ns` | Message start to first nonempty content delta; absent when none was observed |
| `updates`, `bytes` | Number and UTF-8 byte size of nonempty deltas |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens` | Per-message usage as reported by Pi; missing fields remain absent |
| `context_messages` | Number of messages in the context hook |

Session labels use native DebugAnnotation array entries containing strings;
Trace Processor exposes them as `debug.session_labels[0]`, `[1]`, and so on.
Pi emits `codemode` when enabled and omits an empty list. Its metadata writer
keeps up to 32 distinct, nonempty labels of at most 100 characters each.
The UI deduplicates labels observed in a capture and displays them as supplied,
without interpreting their names or inheriting labels from subagent sessions.
Missing and empty lists both produce no subtitle.

First-content latency is measured from message start, not necessarily network
request start. It can include thinking or tool-call deltas and must not be
presented as provider-measured time to first output token. Usage is not cumulative;
do not add `totalTokens` to its component counts. Provider cache accounting can
differ, so no universal total or cost is inferred.

The `incomplete` flags
exclude unfinished intervals from completed-duration summaries. An interval's
observed duration may still be shown with its incomplete flag. Work durations
can overlap and must not be added to estimate wall time.

Older traces retain generic timelines and name-based classification of turns,
requests, and tools. Structured details unavailable in those traces are NULL,
not zero. New optional annotations should be additive; incompatible semantic
changes require a schema-version change and reader updates.

## Token counters

Context composition snapshots and category counters use the additional
[context data contract](context-data.md). Reported totals remain independent
from the breakdown estimates.

All four token tracks use absolute counter values and the `tokens` unit. They
belong to the recorded session's process and follow the `llm` category, independently
of runtime sampling and `sampleHz`.

Input and output start at zero for each capture and accumulate each assistant
message's reported usage at `message_end`. Capturing mid-session does not backfill
earlier usage. Cache-read/write fields are not added to input; the provider's
reported input semantics are preserved. Missing or invalid fields produce no
sample for that metric, so totals cover only observed, reported usage. Per-message
usage annotations remain available alongside the counters.

Context is a gauge sampled before provider requests and after compaction when
Pi's `getContextUsage()` supplies a nonnegative integer estimate. It may decrease
after compaction; it is neither cumulative usage nor a provider-measured prompt
token count. Ordinary unknown estimates produce no sample. A successful compaction
with an unknown post-compaction estimate writes zero as an **unknown-state
sentinel**, ending the stale pre-compaction plateau; the next known estimate
restores the gauge. The `compact` span records reason, outcome, whether Pi will
retry, pre-compaction estimate, and reported summarization usage when available.
The recorder stores the highest observed or compaction-reported estimate as the
typed `peak_context_tokens` annotation on the enclosing `profile (N)` span.
The **Context window** counter starts at the active model's limit and changes
when Pi selects another model. If the new limit is unknown, zero ends the prior
plateau; it does not mean the model has a zero-token window. Both context
counters share a Y-axis range within their capture, so their heights are
comparable. Each sampled counter returns to zero at capture end.
The overview uses the recorded `context_window_tokens` model limit to show
context usage for each session and its subagent sessions. This capacity is
distinct from observed usage; older traces without the model limit show
“Not recorded.”

At normal capture stop (including Pi process exit), every sampled counter receives
a closing zero at the capture's end timestamp. This bounds its visible lifetime
when recordings of different lengths share a timeline. Unsampled counters remain
absent. Final diagnostic values are recorded one nanosecond before the closing
zeros so they remain available. These zeros mark the end of recording, not a
reversal of token usage or a measured release of process memory. Use the maximum
input/output value for capture totals, as the overview does, rather than the last
sample. Unknown or abruptly interrupted capture endings cannot guarantee a reset.

The synthetic test fixture includes input values `0 → 100 → 280 → 0`, output values
`0 → 20 → 65 → 0`, and context estimates `100 → 260 → 400 → 0 → 120 → 0`.
Its compaction reports a peak estimate of 450, above the last gauge sample of
400. Overview's **What happened in this
recording?** table shows one row per session capture, including nested subagent sessions.
Reported input/output tokens, turns, responses, tool calls, and incomplete operations
are summed across the group. Context is the largest individual agent's sampled
estimate, not the sum of context sizes. The recorded window spans the earliest
start through the latest end. Harness, provider, model, and effort list all recorded
values across the group, including configuration changes. Missing usage is excluded
from totals; a wholly unmeasured total remains "Not recorded".

Delegation flows and recorded session IDs identify relationships.
Capture times disambiguate repeated recordings of the same session. Children with
missing or ambiguous parents, or cyclic relationships, retain separate overview
rows. Detailed per-capture data remains available in the Sessions tab. Subagent
processes start collapsed in the timeline; when a process also hosts a parent,
only its subagent capture groups start collapsed. They can be expanded normally.

Independent captures remain separate even with the same PID and session ID. Older traces
without capture parents fall back to process grouping; those without configuration
or counters display "Not recorded".

## Clock and capture limits

Each packet carries a boot-scoped machine ID on Linux/macOS. Clock snapshots
relate the monotonic source clock to BOOTTIME and REALTIME at capture start and
periodically afterward. REALTIME is the primary trace clock, allowing files from
different boots or machines to share a wall-clock epoch, including in older readers.
Events retain high-resolution monotonic timestamps. Both native Trace Processor
and the browser merge path are tested; a synthetic cross-machine test uses unrelated
BOOTTIME epochs and verifies the expected real-time offsets.

Use **Open trace file** in the top bar in Agent Profiler and open the shared-timeline
merge (the upstream modal calls this **At the same time**). Automatic alignment
uses the recorded clocks. Sessions captured at different times retain those offsets;
comparison metrics include each capture's subagents, without normalizing to a common start time. The
remaining Overview charts describe combined recorded activity. Cross-machine timing
depends on the hosts' wall-clock synchronization; snapshots do not measure clock skew.
Reported clock conversion errors suppress combined timing metrics. On platforms
without boot identity, the recorder reports machine ID zero; use the merge dialog's
machine assignments to distinguish unrelated hosts.

Disabled categories, dropped events, interrupted captures, and lane exhaustion
can all leave missing data. Child launch duration is not child execution time.
A top-level Pi recording includes its local descendant processes in one file.
Private process spools flush periodically; finalization orders packets, assigns
unique sequence IDs, and applies the owner's clock mapping to the shared local
source clock. This avoids independent wall-clock sampling error between closely
spaced flow endpoints. Unresponsive children are included up to their last
complete packet, with remaining spans explicitly incomplete. Independent runs
can still be loaded separately for comparison. Separate-file imports do not join
native flows across their trace contexts.

Metadata and bounded prompt/tool content are collected by default (Pi also
requires its `contents` and `prompt-data` categories). The shared opt-out keeps
measurements and IDs but not prompt or tool argument values in a new trace.
Model output, tool-result bodies, credentials and headers are not intentionally
added as structured fields; captured prompt text, especially Muse reminder
prompts, may quote prior messages or tool results. Review recordings before
sharing them.

## Next collection priorities

1. Stable operation, turn, request, and attempt IDs, with explicit parent
   relationships across files; retain the harness's own identifiers too.
2. Request lifecycle through stream completion, with cancellation, retry reason,
   attempt number, and backoff spans. Keep response headers distinct.
3. Measured approval/user wait and scheduler/queue intervals; never infer them
   solely from empty timeline space or reconstructed preflight events.
4. Context size, compaction events, token limits, and effective model settings.
   Record counts and sizes without introducing content by default.
5. Recording and harness versions, supported event capabilities, clock quality,
   and a run manifest that identifies all child files and missing workers.

Validate each addition against real harness events and a small trace fixture
before making the UI depend on it. The UI bundles a real Pi–Opus-5 parent and its three subagents;
see [their provenance](../examples/pi-opus-5/README.md). A separate synthetic test
fixture covers parallel tools, an error, missing usage, and incomplete work.
