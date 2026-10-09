// SPDX-License-Identifier: Apache-2.0
// OFF + RECORDING state machine. Recording appends
// complete Trace.packet field-1 records through one bounded asynchronous writer
// queue. Finalization is deadline-bounded, publishes only after successful
// drain/fsync/close, and otherwise leaves a repaired parseable .part.

import { constants as fsConstants, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { basename, dirname, join } from "node:path";

import {Recording} from "./recording.ts";
import {captureContentsEnabled} from '../../../agent-tracing/content.ts';

import type { CategoryId, TracingConfig } from "./config.ts";
import { SCHEMA_VERSION, TRACE_VERSION, reportedTokenUsage, tokenCount, runConfigurationAnnotations, type RunConfiguration } from "./annotations.ts";
import { currentMachineIdentity, fnv1a64 } from "./machine.ts";
import {
  CLOCK_PI_CUSTOM,
  TRACK_EVENT_BEGIN,
  TRACK_EVENT_COUNTER,
  TRACK_EVENT_END,
  TRACK_EVENT_INSTANT,
  buildTracePacket,
  buildTrackEvent,
  framePacket,
  type DebugAnnotationValue,
} from "./encoder.ts";
import {
  DEFAULT_COUNTERS,
  buildDescriptorPreamble,
  buildSnapshotPacket,
  buildToolLaneDescriptorPacket,
  buildWorkflowLaneDescriptorPacket,
  clockIdForProbe,
  counterTrackUuid,
  createTrackSet,
  randomSeqId,
  type ProcessIdentity,
  type ToolLaneAllocator,
  type TrackSet,
} from "./tracks.ts";

export type RecorderState = "OFF" | "STARTING" | "RECORDING" | "STOPPING";

export interface TraceManifest {
  path: string;
  bytes: number;
  packets: number;
  droppedEvents: number;
  laneOverflows: number;
  tStartNs: bigint;
  tEndNs: bigint;
  shutdownTruncated: boolean;
  reason: string;
  clockUncertaintyNs: bigint;
  /** Perfetto machine id stamped on every packet; zero means host-default. */
  machineId: number;
  error?: string;
  /** Parent-side record of child-agent launches observed while recording.
   * childSession is the detached session id when the tool result carried
   * one; the child's own trace file starts with its first 8 characters. */
  children: ChildLaunchRecord[];
  /** Public recording path when this process contributed a private spool. */
  recordingPath?: string;
  incompleteProcesses?: boolean;
}

export interface ChildLaunchRecord {
  task: string | null;
  childSession: string | null;
  correlation: string | null;
}

export interface NormalizedAttrs {
  [key: string]: DebugAnnotationValue;
}

export interface EndSummary {
  updates: number;
  bytes: number;
  durationNs: bigint;
}

interface OwnerRecord {
  schemaVersion: 1;
  pid: number;
  host: string;
  processStartMarker?: string;
  startedMs: number;
  token: string;
}

interface OpenSpan {
  trackUuid: bigint;
  beginNs: bigint;
  name: string;
  cat: string;
  updates: number;
  bytes: number;
  annotations?: NormalizedAttrs;
  deferredBegin?: {
    flowIds?: bigint[];
    annotations: NormalizedAttrs;
    record: Uint8Array;
    reservedBytes: number; // BEGIN plus a minimal END (including the longest timestamp).
  };
  laneKey?: string;
  laneAllocator?: ToolLaneAllocator;
}

interface EnqueueOptions {
  critical?: boolean;
}

interface EventRecordArgs {
  trackUuid: bigint;
  categories: string[];
  name?: string;
  type: number;
  counterValue?: bigint;
  debugAnnotations?: Record<string, DebugAnnotationValue>;
  flowIds?: bigint[];
  tNs: bigint;
}

const FLUSH_BATCH_BYTES = 64 * 1024;
const FLUSH_BATCH_RECORDS = 128;
const FINALIZE_RESERVE_BYTES = 64 * 1024;
const CRITICAL_RECORD_RESERVE = 128;
const MAX_TIMESTAMP_NS = (1n << 64n) - 1n;
const OWNER_GRACE_MS = 5 * 60 * 1000;
const CLOCK_RESNAPSHOT_NS = 60_000_000_000n;
const CLOCK_RESNAPSHOT_RETRY_NS = 1_000_000_000n;
const utf8 = new TextEncoder();
const runtimeIdentity = randomToken();

function nowSourceNs(): bigint {
  return process.hrtime.bigint();
}

function realtimeNowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export function boottimeNsForPlatform(
  platform: NodeJS.Platform,
  realtimeNs: bigint,
  uptimeSeconds: number,
): bigint {
  // Perfetto represents BOOTTIME as wall time on platforms such as macOS that
  // do not expose Linux CLOCK_BOOTTIME. Match that convention exactly.
  if (platform !== "linux") return realtimeNs;
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new Error("system uptime clock unavailable");
  }
  return BigInt(Math.round(uptimeSeconds * 1e9));
}

// Bun's os.uptime() rounds to seconds. Read Linux's fractional boot clock
// directly so independent files do not acquire a whole-second alignment error.
export function linuxUptimeReading(
  readText = () => readFileSync("/proc/uptime", "utf8"),
  fallback = uptime,
): { seconds: number; resolutionNs: bigint } {
  try {
    const seconds = Number(readText().trim().split(/\s+/)[0]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { seconds, resolutionNs: 10_000_000n };
    }
  } catch { /* Fall back when procfs is unavailable. */ }
  return { seconds: fallback(), resolutionNs: 1_000_000_000n };
}

export function captureClockReadings(): {
  sourceNs: bigint;
  boottimeNs: bigint;
  realtimeNs: bigint;
  uncertaintyNs: bigint;
} {
  const sourceBefore = nowSourceNs();
  const realtimeBefore = realtimeNowNs();
  const boot = process.platform === "linux" ? linuxUptimeReading() : {seconds: 0, resolutionNs: 0n};
  const realtimeAfter = realtimeNowNs();
  const sourceAfter = nowSourceNs();
  const realtimeNs = realtimeBefore + (realtimeAfter - realtimeBefore) / 2n;
  const samplingUncertainty = (sourceAfter - sourceBefore) / 2n;
  const realtimeDelta =
    realtimeAfter >= realtimeBefore
      ? realtimeAfter - realtimeBefore
      : realtimeBefore - realtimeAfter;
  const realtimeUncertainty = realtimeDelta / 2n;
  // Values are recorded at the lower edge of their quantization bucket; sum
  // the independent bounds instead of presenting their maximum as a bound.
  const quantizationUncertainty =
    boot.resolutionNs + 1_000_000n;
  const uncertaintyNs =
    quantizationUncertainty + samplingUncertainty + realtimeUncertainty;
  return {
    sourceNs: sourceBefore + (sourceAfter - sourceBefore) / 2n,
    boottimeNs: boottimeNsForPlatform(process.platform, realtimeNs, boot.seconds),
    realtimeNs,
    uncertaintyNs,
  };
}

function randomToken(): string {
  return randomBytes(8).toString("hex");
}

