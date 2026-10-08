# Direct and codemode: CI failure audit

Two real Pi sessions audit the same 192 failed tests from a **synthetic CI API
replay**, using the identical [prompt](prompt.txt). Each makes 196 CI requests
to list failures and retrieve their histories, then classifies failures by
owner and reports the five slowest new failures. Both [answers](answers.json)
match the independent [expected result](expected.json).

Recorded on 2026-10-02 with Pi 1.0.0 and `anthropic/claude-opus-5` at high
effort. This offline fixture preserves both sessions.

Context categories were reconstructed at each request from the original saved
messages, system sections and tool definitions. They are marked as partial
transcript observations. Original timing, usage, tool calls and answers are unchanged.

| Measurement | Direct tools | Codemode |
| --- | ---: | ---: |
| Wall time, including process startup/exit | 216.4 s | 19.2 s |
| Recorded window | 215.8 s | 17.8 s |
| Output tokens | 23,140 | 1,229 |
| Peak context estimated in trace | 95,395 | 4,284 |
| Turns | 30 | 4 |
| CI requests | 196 | 196 |
| Bash calls | 13 | 0 |
| Scripts | 0 | 3 |

Both variants have the same CI tools and bash for local calculations, with up
to 16 requests in flight. Codemode exposes those tools through JavaScript
scripts with persistent state. Tool results are complete and no artificial
delays or failures are injected. Both answers are correct. Provider latency
and cache state were not controlled.

The trace bytes are unchanged from the original recordings. They include the
prompt, original tool arguments, JavaScript source and line counts, usage,
model metadata, and all 196 script-to-tool flow chains. Neither capture has
dropped events, lane overflows, incomplete operations, or import errors. The
scripted session has the generic `codemode` session label.

[recording.json](recording.json) records session identities, checksums, and
counts verified against the original Pi event streams. `tool-arguments.json`
retains the actual call inputs for offline checks; it does not infer intent or
modify the recordings. [snapshot.json](snapshot.json) contains the replay data.
Raw conversations and scratch files are excluded from the repository.

Input counters preserve the provider's uncached input usage: 62 tokens for the
direct session and 10 for codemode. Cache-read/write usage is retained separately
on response annotations; those input counters do not describe total prompt
volume.

`npm run trace:example` merges these sessions into the offline fixture
`artifacts/examples/agentprof-codemode-example.pftrace`. The UI now features
the [Pi and Claude Code comparison](../harness-comparison/README.md).
To record another comparison with your Pi credentials:

```sh
npm run trace:record-codemode -- --cases 192 --rounds 3
```

The runner checks every answer and request log, saves results under
`artifacts/experiments/`, and leaves the reviewed bundle for explicit updates.
Other extensions, skills, context files, prompt templates, and themes are
disabled. With `--no-extensions`, it explicitly adds `-e builtin:codemode`.
