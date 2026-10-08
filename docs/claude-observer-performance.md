# Claude in-process observer overhead

The Claude mod records a response BEGIN before starting the downstream generator,
but starts its first `next()` **before** awaiting the recovery checkpoint. The
first chunk is not yielded until that checkpoint completes. In particular,
model dispatch no longer waits for a whole-transcript `session.messages()` call.
A single detailed transcript baseline is collected when recording starts and
again after a completed compaction. Post-turn native usage summaries and
incremental counts from prompt, response and tool hooks supply later context
observations; these are partial `transcript-observed` measurements, not exact
request-input snapshots. Idle tools and renders do not checkpoint host state.
The write-ahead checkpoints surrounding each journal batch remain necessary
for interrupted-write recovery.

Run the synthetic local benchmark with:

```sh
bun tools/bench-claude-direct.mjs 30
```

It exercises the real mod hooks against an in-memory host at 0, 100, 1,000
and 5,000 synthetic retained messages, with either 0 or 5 ms simulated host
API latency. It prints per-case median/p95 time from hook entry to downstream
model start and first exposed chunk, plus host call counts. This is **not** a
production latency result; host API serialization, model/network work and real
Claude scheduling are not represented.

One Bun 1.4.2 run (30 steps per case) observed one `session.messages()` call
at capture start and **zero during the steps** for all history sizes. At 5,000
messages, dispatch median/p95 were 0.004/0.025 ms (0 ms host latency) and
0.010/0.037 ms (5 ms host latency). The corresponding first-yield median/p95
were 0.026/0.055 ms and 5.136/5.156 ms, respectively: the durability
checkpoint still gates the first exposed chunk. No fixed timing threshold is
enforced in CI; tests instead assert the call budget and checkpoint ordering.

Before the change a model step synchronously called `session.usage` and
`session.messages`, scanned and diffed the entire transcript, and awaited
`state.set` before `next(e)`. A focused diagnostic on 5,000 synthetic messages
measured about 22 ms just to start the downstream generator with zero host
latency; these single-run numbers and the benchmark above are not a controlled
before/after experiment. Validate with real Claude host p50/p95 measurements on
long sessions before making a production speed claim.