function safeHost(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function processStartMarker(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    // Remaining fields begin at proc stat field 3. starttime is field 22.
    return text.slice(close + 1).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

export type PartOwnerStatus = "live" | "dead" | "unknown";

/** Liveness of a `.pftrace.part` writer for child-watch state classification.
 * `live`: owner pid (and start marker, on Linux) still matches. `dead`:
 * owner provably gone. `unknown`: no owner sidecar, foreign host, or the
 * check itself failed — callers fall back to mtime staleness. */
export async function partOwnerStatus(partPath: string): Promise<PartOwnerStatus> {
  let raw: string;
  try {
    raw = await readFile(`${partPath}.owner.json`, "utf8");
  } catch {
    return "unknown";
  }
  let owner: OwnerRecord;
  try {
    owner = JSON.parse(raw) as OwnerRecord;
  } catch {
    return "unknown";
  }
  if (typeof owner.pid !== "number" || typeof owner.host !== "string") return "unknown";
  try {
    return (await ownerIsActive(owner)) ? "live" : "dead";
  } catch {
    return "unknown";
  }
}

async function ownerIsActive(owner: OwnerRecord): Promise<boolean> {
  // A shared home can expose captures from another host. PID checks are only
  // meaningful locally, so preserve foreign-host captures as potentially live.
  if (owner.host !== safeHost()) return true;
  if (!pidExists(owner.pid)) return false;
  if (owner.processStartMarker === undefined) return true;
  return (await processStartMarker(owner.pid)) === owner.processStartMarker;
}

function decodeVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < bytes.length && shift <= 49; i++) {
    const byte = bytes[i];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

/** Trim only an incomplete tail using bounded sequential reads. Every valid
 * record is Trace.packet field 1 (tag 0x0a) + varint length + packet bytes. */
export async function repairPartFile(path: string): Promise<number> {
  const handle = await open(path, "r+");
  try {
    const size = (await handle.stat()).size;
    const chunk = new Uint8Array(64 * 1024);
    let fileOffset = 0;
    let carry = new Uint8Array(0);
    let committed = 0;
    let invalid = false;
    while (fileOffset < size && !invalid) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, fileOffset);
      if (bytesRead === 0) break;
      const combined = new Uint8Array(carry.length + bytesRead);
      combined.set(carry, 0);
      combined.set(chunk.subarray(0, bytesRead), carry.length);
      const combinedFileStart = fileOffset - carry.length;
      let local = 0;
      while (local < combined.length) {
        if (combined[local] !== 0x0a) {
          invalid = true;
          break;
        }
        const length = decodeVarint(combined, local + 1);
        if (length === null) break;
        const end = length.next + length.value;
        if (end > combined.length) break;
        local = end;
        committed = combinedFileStart + local;
      }
      carry = combined.slice(local);
      // Current packets are small; reject pathological/corrupt length prefixes
      // rather than retaining unbounded carry while repairing at startup.
      if (carry.length > 16 * 1024 * 1024) invalid = true;
      fileOffset += bytesRead;
    }
    if (committed < size) await handle.truncate(committed);
    return committed;
  } finally {
    await handle.close();
  }
}

/** Metadata-only executable summary. Never returns assignments, quoted tokens,
 * substitutions, or shell punctuation. `env NAME=value cmd` resolves to cmd. */
export function sanitizeArgv0(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (tokens[i] === "env") {
    i++;
    while (i < tokens.length) {
      const token = tokens[i] ?? "";
      if (token === "-u" || token === "--unset") {
        i += 2;
        continue;
      }
      if (token.startsWith("-")) {
        i++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        i++;
        continue;
      }
      break;
    }
  } else {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
  }
  const token = tokens[i] ?? "";
  if (token === "" || token.includes("=") || !/^[A-Za-z0-9_./:+-]+$/.test(token)) return "<redacted>";
  return token.slice(0, 80);
}

export class Recorder {
  private state: RecorderState = "OFF";
  private recording: Recording | null = null;
  private recordingWatch: ReturnType<typeof setInterval> | null = null;
  private readonly collectChildren: boolean;
  private readonly inheritedRecording?: string;
  private inputTokens = 0n;
  private outputTokens = 0n;
  private peakContextTokens: number | null = null;
  private readonly sampledCounters = new Set<string>();
  private runAttributes = runConfigurationAnnotations({});
  private configurationOpen = false;
  private config: TracingConfig;
  private readonly outDir: string;
  private readonly sessionTag: string;
  private readonly identity: ProcessIdentity;
  private readonly captureAnnotations: NormalizedAttrs;
  private readonly machineId: number;
  private probePassedMonotonic = false;

  private tracks: TrackSet | null = null;
  private seqId = 0;
  private clockId = CLOCK_PI_CUSTOM;
  private partPath: string | null = null;
  private ownerPath: string | null = null;
  private fileHandle: FileHandle | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private queuedRecords = 0;
  private queuedBytes = 0;
  private acceptedBytes = 0;
  // Deferred BEGINs live in memory rather than the writer queue. Account for
  // them and their closing ENDs before admitting any more ordinary packets.
  private deferredBytes = 0;
  private deferredRecords = 0;
  private packetsWritten = 0;
  private bytesWritten = 0;
  private droppedEvents = 0;
  private fileLimitReached = false;
  private writeFailure: Error | null = null;
  private writerCancelled = false;
  private writeChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<{ started: boolean; message: string }> | null = null;
  private startCancelled = false;
  private stopPromise: Promise<TraceManifest | null> | null = null;
  private tStartNs = 0n;
  private nextSpanId = 1;
  private profileIndex = 0;
  private readonly openSpans = new Map<number, OpenSpan>();
  private sampler: ReturnType<typeof setInterval> | null = null;
  private lastCpu = process.cpuUsage();
  private nextClockSnapshotRealtimeNs = 0n;
  private lastClockUncertaintyNs = 0n;
  private lastTrace: TraceManifest | null = null;
  private configError: string | null = null;
  private childLaunches: ChildLaunchRecord[] = [];

  constructor(args: {
    config: TracingConfig;
    outDir: string;
    sessionTag: string;
    identity: ProcessIdentity;
    captureAnnotations?: NormalizedAttrs;
    /** Opt in to a single recording shared with local descendant processes. */
    collectChildren?: boolean;
    recordingDirectory?: string;
    /** Deterministic override for embedding/tests; normal callers resolve the
     * current boot-scoped machine identity automatically. */
    machineId?: number;
  }) {
    this.config = args.config;
    this.collectChildren = args.collectChildren === true;
    this.inheritedRecording = args.recordingDirectory;
    this.outDir = args.outDir;
    this.sessionTag = args.sessionTag;
    this.identity = args.identity;
    this.captureAnnotations = args.captureAnnotations ?? {};
    const machineId = args.machineId ?? currentMachineIdentity().id;
    if (!Number.isInteger(machineId) || machineId < 0 || machineId > 0xffffffff) {
      throw new Error("pi-tracing: machine id must be a uint32");
    }
    this.machineId = machineId;
  }

  getState(): RecorderState {
    return this.state;
  }

  isRecording(): boolean {
    return this.state === "RECORDING";
  }

  setConfig(config: TracingConfig): void {
    this.config = config;
    if (this.state === "RECORDING") this.startSampler();
  }

  getConfig(): TracingConfig {
    return this.config;
  }

  setConfigError(message: string | null): void {
    this.configError = message;
  }

  getConfigError(): string | null {
    return this.configError;
  }

  setProbePassedMonotonic(passed: boolean): void {
    this.probePassedMonotonic = passed;
  }

  getLastTrace(): TraceManifest | null {
    return this.lastTrace;
  }

  getRecordingDirectory(): string | undefined {return this.recording?.directory;}
  getRecordingPath(): string | undefined {return this.recording?.output;}

  getMachineId(): number {
    return this.machineId;
  }

  /** Capture a source timestamp only after refreshing an overdue clock map.
   * Callers that pass explicit tNs values back into Recorder methods must use
   * this helper so post-suspend events cannot precede their new snapshot. */
  captureTimestamp(): bigint {
    this.maybeEnqueueClockSnapshot();
    return nowSourceNs();
  }

