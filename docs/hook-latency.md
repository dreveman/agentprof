# Command-hook overhead (synthetic local measurement)

Run `bun tools/bench-hook-latency.ts [rounds]` with Node 22+ on `PATH` to measure
new-process wall time for an empty Node process, a warm Codex hook against an
authenticated local HTTP receiver, and idle/recording Muse `PreLLMCall` hooks
against private temporary state. This does not call a model or load a real
session export; it is **not** a production latency SLA.

One Node 22.19.0 / Bun 1.4.2 run with 12 measured invocations per case:

| Synthetic hook | Median | p95 |
| --- | ---: | ---: |
| Bare Node process | 23.87 ms | 26.02 ms |
| Codex warm hook | 63.00 ms | 65.68 ms |
| Muse idle `PreLLMCall` | 35.74 ms | 36.58 ms |
| Muse recording `PreLLMCall` | 35.45 ms | 40.60 ms |

The Codex run made 13 `/hook` requests (one warm-up plus 12 samples) and **zero**
`/health` requests. Muse's ordinary hooks no longer take a second watcher
lock/read; the recording fixture models an already-live watcher. Startup
includes loading each bundled runtime; filesystem caches,
receiver state, machine load and the host's hook scheduling can change these
numbers. Repeat on a representative machine before claiming an end-user win.

Both harnesses currently expose command hooks, so every event still starts a
Node process. Codex's on-demand plugin recorder uses a private Unix socket
only while sessions are active; its installed profile has no native OTLP
endpoint. Removing the
remaining process startup needs either a supported persistent hook transport
from the host or a dedicated lightweight native client; neither is supplied by
the checked-in integration. The measured overhead justifies investigating that
transport separately rather than claiming it has been eliminated here.
