# Pi / Claude Code diagnostic comparison

This experiment separates fixed work from agent decisions. It records real
harnesses using the same pinned model, user prompts and starting files, with
thinking disabled. Native system prompts and tool definitions remain in place.
It produces local traces and a report; it does not replace a UI example.

| Test | Required work | What to inspect |
| --- | --- | --- |
| Serial | Six dependent shell calls, then a JSON answer | Request latency, response overhead and extra turns with identical work |
| Parallel | Four separate shell calls submitted in one response | Whether the model batches calls and whether the harness actually overlaps them |
| Coding | Fix one function; add exactly four tests; stop after passing | Correctness, repair attempts, unnecessary work and output volume |
| Reviewer | One background reviewer reads two fixed files and returns JSON | Delegation, startup, collection and extra child turns |

The parallel probe explicitly waits one second per command. This is a scheduler
diagnostic, not a claim about real tool latency. Independent monotonic timestamps
inside the command processes measure concurrency without relying on trace mapping.
The serial probe supplies an unpredictable next key to require six dependent calls.
Protocol validation rejects file inspection, combined shell commands, missing work
and duplicate calls even when the final answer is correct.

The coding task has no subagent or shared-file race. An independent 500-case oracle
checks union duration, concurrency and input non-mutation. Original tests must stay
unchanged and output is bounded. The reviewer receives the same fixed task in both
harnesses, has only a read tool, and reads fixture files that no primary agent edits.
Pi uses the small [reviewer adapter](reviewer.ts); Claude uses a native custom Agent.

## Run

Use the installed Pi and Claude CLIs with their existing authentication:

```sh
python3 tools/experiments/harness-comparison/run.py --rounds 3
node_modules/.bin/bun tools/experiments/harness-comparison/analyse.ts artifacts/experiments/harness-comparison-<id>
```

The default model is `claude-haiku-4-5-20251001`. `--model`, `--cases serial parallel
coding reviewer`, `--rounds`, `--timeout` and `--output` can narrow or repeat the
experiment. The output directory must be new. Runs are sequential and alternate
which harness goes first; no failed run is silently replaced. A process failure
stops the batch with its artifacts intact. Incorrect answers and protocol deviations
remain in the results and do not stop subsequent pairs.

To include Pi codemode in the coding diagnostic:

```sh
python3 tools/experiments/harness-comparison/run.py --cases coding --rounds 3 \
  --variants pi pi-codemode claude-code
```

This uses codemode's `only` setting: the same read, edit, write and shell tools
are available through scripts. The user prompt and starting files stay identical.
Three variants rotate through all three execution positions across three rounds.
The report separates script wrappers from their nested tool calls and verifies
those counts against the trace. Codemode is limited to the coding diagnostic;
the other probes prescribe specific direct calls. Settings live in a temporary
agent directory, with an exact copy retained beside each Pi recording.

Resume an interrupted batch with `--resume BATCH`. This runs only absent attempts;
it never replaces a failed or nonconforming attempt. Missing finalized Pi traces
retain their spool under `capture-recovery/` for investigation. Capture failures
remain visible in the report even when the agent completed its task.

The runner creates a temporary Pi agent directory with links to installed auth/model
files. It does not copy credentials into the results or prune existing recordings.
Raw harness output, commands, input hashes, validations and traces are saved per run.

Open `traces/<case>-round-<N>.pftrace` in the updated local UI to compare one round,
or `<case>-all-rounds.pftrace` for every attempt. Packet sequence IDs are made unique;
original clocks, timestamps and event payloads are preserved.
Individual recordings in `traces/` include the harness, test and round in their
filenames, so they can also be selected together in the multi-file picker.
`RESULTS.md` gives medians and ranges alongside correctness and protocol counts;
`results.json` retains individual timings and capture checks.

## Interpreting results

- Fixed tests distinguish requested work from model deviations. A faster run that
  omits work is a failed attempt, not a speed win. Report all outcomes.
- Coding captures the combined effect of the model, harness prompts and tools.
  A repair loop alone does not prove a defect in harness implementation.
- Provider latency and prompt-cache state remain uncontrolled. Each CLI starts a
  fresh session; no warm-up run is silently discarded. Pi's first request-to-headers
  time is shown separately to expose initial latency.
- The timing breakdown joins Pi request-to-headers and response spans, while Claude
  reports whole native requests. These are approximate comparable intervals. Do not
  directly compare the UI's response-only tokens/s or model-busy fields across the
  two capture implementations yet.
- Uncovered time is unclassified. Tool work can overlap, and a reviewer collection
  tool may wait on child execution. Neither is automatically local overhead.
- Both recordings include tracing. This suite does not isolate tracing overhead;
  that requires a separate paired experiment with tracing disabled.
- Three pairs provide a diagnostic sample, not a general harness ranking. Reproduce
  a specific suspected issue before changing a harness or claiming a speedup.

## Validate the experiment

```sh
python3 -m unittest discover -s tools/experiments/harness-comparison -p 'test_*.py' -v
```

Analysis also checks trace import errors, loss counters, incomplete spans, native
usage, response/tool counts, the pinned model, and delegation flows. A capture
validation failure makes the analysis command fail while preserving its report.