  /** Parent-side launches observed in the current generation. Bounded: keeps
   * the most recent 256; older entries are dropped with the dropped counter. */
  noteChildLaunch(record: ChildLaunchRecord): void {
    if (this.childLaunches.length >= 256) {
      this.childLaunches.shift();
      this.droppedEvents++;
    }
    this.childLaunches.push(record);
  }

  getChildLaunches(): ChildLaunchRecord[] {
    return [...this.childLaunches];
  }

  getStats(): {
    pending: number;
    queuedBytes: number;
    packets: number;
    dropped: number;
    openSpans: number;
    laneOverflows: number;
    fileLimitReached: boolean;
    childLaunches: number;
    writeError?: string;
  } {
    return {
      pending: this.queuedRecords,
      queuedBytes: this.queuedBytes,
      packets: this.packetsWritten,
      dropped: this.droppedEvents,
      openSpans: this.openSpans.size,
      laneOverflows: this.tracks?.lanes.overflows ?? 0,
      fileLimitReached: this.fileLimitReached,
      childLaunches: this.childLaunches.length,
      writeError: this.writeFailure?.message,
    };
  }

  categoryOn(cat: CategoryId): boolean {
    return this.state === "RECORDING" && this.config.categories[cat] === true;
  }

  start(name?: string, outputPath?: string): Promise<{ started: boolean; message: string }> {
    if (this.state === "STARTING" && this.startPromise !== null) return this.startPromise;
    if (this.state !== "OFF") return Promise.resolve({ started: false, message: `cannot start while ${this.state.toLowerCase()}` });
    if (outputPath !== undefined && this.inheritedRecording !== undefined) {
      return Promise.resolve({started: false, message: "child captures use the owner recording path"});
    }
    if (outputPath !== undefined && !this.collectChildren) {
      return Promise.resolve({started: false, message: "custom output paths require a merged recording"});
    }
    this.state = "STARTING";
    this.startCancelled = false;
    const task = this.doStart(name, outputPath).finally(() => {
      this.startPromise = null;
    });
    this.startPromise = task;
    return task;
  }

