# Investigating an agent run

Load a Pi recording to open **Overview**. The Summary tab shows recorded activity,
model responsiveness, tool work, concurrency, and capture health. **Responses**,
**Tools**, and **Sessions** provide detail tables. Select a response's session or a
tool call to reveal that event in the timeline; **Open timeline** opens the Agent Profiler
workspace. The command palette (`Ctrl+Shift+P`) provides the `Agent Profiler:` SQL
queries for additional investigation; **More options → Query (SQL)** supports custom queries.

The activity bar shows model-only time, tool-only time, and their overlap, counting
each measured interval once. It excludes unfinished tools and missing message
durations. Uncovered time is not classified as waiting. Combined timing and
concurrency are unavailable when clock conversion errors are reported. Token
sums include reported values only; usage coverage counts expose missing values.
Response summaries group by provider and model. Singular model wording appears
only for one captured session with one known model; model changes and unknown
metadata use neutral headings. Aggregate charts state their session scope.

Start with **Capture health** to check for dropped events and lane overflows. **Slow tools** shows recorded errors and
incomplete spans; **Responses** shows optional usage and stream timings.
The default Perfetto workspace remains available for runtime counters and the
full original track hierarchy.

## Find where the time went

Start with the run's wall-clock interval. Locate the longest model requests
and tool calls, then inspect the surrounding turn. A slow tool, repeated model
requests, and a long interval without recorded work suggest different next
steps. An empty interval alone does not identify what the agent was waiting on.

## Follow delegated work

Use recorded parent/child identifiers in **Child launches** to locate subagent
recordings. The initial UI does not automatically join these files. Compare their
start and finish times with the parent and inspect where work overlaps. Check
whether the parent could continue or was waiting for a result, when wait events
are available.

Overlapping durations must not simply be added to estimate elapsed time.
Parallel activity can occupy more total agent time than the run's wall time.

## Inspect repeated work and usage

Look for repeated tool calls or model requests within a turn. Use recorded
arguments and outcomes to distinguish retries from distinct operations.
Where usage counters exist, inspect them alongside timing and keep missing
values distinct from zero.

## Check whether a change helped

Record comparable runs with the same task, harness settings, and model.
Consider run duration, individual operation durations, failures, and recorded
usage together. Model variability, caches, and external services can affect
results, so a single faster run is not enough to establish an improvement.

## Compare captures

**What happened in this recording?** shows aggregate output tokens per second,
the elapsed wall window, measured model-busy time, and peak concurrent model
responses above one row per session.
A row includes its recorded subagent sessions, whether the recordings come from
one file or several loaded files. The table begins with Agent, Model, and
Session. Session excerpts the earliest recorded prompt from that session; selecting
it opens the full prompt in the timeline. When prompt text was not recorded,
it shows an abbreviated session ID instead. Configuration, token totals,
tokens per second, context usage, recorded window, model-busy share, peak
concurrent model responses, turns, tool calls, and incomplete operations appear
together; no comparison mode needs to
be enabled. Tokens per second uses only responses with both reported output
usage and measured duration. Model-busy share uses the session's recorded window
and counts overlapping responses once. The Recorded window sparkline shows when
measured model responses or completed tools were active across that window;
overlapping work counts once. It remains unrecorded without measured intervals.
Peak responses counts overlapping measured model-response spans, including
subagent sessions.
Context usage compares each capture's peak context with its recorded model limit
and is unavailable when that limit changes during a capture.

Use **Open trace file** in the top bar, select the recordings, and choose **Open Traces**
on the **At the same time** tab. Automatic clock alignment preserves their wall-time
offsets, including for sequential runs. The table shows each session's
harness icon, provider and model together, effort, reported input/output tokens,
per-session token rate, context usage, and model-busy share. `/tracing start <name>`
supplies a variant label. Capture IDs
separate repeated recordings of the same Pi session; the table does not infer settings
from filenames or identify installed extensions automatically.

The timeline uses native process rows for real OS processes. When an agent maps
one-to-one to a process, its process labels appear on that row. Repeated captures
and agents sharing a process remain generic child groups; an agent without a
process association stays a generic group. Other overview charts aggregate all
loaded captures. The table shows each capture's recorded window separately, so gaps between
independent runs do not inflate these durations.
Cross-machine overlap depends on the machines' wall clocks being synchronized.
