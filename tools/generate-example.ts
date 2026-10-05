// SPDX-License-Identifier: Apache-2.0
// Synthetic fixture: no model calls, credentials, or user content.
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultConfig } from "../packages/pi-tracing/extensions/pi-tracing/config.ts";
import { Recorder } from "../packages/pi-tracing/extensions/pi-tracing/tracer.ts";
import { assistantAnnotations } from "../packages/pi-tracing/extensions/pi-tracing/annotations.ts";
import {buildTracePacket, buildTrackEvent, framePacket, TRACK_EVENT_INSTANT} from
  "../packages/pi-tracing/extensions/pi-tracing/encoder.ts";
import {convertObservations as convertCodex} from '../packages/codex-tracing/convert.ts';
import {fixture as codexFixture} from '../packages/codex-tracing/fixture.ts';

const outDir = resolve("artifacts/examples");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'codex.pftrace'), convertCodex(codexFixture()).trace);
const config = defaultConfig();
config.sampleHz = 0;
config.finalizeDeadlineMs = 5000;
// Keep recorder retention from deleting named browser fixtures during rebuilds.
const recorder = new Recorder({ config, outDir: resolve(outDir, 'captures'), sessionTag: "example",
  identity: { pid: 1001, processName: "pi-example", labels: ["session:agentprof-example"],
    mainThread: {tid: 1001, name: "pi"} }, machineId: 101 });
recorder.setRunConfiguration({model: "opus-5", provider: "synthetic", effort: "high",
  contextWindowTokens: 200000});
const started = await recorder.start();
if (!started.started) throw new Error(started.message);
const tracks = recorder.trackSet()!;
// Bun may use a process-relative hrtime epoch. Let it advance before backfilling
// the synthetic run so every encoded timestamp is nonnegative.
await new Promise((resolve) => setTimeout(resolve, 4100));
const base = recorder.captureTimestamp() - 4_000_000_000n;
const at = (ms: number) => base + BigInt(ms) * 1_000_000n;
recorder.recordContextTokens(100, at(0));
const turn = recorder.beginSlice({cat: "agent", trackUuid: tracks.sessionUuid, name: "turn", tNs: at(0),
  annotations: {"kind": "turn", "index": 0}})!;
const provider = recorder.beginSlice({cat: "llm", trackUuid: tracks.providerUuid, name: "request", tNs: at(0),
  annotations: {"kind": "provider-request", "phase": "response-headers"}})!;
recorder.emitEnd(provider, {"status_code": 200}, at(200));
recorder.emitInstant({cat: "llm", trackUuid: tracks.providerUuid, name: "assistant", tNs: at(600),
  annotations: assistantAnnotations({model: "opus-5", provider: "synthetic", stopReason: "toolUse",
    usage: {input: 100, output: 20, cacheRead: 0}},
  {startNs: at(0), firstUpdateNs: at(250), updates: 4, bytes: 80}, at(600))});
recorder.recordTokenUsage({usage: {input: 100, output: 20, cacheRead: 0}}, at(600));
const first = recorder.beginToolSlice("example-read", "read", at(600), [123n])!;
recorder.emitInstant({cat: "tools", trackUuid: tracks.sessionUuid, name: "tool-preflight", annotations: {"name": "read"}, tNs: at(600) - 1n, flowIds: [123n]});
const second = recorder.beginToolSlice("example-bash", "bash", at(650))!;
recorder.emitEnd(first, {"is_error": false}, at(900));
recorder.emitEnd(second, {"is_error": true}, at(1200));
const child = recorder.beginWorkflowSlice("example-child", "launch subagent", {childSession: "example-child"}, at(1250))!;
recorder.emitEnd(child, undefined, at(1300));
recorder.emitEnd(turn, undefined, at(1500));
const nextTurn = recorder.beginSlice({cat: "agent", trackUuid: tracks.sessionUuid, name: "turn", tNs: at(1500),
  annotations: {"kind": "turn", "index": 1}})!;
recorder.recordContextTokens(260, at(1500));
const secondResponse = recorder.beginSlice({cat: "llm", trackUuid: tracks.responseUuid, name: "response", tNs: at(1500),
  annotations: {"kind": "assistant-message"}})!;
recorder.emitEnd(secondResponse, assistantAnnotations({model: "opus-5", provider: "synthetic", stopReason: "toolUse",
    usage: {input: 180, output: 45, cacheRead: 80}},
  {startNs: at(1500), firstUpdateNs: at(1650), updates: 8, bytes: 160}, at(2200)), at(2200));
recorder.recordTokenUsage({usage: {input: 180, output: 45, cacheRead: 80}}, at(2200));
const third = recorder.beginToolSlice("example-edit", "edit", at(2000))!;
recorder.emitEnd(third, {"is_error": false}, at(2400));
const fourth = recorder.beginToolSlice("example-test", "bash", at(2500))!;
recorder.emitEnd(fourth, {"is_error": false}, at(3000));
recorder.recordContextTokens(400, at(3000));
const thirdResponse = recorder.beginSlice({cat: "llm", trackUuid: tracks.responseUuid, name: "response", tNs: at(3000),
  annotations: {"kind": "assistant-message"}})!;
recorder.emitEnd(thirdResponse, assistantAnnotations({model: "opus-5", provider: "synthetic", stopReason: "stop"},
  {startNs: at(3000), firstUpdateNs: at(3100), updates: 3, bytes: 60}, at(3600)), at(3600));
// Missing usage/estimates do not fabricate zero-valued samples.
recorder.recordTokenUsage({}, at(3600));
recorder.recordContextTokens(null, at(3650));
recorder.emitEnd(nextTurn, undefined, at(3700));
// The final pre-compaction estimate can exceed the last sampled gauge value.
const compact = recorder.beginSlice({cat: "session", trackUuid: tracks.compactionUuid,
  name: "compact", tNs: at(3700), annotations: {"kind": "compaction",
    "reason": "threshold", "will_retry": false, "tokens_before": 450}})!;
recorder.recordPeakContextTokens(450);
recorder.invalidateContextTokens(at(3750));
recorder.emitEnd(compact, {"status": "success", "context_after_known": false}, at(3750));
// A later estimate restores the context gauge after the unknown interval.
recorder.recordContextTokens(120, at(3780));
// The final tool deliberately remains open to exercise incomplete handling.
recorder.beginToolSlice("example-incomplete", "unfinished", at(3800));
const manifest = await recorder.stop("example");
if (!manifest || manifest.shutdownTruncated) throw new Error("Example trace did not finalize");
const path = resolve(outDir, "synthetic.pftrace");
await copyFile(manifest.path, path);
// A separate fixture with a source clock that has no snapshot exercises the
// import-error indicator and its details page without changing the main example.
const badClock = buildTracePacket({seqId: 0x7ffffffe, machineId: 101,
  timestampNs: manifest.tEndNs, clockId: 64,
  trackEvent: buildTrackEvent({trackUuid: 99999999999n, categories: ["pi.agent"],
    type: TRACK_EVENT_INSTANT, name: "unresolved-clock"})});
await writeFile(resolve(outDir, "import-error.pftrace"),
  Buffer.concat([await readFile(path), framePacket(badClock)]));
console.log(path);
