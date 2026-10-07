# Context composition

Agent Profiler records context composition separately from cumulative input and
output usage. A context snapshot describes one session at an observed request,
capture start, completed turn, or compaction. Subagent windows are independent; they
are never added to a primary session's context size.

## Measurements

Claude Code uses its native local `summary` breakdown at capture start,
completed turns, and compaction. The full message list is read once at capture
start (and after compaction), not before every model request. Subsequent item
changes are best-effort counts observed from prompt, response and tool hooks;
post-turn samples are labeled `transcript-observed` and do not claim exact
request-input composition. In content-disabled mode, tool argument/result size
attribution that would require serialization is omitted. Final response usage supplies exact reported input
counts separately. Pi estimates the observed
outgoing transcript, including system sections and active tool definitions.
Muse uses native outgoing-request lane byte counts when available, with
transcript items for partial source attribution. Codex estimates available
durable transcript items. Its final request can differ from that transcript, so
these snapshots carry partial coverage and the `transcript-observed` stage.
Older Muse journals fall back to the same transcript approach. None of these
adapters makes additional model or remote token-count requests for profiling.

Text estimates use characters divided by four, rounded up per item. Muse
request-lane estimates use UTF-8 bytes divided by four; their basis is stored
separately. These are not tokenizer counts. Binary attachments, encrypted
reasoning, hidden provider
wrappers, and unavailable instructions remain unmeasured. Reported request
input is stored independently, including cached input once. Estimates are not
scaled to force agreement with reported input.

## Trace fields

Real request, response, capture, or compaction spans carry a typed `context`
debug annotation. Its fields use `snake_case`:

| Field | Meaning |
| --- | --- |
| `version` | Context schema version; currently 1 |
| `stage` | `request-input`, `capture-start`, `post-compaction`, or `transcript-observed` |
| `item_stage` | Attribution stage when item observations differ from the composition snapshot |
| `basis` | `native-summary`, `native-bytes/4`, or `chars/4` |
| `coverage` | `complete` or `partial` |
| `baseline` | First observation or a new measurement baseline |
| `sample_offset_ns` | Observation time relative to the enclosing event's start |
| `categories` | Exclusive top-level category counts |
| `estimated_tokens` | Sum of the recorded category estimates |
| `reported_tokens` | Matching request's reported input, when known |
| `window_tokens` | Model context capacity, when known |
| `effective_window_tokens` | Harness compaction window, when different |
| `compact_threshold_tokens` | Configured automatic compaction threshold |
| `model` | Model identity for this measurement |
| `changes` | Item additions, replacements, removals, or initial baseline items |
| `omitted_changes` | Smaller changes omitted from the bounded item list |

Categories are `system`, `rules`, `skills`, `tools`, `environment`, `prompts`,
`assistant`, `results`, `summaries`, `overhead`, `messages`, and `unattributed`.
`messages` preserves a native combined conversation count when subdivision is
unavailable. Child details are not added again to category totals.

Each item change includes an ID, category, estimated tokens, signed
`delta_tokens`, and change type. Optional fields include character count, a
short label, source kind, and source call ID. Snapshots retain up to 64 changes,
ordered by absolute size. Category totals include all measured items.

Category counters use absolute values, the `tokens` unit, and
`llm.context.tokens` as their shared Y-axis key. They appear under a collapsed
**Context** group. Categories disappearing from an observed snapshot return to
zero; all sampled counters reset when the recording ends. End resets do not
represent compaction.

## Interpretation

The overview combines each session's latest recorded composition in one bar.
Percentages show shares of the measured composition, not a combined model
context limit. Sessions without a breakdown are excluded.

The Context tab shows one session's estimated composition over
time, alongside total context measurements where available. Selecting a sample
shows its capacity breakdown. Largest additions link to the contributing tool
call when its identity was recorded, otherwise to the observed request.

An initial baseline is not new growth. Model changes establish a new baseline;
compaction can remove history and introduce a summary. Transcript-only adapters
must not claim that a journal result was included unchanged in the final
request. Script-internal tool results are not automatically attributed to model
context: the returned script output is the relevant retained item.

Only counts and identities are added by composition capture. Prompt and tool
content use existing recording settings; composition does not copy another
transcript or store system-prompt text. Older traces still show total context
history, with category breakdown marked as not recorded.