  private async doStart(name?: string, outputPath?: string): Promise<{ started: boolean; message: string }> {
    let succeeded = false;
    try {
      await mkdir(this.outDir, { recursive: true });
      this.throwIfStartCancelled();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const slug = (name ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
      const suffix = `${process.pid}-${randomToken()}`;
      const base = slug.length > 0 ? `${this.sessionTag}-${stamp}-${suffix}-${slug}` : `${this.sessionTag}-${stamp}-${suffix}`;
      this.recording = this.inheritedRecording !== undefined
        ? await Recording.join(this.inheritedRecording)
        : this.collectChildren ? await Recording.create(this.outDir, base, outputPath) : null;
      this.partPath = join(this.recording?.directory ?? this.outDir, `${base}.pftrace.part`);
      this.ownerPath = `${this.partPath}.owner.json`;
      this.fileHandle = await open(this.partPath, "wx", 0o600);
      this.throwIfStartCancelled();
      const owner: OwnerRecord = {
        schemaVersion: 1,
        pid: process.pid,
        host: safeHost(),
        processStartMarker: await processStartMarker(process.pid),
        startedMs: Date.now(),
        token: randomToken(),
      };
      await writeFile(this.ownerPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.throwIfStartCancelled();

      // Keep OS track UUIDs stable across captures. New UUIDs for the same TID
      // would tell Perfetto that the OS reused that thread ID for a new thread.
      const processKey = `pi-tracing:${this.machineId}:${this.identity.pid}:${await processStartMarker(this.identity.pid) ?? runtimeIdentity}`;
      this.tracks = createTrackSet(this.config.laneCap, {
        processUuid: fnv1a64(`${processKey}:process`) || 1n,
        threadUuid: this.identity.mainThread === undefined ? undefined
          : fnv1a64(`${processKey}:thread:${this.identity.mainThread.tid}`) || 2n,
      });
      this.seqId = randomSeqId();
      this.clockId = clockIdForProbe(this.probePassedMonotonic);
      this.pending = [];
      this.pendingBytes = 0;
      this.queuedRecords = 0;
      this.queuedBytes = 0;
      this.acceptedBytes = 0;
      this.deferredBytes = 0;
      this.deferredRecords = 0;
      this.packetsWritten = 0;
      this.bytesWritten = 0;
      this.droppedEvents = 0;
      this.childLaunches = [];
      this.fileLimitReached = false;
      this.writeFailure = null;
      this.writerCancelled = false;
      this.writeChain = Promise.resolve();
      this.openSpans.clear();
      // Never reset nextSpanId: stale outer references from an earlier
      // generation cannot alias a newly-created span.

      const clock = captureClockReadings();
      this.tStartNs = clock.sourceNs;
      this.lastClockUncertaintyNs = clock.uncertaintyNs;
      this.nextClockSnapshotRealtimeNs = clock.realtimeNs + CLOCK_RESNAPSHOT_NS;

      // Clock path first, then all static descriptors, then events.
      if (!this.enqueueBytes(
        buildSnapshotPacket({
          seqId: this.seqId,
          machineId: this.machineId,
          sourceClockId: this.clockId,
          sourceNs: clock.sourceNs,
          boottimeNs: clock.boottimeNs,
          realtimeNs: clock.realtimeNs,
        }),
        { critical: true },
      )) throw new Error("could not queue clock snapshot");
      for (const record of buildDescriptorPreamble({
        tracks: this.tracks,
        identity: this.identity,
        seqId: this.seqId,
        machineId: this.machineId,
        clockId: this.clockId,
        nowNs: clock.sourceNs,
        counterSpecs: DEFAULT_COUNTERS,
      })) {
        if (!this.enqueueBytes(record, { critical: true })) throw new Error("could not queue descriptor preamble");
      }
      this.flushPending();
      await this.writeChain;
      this.throwIfStartCancelled();
      if (this.writeFailure !== null) throw this.writeFailure;

      if (this.recording !== null && !this.recording.active()) throw new Error("parent recording stopped during startup");
      this.state = "RECORDING";
      if (this.recording !== null && !this.recording.owner) {
        this.recordingWatch = setInterval(() => {
          if (this.isRecording() && !this.recording?.active()) void this.stop("parent-recording-stop");
        }, 50);
        this.recordingWatch.unref?.();
      }
      this.inputTokens = 0n;
      this.outputTokens = 0n;
      this.peakContextTokens = null;
      this.emitCounter("llm.tokens.input", 0n, this.tStartNs);
      this.emitCounter("llm.tokens.output", 0n, this.tStartNs);
      const initialWindow = tokenCount(this.runAttributes["context_window_tokens"]);
      if (initialWindow !== undefined && initialWindow > 0) {
        this.emitCounter("llm.context.window_tokens", initialWindow, this.tStartNs);
      }
      const captureStarted = this.enqueueEvent({
        trackUuid: this.tracks.sessionUuid,
        categories: ["pi.metadata"],
        name: `profile (${this.profileIndex + 1})`,
        type: TRACK_EVENT_BEGIN,
        debugAnnotations: {
          ...this.captureAnnotations,
          "kind": "capture",
          "schema_version": SCHEMA_VERSION,
          "recorder_version": TRACE_VERSION,
          ...this.runAttributes,
          "capture_id": this.tracks.rootUuid.toString(16),
          "session_id": this.identity.labels.find(label => label.startsWith("session:"))?.slice(8) ?? this.sessionTag,
          ...(name?.trim() ? { "label": name.trim().slice(0, 200) } : {}),
          "machine_id": this.machineId,
          "clock": "REALTIME",
          "clock_uncertainty_ns": Number(clock.uncertaintyNs),
          "categories": Object.entries(this.config.categories)
            .filter(([, enabled]) => enabled).map(([name]) => name).join(","),
          "tool_arguments": this.config.captureContents && this.config.categories.contents &&
            captureContentsEnabled(process.env.AGENTPROF_CAPTURE_CONTENTS),
        },
        tNs: this.tStartNs,
      }, true);
      if (!captureStarted) throw new Error("could not queue capture span");
      this.profileIndex++;
      this.lastCpu = process.cpuUsage();
      this.startSampler();
      succeeded = true;
      return { started: true, message: `recording to ${basename(this.partPath)}` };
    } catch (error) {
      return { started: false, message: `could not start capture: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (!succeeded) {
        await this.recording?.close().catch(() => {});
        this.stopSampler();
        this.flushPending();
        await this.writeChain.catch(() => {});
        await this.closeHandle();
        if (this.partPath !== null) await rm(this.partPath, { force: true }).catch(() => {});
        await this.removeOwner();
        this.resetGeneration();
        this.state = "OFF";
        this.startCancelled = false;
      }
    }
  }

  private throwIfStartCancelled(): void {
    if (this.startCancelled) throw new Error("start cancelled by stop/shutdown");
  }

  stop(reason: string): Promise<TraceManifest | null> {
    if (this.stopPromise !== null) return this.stopPromise;
    const deadlineAt = Date.now() + this.config.finalizeDeadlineMs;
    const task = (async (): Promise<TraceManifest | null> => {
      if (this.state === "STARTING") {
        this.startCancelled = true;
        const starting = this.startPromise;
        if (starting !== null && !(await completesBy(starting, deadlineAt))) return null;
      }
      if (this.state !== "RECORDING") return null;
      const recording = this.recording;
      if (recording?.owner) await recording.close();
      const manifest = await this.finalize(reason, deadlineAt);
      if (manifest === null || recording === null) return manifest;
      if (!recording.owner) {
        manifest.recordingPath = recording.output;
        return manifest;
      }
      try {
        let assemblyError: unknown;
        const assembly = recording.publish(manifest.path, this.config.maxFileMB * 1024 * 1024, deadlineAt)
          .catch((error: unknown) => {assemblyError = error; throw error;});
        if (!(await completesBy(assembly, deadlineAt))) {
          recording.cancelPublication();
          throw assemblyError ?? new Error("recording merge deadline exceeded");
        }
        const merged = await assembly;
        manifest.path = recording.output;
        manifest.bytes = merged.bytes.length;
        manifest.packets = merged.packets;
        manifest.tStartNs = merged.startNs;
        manifest.tEndNs = merged.endNs;
        manifest.incompleteProcesses = merged.incomplete;
        if (!(await completesBy(Promise.all([writeManifest(manifest), fsyncDirectory(dirname(manifest.path))]), deadlineAt))) {
          manifest.error = "recording published; metadata durability deadline exceeded";
        }
        void this.enforceRetention();
      } catch (error) {
        manifest.shutdownTruncated = true;
        const message = error instanceof Error ? error.message : String(error);
        manifest.error = `${manifest.error ? manifest.error + "; " : ""}recording assembly: ${message}; process spools retained in ${recording.directory}`;
      }
      this.lastTrace = manifest;
      return manifest;
    })();
    this.stopPromise = task.finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async shutdownFinalize(reason = "shutdown"): Promise<TraceManifest | null> {
    return this.stop(`session-${reason}`);
  }

  /** Quarantine only provably abandoned captures. Live owners are untouched;
   * recent ownerless files are retained to avoid racing file/owner creation. */
  async recoverParts(): Promise<string[]> {
    const notes: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.outDir);
    } catch {
      return notes;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const entry of entries) {
      if (!entry.endsWith(".pftrace.part")) continue;
      const part = join(this.outDir, entry);
      const ownerPath = `${part}.owner.json`;
      let owner: OwnerRecord | null = null;
      try {
        owner = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerRecord;
      } catch {
        owner = null;
      }
      if (owner !== null && (await ownerIsActive(owner))) {
        notes.push(`left live capture untouched: ${entry} (pid ${owner.pid})`);
        continue;
      }
      if (owner === null) {
        try {
          const info = await stat(part);
          if (Date.now() - info.mtimeMs < OWNER_GRACE_MS) {
            notes.push(`left recent ownerless capture untouched: ${entry}`);
            continue;
          }
        } catch {
          continue;
        }
      }
      const quarantined = join(this.outDir, entry.replace(/\.pftrace\.part$/, `.quarantined-${stamp}.part`));
      try {
        await repairPartFile(part);
        await rename(part, quarantined);
        await rm(ownerPath, { force: true });
        notes.push(`quarantined abandoned part: ${entry} -> ${basename(quarantined)}`);
      } catch {
        notes.push(`abandoned part retained (quarantine failed): ${entry}`);
      }
    }
    for (const entry of entries) {
      // Orphaned sidecar temp files from processes that exited mid-publish.
      if (!entry.endsWith(".tmp")) continue;
      const tempPath = join(this.outDir, entry);
      try {
        const info = await stat(tempPath);
        if (Date.now() - info.mtimeMs < OWNER_GRACE_MS) continue;
        await rm(tempPath, { force: true });
        notes.push(`removed stale sidecar temp file: ${entry}`);
      } catch {
        // Best effort; a leftover .tmp is harmless.
      }
    }
    return notes;
  }

  beginSlice(args: { cat: CategoryId; additionalCategories?: CategoryId[]; trackUuid: bigint; name: string; tNs?: bigint; flowIds?: bigint[]; annotations?: Record<string, DebugAnnotationValue> }): number | null {
    if (!this.categoryOn(args.cat) || this.tracks === null) return null;
    const tNs = args.tNs ?? this.captureTimestamp();
    const spanId = this.nextSpanId++;
    const accepted = this.enqueueEvent({
      trackUuid: args.trackUuid,
      categories: [args.cat, ...(args.additionalCategories ?? []).filter(cat => this.categoryOn(cat))].map(cat => `pi.${cat}`),
      name: args.name,
      type: TRACK_EVENT_BEGIN,
      flowIds: args.flowIds,
      debugAnnotations: args.annotations,
      tNs,
    });
    if (!accepted) return null;
    this.openSpans.set(spanId, {
      trackUuid: args.trackUuid,
      beginNs: tNs,
      name: args.name,
      cat: args.cat,
      updates: 0,
      bytes: 0,
    });
    return spanId;
  }

  beginToolSlice(toolCallId: string, name: string, tNs?: bigint, flowIds?: bigint[],
    options: {category?: "tools" | "workflow"; kind?: "script" | "model-call"; annotations?: NormalizedAttrs; deferBegin?: boolean} = {}): number | null {
    const category = options.category ?? "tools";
    if (!this.categoryOn(category) || this.tracks === null) return null;
    const lane = this.tracks.lanes.alloc(toolCallId);
    if (lane === null) {
      this.droppedEvents++;
      return null;
    }
    const started = tNs ?? this.captureTimestamp();
    if (lane.isNew) {
      const described = this.enqueueBytes(
        buildToolLaneDescriptorPacket({
          tracks: this.tracks,
          lane,
          seqId: this.seqId,
          machineId: this.machineId,
          clockId: this.clockId,
          nowNs: started,
        }),
      );
      if (!described) {
        this.tracks.lanes.free(toolCallId);
        return null;
      }
      this.tracks.lanes.markDescribed(lane.lane);
    }
    const spanId = this.nextSpanId++;
    const annotations = {...options.annotations, kind: options.kind ?? "tool-execution", call_id: toolCallId, name};
    const beginArgs: EventRecordArgs = {
      trackUuid: lane.uuid, categories: [`pi.${category}`], name,
      type: TRACK_EVENT_BEGIN, flowIds, debugAnnotations: annotations, tNs: started,
    };
    let deferredBegin: OpenSpan["deferredBegin"];
    if (options.deferBegin) {
      try {
        const record = this.encodeEvent(beginArgs);
        // Reserve enough for an END even if the clock's varint grows before
        // this call finishes. Dynamic result annotations are best-effort.
        const endBytes = this.encodeEvent({
          trackUuid: lane.uuid, categories: [], type: TRACK_EVENT_END,
          tNs: MAX_TIMESTAMP_NS,
        }).length;
        const reservedBytes = record.length + endBytes;
        if (this.fitsDeferred(reservedBytes, 2)) {
          this.deferredBytes += reservedBytes;
          this.deferredRecords += 2;
          deferredBegin = {flowIds: flowIds?.slice(), annotations, record, reservedBytes};
        }
      } catch { /* Malformed annotations or flow ids: drop only this span. */ }
    }
    // Reserve the lane now; child session IDs may only arrive in the result.
    const accepted = options.deferBegin
      ? deferredBegin !== undefined
      : this.enqueueEvent(beginArgs);
    if (!accepted) {
      if (options.deferBegin) this.droppedEvents++;
      this.tracks.lanes.free(toolCallId);
      return null;
    }
    this.openSpans.set(spanId, {
      trackUuid: lane.uuid,
      beginNs: started,
      name,
      cat: category,
      updates: 0,
      bytes: 0,
      deferredBegin,
      laneKey: toolCallId,
      laneAllocator: this.tracks.lanes,
    });
    return spanId;
  }

  /** Parent-side span for one child-agent launch/delegate tool call. Mirrors
   * beginToolSlice on the workflow lane pool so parallel launches nest
   * correctly. Returns null when the workflow category is off or lanes are
   * exhausted (counted, never blocking). */
  beginWorkflowSlice(key: string, name: string, annotations?: NormalizedAttrs, tNs?: bigint): number | null {
    if (!this.categoryOn("workflow") || this.tracks === null) return null;
    const lane = this.tracks.workflowLanes.alloc(key);
    if (lane === null) {
      this.droppedEvents++;
      return null;
    }
    const started = tNs ?? this.captureTimestamp();
    if (lane.isNew) {
      const described = this.enqueueBytes(
        buildWorkflowLaneDescriptorPacket({
          tracks: this.tracks,
          lane,
          seqId: this.seqId,
          machineId: this.machineId,
          clockId: this.clockId,
          nowNs: started,
        }),
      );
      if (!described) {
        this.tracks.workflowLanes.free(key);
        return null;
      }
      this.tracks.workflowLanes.markDescribed(lane.lane);
    }
    const spanId = this.nextSpanId++;
    const accepted = this.enqueueEvent({
      trackUuid: lane.uuid,
      categories: ["pi.workflow"],
      name,
      type: TRACK_EVENT_BEGIN,
      debugAnnotations: annotations,
      tNs: started,
    });
    if (!accepted) {
      this.tracks.workflowLanes.free(key);
      return null;
    }
    this.openSpans.set(spanId, {
      trackUuid: lane.uuid,
      beginNs: started,
      name,
      cat: "workflow",
      updates: 0,
      bytes: 0,
      laneKey: key,
      laneAllocator: this.tracks.workflowLanes,
    });
    return spanId;
  }

  accumulate(spanId: number, bytes: number): void {
    const span = this.openSpans.get(spanId);
    if (span === undefined) return;
    span.updates++;
    span.bytes += Math.max(0, bytes);
  }

  /** Link a subsequently observed child to this span's original BEGIN. */
  addBeginFlow(spanId: number, flowId: bigint): void {
    const span = this.openSpans.get(spanId);
    const begin = span?.deferredBegin;
    if (span === undefined || begin === undefined) return;
    const flowIds = [...(begin.flowIds ?? []), flowId];
    try {
      const record = this.encodeEvent({
        trackUuid: span.trackUuid, categories: [`pi.${span.cat}`], name: span.name,
        type: TRACK_EVENT_BEGIN, tNs: span.beginNs,
        debugAnnotations: begin.annotations, flowIds,
      });
      const growth = record.length - begin.record.length;
      if (this.fitsDeferred(growth, 0)) {
        this.deferredBytes += growth;
        begin.reservedBytes += growth;
        begin.flowIds = flowIds;
        begin.record = record;
        return;
      }
    } catch { /* Invalid flow id: keep the already reserved BEGIN. */ }
    this.droppedEvents++;
  }

  /** Attach observations to an open span; they are written with its END. */
  annotateSpan(spanId: number, annotations: NormalizedAttrs): boolean {
    const span = this.openSpans.get(spanId);
    if (span === undefined) return false;
    span.annotations = {...span.annotations, ...annotations};
    return true;
  }

  emitEnd(spanId: number, extra?: NormalizedAttrs, tNs?: bigint, beginFlowIds?: bigint[]): EndSummary | null {
    const span = this.openSpans.get(spanId);
    if (span === undefined || this.tracks === null) return null;
    const endedNs = tNs ?? this.captureTimestamp();
    const endArgs: EventRecordArgs = {
      trackUuid: span.trackUuid,
      categories: [],
      type: TRACK_EVENT_END,
      debugAnnotations: {...span.annotations,
        ...(span.laneAllocator === this.tracks.lanes ? {
          "updates": span.updates,
          "bytes": span.bytes,
        } : {}), ...extra},
      tNs: endedNs,
    };
    if (span.deferredBegin !== undefined) {
      const begin = span.deferredBegin;
      let beginRecord = begin.record;
      if (beginFlowIds?.length) {
        try {
          beginRecord = this.encodeEvent({
            trackUuid: span.trackUuid, categories: [`pi.${span.cat}`], name: span.name,
            type: TRACK_EVENT_BEGIN, tNs: span.beginNs,
            debugAnnotations: begin.annotations,
            flowIds: [...(begin.flowIds ?? []), ...beginFlowIds],
          });
        } catch { /* Fall back to the reserved BEGIN. */ }
      }
      let endRecord: Uint8Array | undefined;
      try { endRecord = this.encodeEvent(endArgs); } catch { /* Keep the operation, not its malformed annotations. */ }
      if (endRecord === undefined || !this.fitsDeferred(
        beginRecord.length + endRecord.length - begin.reservedBytes, 0,
      )) {
        // Late flows and result content can grow beyond the reservation.
        // Prefer the original full BEGIN (including captured arguments), then
        // a minimal END. Never strand a critical half-slice or poison the file.
        beginRecord = begin.record;
        try { endRecord = this.encodeEvent({...endArgs, debugAnnotations: undefined}); }
        catch { endRecord = undefined; }
        this.droppedEvents++;
      }
      const fits = endRecord !== undefined && this.fitsDeferred(
        beginRecord.length + endRecord.length - begin.reservedBytes, 0,
      );
      this.deferredBytes -= begin.reservedBytes;
      this.deferredRecords -= 2;
      span.deferredBegin = undefined;
      if (!fits || !this.enqueueBytes(beginRecord, {critical: true}) ||
        !this.enqueueBytes(endRecord!, {critical: true})) {
        this.droppedEvents++;
        this.releaseSpan(spanId, span);
        return null;
      }
    } else if (!this.enqueueEvent(endArgs, true)) {
      return null;
    }
    this.releaseSpan(spanId, span);
    return { updates: span.updates, bytes: span.bytes, durationNs: endedNs - span.beginNs };
  }

  private releaseSpan(spanId: number, span: OpenSpan): void {
    this.openSpans.delete(spanId);
    if (span.laneKey !== undefined && span.laneAllocator !== undefined) {
      span.laneAllocator.free(span.laneKey);
    } else if (span.laneKey !== undefined && this.tracks !== null) {
      // Legacy spans predate the allocator reference; free from the tool pool.
      this.tracks.lanes.free(span.laneKey);
    }
  }

  emitInstant(args: { cat: CategoryId; trackUuid: bigint; name: string; tNs?: bigint; flowIds?: bigint[]; annotations?: Record<string, DebugAnnotationValue> }): boolean {
    if (!this.categoryOn(args.cat)) return false;
    return this.enqueueEvent({
      trackUuid: args.trackUuid,
      categories: [`pi.${args.cat}`],
      name: this.clipName(args.name),
      type: TRACK_EVENT_INSTANT,
      flowIds: args.flowIds,
      debugAnnotations: args.annotations,
      tNs: args.tNs ?? this.captureTimestamp(),
    });
  }

  /** Initial configuration lives on the capture span. Changes form intervals
   * on the Tracing track, ending at the next change or capture stop. */
  setRunConfiguration(config: RunConfiguration, tNs?: bigint): void {
    const attrs = runConfigurationAnnotations(config);
    if (JSON.stringify(attrs) === JSON.stringify(this.runAttributes)) return;
    const previousWindow = tokenCount(this.runAttributes["context_window_tokens"]);
    const nextWindow = tokenCount(attrs["context_window_tokens"]);
    this.runAttributes = attrs;
    if (!this.isRecording() || this.tracks === null) return;
    const timestamp = tNs ?? this.captureTimestamp();
    if (previousWindow !== nextWindow) {
      // Zero ends the prior limit when the next model has no known window.
      this.emitCounter("llm.context.window_tokens", nextWindow ?? 0, timestamp);
    }
    if (this.configurationOpen) {
      this.enqueueEvent({trackUuid: this.tracks.tracingUuid, categories: [],
        type: TRACK_EVENT_END, tNs: timestamp}, true);
    }
    this.configurationOpen = this.enqueueEvent({
      trackUuid: this.tracks.tracingUuid,
      categories: ["pi.metadata"], name: "run-configuration", type: TRACK_EVENT_BEGIN,
      debugAnnotations: attrs, tNs: timestamp,
    });
  }

  /** Totals cover reported usage observed during this capture, excluding cache fields. */
  recordTokenUsage(message: unknown, tNs?: bigint): void {
    if (!this.categoryOn("llm")) return;
    const usage = reportedTokenUsage(message);
    const timestamp = tNs ?? this.captureTimestamp();
    if (usage.input !== undefined) {
      this.inputTokens += BigInt(usage.input);
      this.emitCounter("llm.tokens.input", this.inputTokens, timestamp);
    }
    if (usage.output !== undefined) {
      this.outputTokens += BigInt(usage.output);
      this.emitCounter("llm.tokens.output", this.outputTokens, timestamp);
    }
  }

  /** A gauge: unknown estimates produce no sample; compaction may reduce it. */
  recordContextTokens(tokens: unknown, tNs?: bigint): void {
    if (!this.categoryOn("llm")) return;
    const count = tokenCount(tokens);
    if (count === undefined) return;
    if (this.emitCounter("llm.context.estimated_tokens", count, tNs)) {
      this.peakContextTokens = Math.max(this.peakContextTokens ?? 0, count);
    }
  }

  /** A successful compaction invalidates the previous estimate until Pi
   * reports another. Zero here is a visual unknown-state sentinel. */
  invalidateContextTokens(tNs?: bigint): void {
    if (!this.sampledCounters.has("llm.context.estimated_tokens")) return;
    this.emitCounter("llm.context.estimated_tokens", 0, tNs, {forceCategory: true});
  }

  /** Compaction can report a more complete pre-compaction estimate than the
   * last sampled gauge value without supplying a new current gauge value. */
  recordPeakContextTokens(tokens: unknown): void {
    if (!this.categoryOn("llm")) return;
    const count = tokenCount(tokens);
    if (count !== undefined) this.peakContextTokens = Math.max(this.peakContextTokens ?? 0, count);
  }

  emitCounter(
    key: string,
    value: number | bigint,
    tNs?: bigint,
    options: { forceCategory?: boolean; final?: boolean } = {},
  ): boolean {
    if (this.tracks === null || (this.state !== "RECORDING" && this.state !== "STOPPING")) return false;
    const spec = DEFAULT_COUNTERS.find((candidate) => candidate.key === key);
    if (spec === undefined) return false;
    if (!options.forceCategory && !this.config.categories[spec.category ?? "runtime"]) return false;
    const accepted = this.enqueueEvent(
      {
        trackUuid: counterTrackUuid(this.tracks, spec),
        categories: [],
        type: TRACK_EVENT_COUNTER,
        counterValue: typeof value === "number" ? BigInt(Math.max(0, Math.floor(value))) : value,
        tNs: tNs ?? this.captureTimestamp(),
      },
      options.final === true,
    );
    if (accepted) this.sampledCounters.add(key);
    return accepted;
  }

  trackSet(): TrackSet | null {
    return this.tracks;
  }

  private async finalize(reason: string, deadlineAt: number): Promise<TraceManifest | null> {
    if (this.state !== "RECORDING" || this.tracks === null || this.partPath === null) return null;
    this.stopSampler();
    const sampledAt = this.captureTimestamp();
    // Keep final diagnostics distinct from the closing zero samples so the
    // importer retains their values even when it coalesces equal timestamps.
    const cutoffNs = sampledAt + 1n;
    const trackSet = this.tracks;
    for (const spanId of [...this.openSpans.keys()].reverse()) {
      this.emitEnd(
        spanId,
        { "incomplete": true, "cutoff_reason": reason },
        cutoffNs,
      );
    }
    // These spans describe recording/state lifetimes, so stop is their normal
    // end. Only interrupted operations above receive an incomplete annotation.
    if (this.configurationOpen) {
      this.enqueueEvent({trackUuid: trackSet.tracingUuid, categories: [],
        type: TRACK_EVENT_END, tNs: cutoffNs}, true);
      this.configurationOpen = false;
    }
    this.enqueueEvent({trackUuid: trackSet.sessionUuid, categories: [],
      type: TRACK_EVENT_END, tNs: cutoffNs,
      debugAnnotations: {"stop_reason": reason,
        ...(this.peakContextTokens === null ? {} : {"peak_context_tokens": this.peakContextTokens})}}, true);
    const finalCounter = { forceCategory: true, final: true };
    this.emitCounter("tracing.droppedEvents", this.droppedEvents, sampledAt, finalCounter);
    this.emitCounter("tracing.queueDepth", this.queuedRecords, sampledAt, finalCounter);
    this.emitCounter("tracing.laneOverflows", trackSet.lanes.overflows, sampledAt, finalCounter);
    // Close only counters that actually had data, including categories turned
    // off during recording. Unknown/disabled metrics must remain absent.
    for (const key of this.sampledCounters) this.emitCounter(key, 0, cutoffNs, finalCounter);
    this.state = "STOPPING";
    this.flushPending();

    const partPath = this.partPath;
    const finalPath = partPath.replace(/\.part$/, "");
    const drain = this.drainAndClose();
    const completed = await completesBy(drain, deadlineAt);
    if (!completed) {
      // Prevent any not-yet-started batch from touching the part after the
      // deadline. One already-active small write may finish; startup recovery
      // repairs its tail before the part is reused or quarantined.
      this.writerCancelled = true;
      const manifest = this.makeManifest({
        path: partPath,
        bytes: this.bytesWritten,
        tEndNs: cutoffNs,
        reason: `${reason} (finalize deadline exceeded; .part retained)`,
        truncated: true,
        error: "finalize deadline exceeded",
        laneOverflows: trackSet.lanes.overflows,
      });
      this.lastTrace = manifest;
      void drain.finally(async () => {
        await repairPartFile(partPath).catch(() => {});
        await this.removeOwner();
        this.resetGeneration();
        this.state = "OFF";
      });
      return manifest;
    }

    if (this.writeFailure !== null) {
      await completesBy(repairPartFile(partPath), deadlineAt);
      void this.removeOwner();
      const manifest = this.makeManifest({
        path: partPath,
        bytes: this.bytesWritten,
        tEndNs: cutoffNs,
        reason: `${reason} (write failed; .part retained)`,
        truncated: true,
        error: this.writeFailure.message,
        laneOverflows: trackSet.lanes.overflows,
      });
      this.lastTrace = manifest;
      this.resetGeneration();
      this.state = "OFF";
      return manifest;
    }

    if (Date.now() >= deadlineAt) {
      const manifest = this.makeManifest({
        path: partPath,
        bytes: this.bytesWritten,
        tEndNs: cutoffNs,
        reason: `${reason} (publish deadline exceeded; .part retained)`,
        truncated: true,
        error: "publish deadline exceeded",
        laneOverflows: trackSet.lanes.overflows,
      });
      this.lastTrace = manifest;
      void this.removeOwner();
      this.resetGeneration();
      this.state = "OFF";
      return manifest;
    }

    try {
      await rename(partPath, finalPath);
    } catch (error) {
      await completesBy(repairPartFile(partPath), deadlineAt);
      void this.removeOwner();
      const manifest = this.makeManifest({
        path: partPath,
        bytes: this.bytesWritten,
        tEndNs: cutoffNs,
        reason: `${reason} (publish failed; .part retained)`,
        truncated: true,
        error: error instanceof Error ? error.message : String(error),
        laneOverflows: trackSet.lanes.overflows,
      });
      this.lastTrace = manifest;
      this.resetGeneration();
      this.state = "OFF";
      return manifest;
    }

    const durable = await completesBy(
      Promise.all([this.removeOwner(), fsyncDirectory(dirname(finalPath))]),
      deadlineAt,
    );
    const manifest = this.makeManifest({
      path: finalPath,
      bytes: this.bytesWritten,
      tEndNs: cutoffNs,
      reason: durable ? reason : `${reason} (published; durability deadline exceeded)`,
      truncated: false,
      error: durable ? undefined : "published trace was not confirmed directory-durable before deadline",
      laneOverflows: trackSet.lanes.overflows,
    });
    this.lastTrace = manifest;
    this.resetGeneration();
    this.state = "OFF";
    // The trace itself is published. Await the sidecar within the remaining
    // deadline: short-lived workers used to exit before the old fire-and-
    // forget write finished, leaving orphaned .tmp files and no manifest.
    // Retention stays best-effort outside the critical path.
    let sidecarError: string | undefined;
    const sidecarDone = await completesBy(
      writeManifest(manifest).catch((error: unknown) => {
        sidecarError = error instanceof Error ? error.message : String(error);
      }),
      deadlineAt,
    );
    if (!sidecarDone && sidecarError === undefined) sidecarError = "sidecar write deadline exceeded";
    if (sidecarError !== undefined) {
      manifest.error = manifest.error ? `${manifest.error}; sidecar: ${sidecarError}` : `sidecar unwritten: ${sidecarError}`;
    }
    if (this.recording === null) void this.enforceRetention();
    return manifest;
  }

  private makeManifest(args: {
    path: string;
    bytes: number;
    tEndNs: bigint;
    reason: string;
    truncated: boolean;
    laneOverflows: number;
    error?: string;
  }): TraceManifest {
    return {
      path: args.path,
      bytes: args.bytes,
      packets: this.packetsWritten,
      droppedEvents: this.droppedEvents,
      laneOverflows: args.laneOverflows,
      tStartNs: this.tStartNs,
      tEndNs: args.tEndNs,
      shutdownTruncated: args.truncated,
      reason: args.reason,
      clockUncertaintyNs: this.lastClockUncertaintyNs,
      machineId: this.machineId,
      error: args.error,
      children: [...this.childLaunches],
    };
  }

  private clipName(name: string): string {
    return name.length > 240 ? `${name.slice(0, 237)}...` : name;
  }

  private maybeEnqueueClockSnapshot(): void {
    if (this.fileLimitReached || this.seqId === 0 || this.fileHandle === null) return;
    try {
      // Date.now is the cheap hot-path check and advances across suspend. Only
      // sample system uptime once the realtime deadline is actually due.
      if (realtimeNowNs() < this.nextClockSnapshotRealtimeNs) return;
      const clock = captureClockReadings();
      this.lastClockUncertaintyNs = clock.uncertaintyNs;
      const accepted = this.enqueueBytes(
        buildSnapshotPacket({
          seqId: this.seqId,
          machineId: this.machineId,
          sourceClockId: this.clockId,
          sourceNs: clock.sourceNs,
          boottimeNs: clock.boottimeNs,
          realtimeNs: clock.realtimeNs,
        }),
      );
      this.nextClockSnapshotRealtimeNs =
        clock.realtimeNs +
        (accepted ? CLOCK_RESNAPSHOT_NS : CLOCK_RESNAPSHOT_RETRY_NS);
    } catch {
      // Preserve agent events when a later platform clock sample is unavailable.
    }
  }

  private encodeEvent(args: EventRecordArgs): Uint8Array {
    const event = buildTrackEvent({
      trackUuid: args.trackUuid,
      categories: args.categories,
      name: args.name,
      type: args.type,
      counterValue: args.counterValue,
      debugAnnotations: args.debugAnnotations,
      flowIds: args.flowIds,
    });
    return framePacket(buildTracePacket({
      timestampNs: args.tNs,
      clockId: this.clockId,
      seqId: this.seqId,
      machineId: this.machineId,
      trackEvent: event,
    }));
  }

  private enqueueEvent(args: EventRecordArgs, critical = false): boolean {
    if (this.tracks === null || this.writeFailure !== null) return false;
    try {
      return this.enqueueBytes(this.encodeEvent(args), { critical });
    } catch {
      this.droppedEvents++;
      return false;
    }
  }

  /** Could the deferred packets (or an increase to them) still fit once
   * emitted? Charge both writer and file budgets; leave the finalization
   * reserve for the capture END and counters. */
  private fitsDeferred(bytes: number, records: number): boolean {
    const fileLimit = this.config.maxFileMB * 1024 * 1024;
    const totalBytes = this.deferredBytes + bytes;
    if (this.acceptedBytes + totalBytes > Math.max(0, fileLimit - FINALIZE_RESERVE_BYTES)) {
      this.fileLimitReached = true;
      return false;
    }
    // Deferred pairs may not spend the queue's critical reserve: capture END
    // and final counters still have to fit when all pending spans close at stop.
    return this.fileHandle !== null && this.writeFailure === null &&
      this.queuedBytes + totalBytes <= this.config.queueBytes &&
      this.queuedRecords + this.deferredRecords + records <= this.config.queueDepth;
  }

  private enqueueBytes(record: Uint8Array, options: EnqueueOptions = {}): boolean {
    if (this.writeFailure !== null || this.fileHandle === null) return false;
    const critical = options.critical === true;
    const recordLimit = this.config.queueDepth + (critical ? CRITICAL_RECORD_RESERVE : 0);
    const byteLimit = this.config.queueBytes + (critical ? FINALIZE_RESERVE_BYTES : 0);
    const fileLimit = this.config.maxFileMB * 1024 * 1024;
    const normalFileLimit = Math.max(0, fileLimit - FINALIZE_RESERVE_BYTES);
    if (
      this.queuedRecords + this.deferredRecords + 1 > recordLimit ||
      this.queuedBytes + this.deferredBytes + record.length > byteLimit ||
      this.acceptedBytes + this.deferredBytes + record.length > (critical ? fileLimit : normalFileLimit)
    ) {
      this.droppedEvents++;
      if (this.acceptedBytes + this.deferredBytes + record.length > (critical ? fileLimit : normalFileLimit)) {
        this.fileLimitReached = true;
      }
      // Deferred pairs are preflighted atomically before reaching this path.
      // Keep the existing fail-closed behavior for other critical records: a
      // trace missing its capture END must never publish as complete.
      if (critical) this.writeFailure ??= new Error("critical trace record could not be queued within configured bounds");
      return false;
    }
    this.pending.push(record);
    this.pendingBytes += record.length;
    this.queuedRecords++;
    this.queuedBytes += record.length;
    this.acceptedBytes += record.length;
    if (this.pending.length >= FLUSH_BATCH_RECORDS || this.pendingBytes >= FLUSH_BATCH_BYTES) {
      this.flushPending();
    } else {
      this.scheduleFlush();
    }
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, 5);
    this.flushTimer.unref?.();
  }

  private flushPending(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    const total = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const record of batch) {
      merged.set(record, offset);
      offset += record.length;
    }
    this.writeChain = this.writeChain
      .then(async () => {
        if (this.writeFailure !== null || this.writerCancelled) return;
        const handle = this.fileHandle;
        if (handle === null) throw new Error("trace file closed before queued write");
        await handle.writeFile(merged);
        this.packetsWritten += batch.length;
        this.bytesWritten += total;
      })
      .catch((error: unknown) => {
        this.writeFailure ??= error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        this.queuedRecords -= batch.length;
        this.queuedBytes -= total;
      });
  }

  private async drainAndClose(): Promise<void> {
    this.flushPending();
    await this.writeChain;
    const handle = this.fileHandle;
    this.fileHandle = null;
    if (handle === null) return;
    try {
      await handle.sync();
    } catch (error) {
      this.writeFailure ??= error instanceof Error ? error : new Error(String(error));
    }
    try {
      await handle.close();
    } catch (error) {
      this.writeFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  private async closeHandle(): Promise<void> {
    const handle = this.fileHandle;
    this.fileHandle = null;
    if (handle !== null) await handle.close().catch(() => {});
  }

  private async removeOwner(): Promise<void> {
    const path = this.ownerPath;
    if (path !== null) await rm(path, { force: true }).catch(() => {});
  }

  private resetGeneration(): void {
    this.stopSampler();
    if (this.recordingWatch !== null) clearInterval(this.recordingWatch);
    this.recordingWatch = null;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.tracks = null;
    this.partPath = null;
    this.ownerPath = null;
    this.fileHandle = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.queuedRecords = 0;
    this.queuedBytes = 0;
    this.seqId = 0;
    this.openSpans.clear();
    this.deferredBytes = 0;
    this.deferredRecords = 0;
    this.sampledCounters.clear();
    this.configurationOpen = false;
  }

  private async enforceRetention(): Promise<void> {
    let entries: Array<{ path: string; mtimeMs: number }> = [];
    try {
      const names = (await readdir(this.outDir)).filter((entry) => entry.endsWith(".pftrace"));
      entries = await Promise.all(
        names.map(async (entry) => ({ path: join(this.outDir, entry), mtimeMs: (await stat(join(this.outDir, entry))).mtimeMs })),
      );
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    } catch {
      return;
    }
    for (const victim of entries.slice(0, Math.max(0, entries.length - this.config.maxFiles))) {
      await rm(victim.path, { force: true }).catch(() => {});
      await rm(`${victim.path}.json`, { force: true }).catch(() => {});
    }
  }

  private startSampler(): void {
    this.stopSampler();
    if (this.state !== "RECORDING") return;
    const runtimeEnabled = this.config.sampleHz > 0 && this.config.categories.runtime;
    const intervalMs = runtimeEnabled ? Math.max(16, Math.floor(1000 / this.config.sampleHz)) : 1000;
    this.sampler = setInterval(() => {
      try {
        if (!this.isRecording()) return;
        const nowNs = this.captureTimestamp();
        if (runtimeEnabled) {
          const memory = process.memoryUsage();
          this.emitCounter("runtime.rss", memory.rss, nowNs);
          this.emitCounter("runtime.heap", memory.heapUsed, nowNs);
          const cpu = process.cpuUsage(this.lastCpu);
          this.lastCpu = process.cpuUsage();
          this.emitCounter("runtime.cpu", cpu.user + cpu.system, nowNs);
        }
        // Health samples bypass the runtime category, but not the file reserve:
        // final END/counter packets own that reserve exclusively.
        const healthCounter = { forceCategory: true };
        this.emitCounter("tracing.queueDepth", this.queuedRecords, nowNs, healthCounter);
        this.emitCounter("tracing.droppedEvents", this.droppedEvents, nowNs, healthCounter);
        this.emitCounter("tracing.laneOverflows", this.tracks?.lanes.overflows ?? 0, nowNs, healthCounter);
      } catch {
        // Sampler never breaks the agent.
      }
    }, intervalMs);
    this.sampler.unref?.();
  }

  private stopSampler(): void {
    if (this.sampler !== null) {
      clearInterval(this.sampler);
      this.sampler = null;
    }
  }
}

async function completesBy(task: Promise<unknown>, deadlineAt: number): Promise<boolean> {
  // Attach both handlers before checking the deadline so an already-started
  // task can never reject unobserved after we stop waiting for it.
  const completed = task.then(() => true, () => false);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    void completed;
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), remainingMs);
    timer.unref?.();
  });
  const result = await Promise.race([completed, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Directory fsync is unsupported on some platforms/filesystems. Ignore only
    // those explicit capability errors; propagate real I/O failures (e.g. EIO).
    if (
      !hasCode(error, "EINVAL") &&
      !hasCode(error, "ENOTSUP") &&
      !hasCode(error, "EOPNOTSUPP") &&
      !hasCode(error, "EBADF")
    ) {
      throw error;
    }
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }
}

async function writeManifest(manifest: TraceManifest): Promise<void> {
  const path = `${manifest.path}.json`;
  const temp = `${path}.${process.pid}.${randomToken()}.tmp`;
  const serializable = {
    ...manifest,
    tStartNs: manifest.tStartNs.toString(),
    tEndNs: manifest.tEndNs.toString(),
    clockUncertaintyNs: manifest.clockUncertaintyNs.toString(),
  };
  await writeFile(temp, `${JSON.stringify(serializable, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temp, path);
}

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function defaultOutDir(agentDir: string): string {
  return join(agentDir, "pi-tracing");
}

export function sanitizeSessionTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
  return cleaned === "" ? "session" : cleaned;
}
