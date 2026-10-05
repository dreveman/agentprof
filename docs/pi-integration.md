# Pi tracing integration

The recorder lives in [packages/pi-tracing](../packages/pi-tracing/). It has a Pi
extension entry point, zero runtime npm dependencies, and an MIT license declaration.

## Recording

```bash
pi -e ./packages/pi-tracing --tracing
```

Normal Pi exit automatically finalizes the recording and prints its file path
to stderr, including in interactive and headless modes. Optionally use
`Ctrl+Shift+T` to manually start or stop recording.

Autostart also accepts `PI_TRACING=1`. Interactive commands include
`/tracing start [name]`, `/tracing stop`, `/tracing status`, and
`/tracing categories`. See the package README for configuration and inheritance.

Each top-level recording publishes one `.pftrace` and JSON manifest under
`<agentDir>/pi-tracing/`, including its local child processes. Children inherit
the recording directory; existing per-process writers flush private spools,
which the owner merges when tracing stops. Failed finalization retains spools
and any parseable `.pftrace.part`. The UI exposes dropped events, lane overflows, and incomplete
spans rather than treating truncated work as completed.

## Recorded data and validation

Capture metadata identifies the harness, model, effort, and session. Events carry
turn indices, tool IDs and outcomes, provider phases, context counts, stream
timings, and reported usage. Missing usage stays unknown. Content capture follows
the configured categories. REALTIME is the primary trace clock; tests verify
same-machine and cross-machine wall-time alignment, including multi-file imports.

The bundled example is a real Pi 0.87.1 parent with three Opus 5 subagents,
recorded through this extension on 2026-09-27. Implementation and test workers
run concurrently, followed by a reviewer and parent-side integration. All 39 tests
pass. All four traces finalize without incomplete operations or dropped events,
and cumulative usage matches Pi's JSON events. Native and browser checks validate
individual files and merged archives, including session identity, parent/child
links, context estimates, and timestamp offsets. The longer workflow exercises
periodic clock snapshots. The bundled example uses the same merge code as runtime
recordings, producing one trace with all three native delegation flows.
See [the recording notes](../examples/pi-opus-5/README.md) to reproduce it.

A separate synthetic fixture covers overlap, missing usage, and interrupted work.
The example does not exercise real retries or cancellation. See the
[data contract](trace-data.md) for field definitions and coverage limits.
