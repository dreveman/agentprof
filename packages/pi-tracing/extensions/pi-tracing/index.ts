// pi-tracing: self-controlled Perfetto capture for Pi (internal v1).
// OFF + RECORDING only. ARMED / SYSTEM / rollover are reserved stubs with
// clear errors. Uses Pi's own packages; prompt text is captured by default.

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {Type} from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

import {
  ALL_CATEGORIES,
  applyEnvOverrides,
  applyRawConfig,
  defaultConfig,
  type CategoryId,
  type TracingConfig,
} from "./config.ts";
import { formatProbe, runProbe } from "./probe.ts";
import { assistantAnnotations, promptAnnotations, reportedTokenUsage, tokenCount, toolArgumentAnnotations, TRACE_VERSION } from "./annotations.ts";
import { defaultOutDir, describeBytes, Recorder, sanitizeArgv0, sanitizeSessionTag } from "./tracer.ts";
import type { TraceManifest } from "./tracer.ts";
import type { TrackSet } from "./tracks.ts";
import { randomFlowId } from "./tracks.ts";
import { childPromptFlowId, describeChildLaunch, detectChildRole, extractChildSessionId, mergeExtensionPath } from "./workflow.ts";

const WIDGET_ID = "pi-tracing-status";
const PROCESS_NAME = "pi";
const GLOBAL_CONFIG_NAME = "pi-tracing.json";
const PROJECT_CONFIG_NAME = "pi-tracing.json";
const TRACING_CONTROL_TOOLS = new Set(["tracing_start", "tracing_stop"]);

/** This extension's own load path, mirrored into spawned children's
 * environments so workers load pi-tracing without manual configuration. */
const OWN_EXTENSION_PATH: string | undefined = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
})();

function msgId(message: unknown): string {
  if (typeof message === "object" && message !== null && "id" in message) {
    const id = (message as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return "msg";
}

function msgRole(message: unknown): string {
  if (typeof message === "object" && message !== null && "role" in message) {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") return role;
  }
  return "?";
}

const utf8 = new TextEncoder();

function deltaBytes(event: unknown): number {
  try {
    const inner = (event as { assistantMessageEvent?: { delta?: unknown } }).assistantMessageEvent;
    return typeof inner?.delta === "string" && inner.delta.length > 0 ? utf8.encode(inner.delta).length : 0;
  } catch {
    return 0;
  }
}

function partialResultBytes(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  // Tool partials are cumulative. Inspect only the public content array and
  // cap traversal; never stringify arbitrary details on this hot hook.
  for (const item of content.slice(0, 64)) {
    if (typeof item !== "object" || item === null) continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") bytes += utf8.encode(text).length;
  }
  return bytes;
}

function readJsonFile(path: string): { raw: unknown; error?: string } {
  try {
    return { raw: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { raw: undefined };
    return { raw: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

interface SessionState {
  recorder: Recorder;
  warnings: string[];
  /** Env presence/values at session start, so child-env mirroring restores
   * exactly what the user had instead of clobbering explicit settings. */
  initialEnv: { piTracing: string | undefined; subagentExtensions: string | undefined; recordingDirectory: string | undefined };
  messageStreams: Map<string, { span: number; startNs: bigint; firstUpdateNs: bigint | null; updates: number; bytes: number }>;
  promptData: ReturnType<typeof promptAnnotations>;
  promptInputFlow: bigint | undefined;
  childPromptPending: boolean;
  linkedChildSessions: Set<string>;
  contextMessages: number | undefined;
  providerSpan: number | null;
  operationSpan: number | null;
  attemptSpan: number | null;
  turnSpan: number | null;
  compaction: {span: number | null; beforeTokens: number | undefined} | null;
  toolSpans: Map<string, number>;
  toolLastPartialBytes: Map<string, number>;
  /** toolCallId -> flow linkage: the id shared by the main-thread issue event
   * and the tool-lane execution slice, plus the execution BEGIN timestamp so
   * the issue instant can be stamped causally before it. Bounded. */
  toolFlows: Map<string, { flowId: bigint; beginNs: bigint }>;
  /** Join keys for child launches carried by their tool execution spans. */
  childLaunches: Map<string, { task: string | null; correlation: string | null }>;
}

export default function (pi: ExtensionAPI) {
  let session: SessionState | null = null;

  const runConfiguration = (ctx: ExtensionContext) => ({
    model: ctx.model?.id,
    provider: ctx.model?.provider,
    effort: ctx.thinkingLevel ?? pi.getThinkingLevel(),
    contextWindowTokens: ctx.model?.contextWindow,
  });


  try {
    pi.registerFlag("tracing", {
      description: "Start pi-tracing recording on startup (same as PI_TRACING=1)",
      type: "boolean",
      default: false,
    });
  } catch {
    // Older runtimes without registerFlag: flags simply unavailable.
  }

  const getFlagTracing = (): boolean => {
    try {
      const getFlag = (pi as unknown as { getFlag?: (name: string) => unknown }).getFlag;
      if (typeof getFlag !== "function") return false;
      return getFlag.call(pi, "tracing") === true;
    } catch {
      return false;
    }
  };

  const loadConfig = (ctx: ExtensionContext): { config: TracingConfig; warnings: string[] } => {
    const warnings: string[] = [];
    let config = defaultConfig();
    const globalPath = join(getAgentDir(), GLOBAL_CONFIG_NAME);
    const global = readJsonFile(globalPath);
    if (global.error !== undefined) {
      warnings.push(`global ${GLOBAL_CONFIG_NAME}: ${global.error}; using defaults`);
    } else if (global.raw !== undefined) {
      const parsed = applyRawConfig(config, global.raw, `global ${GLOBAL_CONFIG_NAME}`);
      config = parsed.config;
      warnings.push(...parsed.warnings);
    }
    let trusted = false;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      trusted = false;
    }
    const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, PROJECT_CONFIG_NAME);
    if (trusted) {
      if (existsSync(projectPath)) {
        const project = readJsonFile(projectPath);
        if (project.error !== undefined) {
          warnings.push(`project ${PROJECT_CONFIG_NAME}: ${project.error}; ignored`);
        } else if (project.raw !== undefined) {
          const parsed = applyRawConfig(config, project.raw, `project ${PROJECT_CONFIG_NAME}`);
          config = parsed.config;
          warnings.push(...parsed.warnings);
        }
      }
    } else if (existsSync(projectPath)) {
      warnings.push(`untrusted project config ignored: ${projectPath}`);
    }
    const envParsed = applyEnvOverrides(config, process.env);
    config = envParsed.config;
    warnings.push(...envParsed.warnings);
    if (getFlagTracing()) config.startupMode = "recording";
    if (config.startupMode === "armed") {
      warnings.push("startupMode=armed: flight recorder lands in P3; starting OFF instead");
      config.startupMode = "off";
    }
    return { config, warnings };
  };

  const sessionTagFor = (ctx: ExtensionContext): string => {
    try {
      return sanitizeSessionTag(ctx.sessionManager.getSessionId().slice(0, 8));
    } catch {
      return "session";
    }
  };

  const sessionIdFor = (ctx: ExtensionContext): string => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return "unknown";
    }
  };

  const mainThreadIdentity = (): {tid: number; name: string} | undefined => {
    // Linux's main thread TID equals its PID. JavaScript worker IDs are not TIDs.
    if (process.platform !== "linux" || !isMainThread) return undefined;
    return {tid: process.pid, name: PROCESS_NAME};
  };

  const identityFor = (sessionId: string, roleLabel?: string) => ({
    pid: process.pid,
    processName: PROCESS_NAME,
    mainThread: mainThreadIdentity(),
    // The session id is a random join key (also in the filename), not user
    // content: it lets parent/child traces correlate. Host names are never
    // recorded. Role labels distinguish orchestrators from spawned workers.
    labels: [
      `session:${sessionId}`,
      ...(roleLabel !== undefined ? [`role:${roleLabel}`] : []),
    ],
  });

  const setWidget = (ctx: ExtensionContext, text: string | null) => {
    try {
      if (text === null) {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }
      ctx.ui.setWidget(WIDGET_ID, [text], { placement: "belowEditor" });
    } catch {
      // Headless / RPC modes: widgets unavailable; status command covers it.
    }
  };

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    } else {
      // Keep JSON stdout framing intact; headless humans still get feedback.
      process.stderr.write(`${message}\n`);
    }
  };

  const refreshWidget = (ctx: ExtensionContext) => {
    if (session === null) return;
    const stats = session.recorder.getStats();
    if (!session.recorder.isRecording()) {
      setWidget(ctx, null);
      return;
    }
    setWidget(ctx, `◈ TRACING ● REC ${stats.packets}p ${stats.dropped}d ${stats.openSpans} spans`);
  };

  const clearCorrelationState = (state: SessionState): void => {
    state.messageStreams.clear();
    state.promptData = {};
    state.promptInputFlow = undefined;
    state.contextMessages = undefined;
    state.providerSpan = null;
    state.operationSpan = null;
    state.attemptSpan = null;
    state.turnSpan = null;
    state.compaction = null;
    state.toolSpans.clear();
    state.toolLastPartialBytes.clear();
    state.toolFlows.clear();
    state.childLaunches.clear();
    rigRunSpans.clear();
  };

  /** Mirror recording state into the env children inherit. While recording,
   * ensure spawned workers autostart tracing (PI_TRACING) and load this
   * extension (PI_SUBAGENT_EXTENSIONS, honored by braid and subagent launchers). Explicit
   * user settings are never overridden; everything is restored to the
   * session-start values when recording stops. */
  const syncChildEnv = (): void => {
    if (session === null) return;
    if (session.recorder.isRecording()) {
      const directory = session.recorder.getRecordingDirectory();
      if (directory !== undefined) process.env.PI_TRACING_RECORDING_DIR = directory;
      if (session.initialEnv.piTracing === undefined) process.env.PI_TRACING = "1";
      if (OWN_EXTENSION_PATH !== undefined) {
        const current = process.env.PI_SUBAGENT_EXTENSIONS;
        if (current === undefined) {
          process.env.PI_SUBAGENT_EXTENSIONS = OWN_EXTENSION_PATH;
        } else if (!current.split(",").map((entry) => entry.trim()).includes(OWN_EXTENSION_PATH)) {
          process.env.PI_SUBAGENT_EXTENSIONS = mergeExtensionPath(current, OWN_EXTENSION_PATH);
        }
      }
    } else {
      if (session.initialEnv.recordingDirectory === undefined) delete process.env.PI_TRACING_RECORDING_DIR;
      else process.env.PI_TRACING_RECORDING_DIR = session.initialEnv.recordingDirectory;
      if (session.initialEnv.piTracing === undefined) delete process.env.PI_TRACING;
      else process.env.PI_TRACING = session.initialEnv.piTracing;
      if (session.initialEnv.subagentExtensions === undefined) delete process.env.PI_SUBAGENT_EXTENSIONS;
      else process.env.PI_SUBAGENT_EXTENSIONS = session.initialEnv.subagentExtensions;
    }
  };

  const childEnvSummary = (): string => {
    if (session === null) return "child env: no active session";
    if (!session.recorder.isRecording()) return "child env: restored (tracing off)";
    const autoTracing = session.initialEnv.piTracing === undefined;
    const autoExtension = session.initialEnv.subagentExtensions === undefined && OWN_EXTENSION_PATH !== undefined;
    if (autoTracing && autoExtension) return "child env: auto-mirrored (PI_TRACING=1 + pi-tracing extension)";
    if (autoTracing) return "child env: auto-mirrored (PI_TRACING=1; extension path unavailable)";
    return "child env: explicit user env (mirroring skipped)";
  };

  /** Restore session-start env unconditionally (shutdown path: the recorder
   * may still report RECORDING, so syncChildEnv would mirror instead). */
  const syncChildEnvRestore = (): void => {
    if (session === null) return;
    if (session.initialEnv.recordingDirectory === undefined) delete process.env.PI_TRACING_RECORDING_DIR;
    else process.env.PI_TRACING_RECORDING_DIR = session.initialEnv.recordingDirectory;
    if (session.initialEnv.piTracing === undefined) delete process.env.PI_TRACING;
    else process.env.PI_TRACING = session.initialEnv.piTracing;
    if (session.initialEnv.subagentExtensions === undefined) delete process.env.PI_SUBAGENT_EXTENSIONS;
    else process.env.PI_SUBAGENT_EXTENSIONS = session.initialEnv.subagentExtensions;
  };

  const withSession = (ctx: ExtensionContext, fn: (state: SessionState) => void) => {
    if (session === null) return;
    try {
      fn(session);
    } catch {
      // Tracing hooks never break the agent; count via dropped marker below.
      try {
        session.recorder.setConfigError("hook error swallowed (see dropped counter)");
      } catch {
        // ignore
      }
    }
    refreshWidget(ctx);
  };

  const mainThreadTrack = (): bigint | null => {
    const tracks = session?.recorder.trackSet() as TrackSet | null;
    return tracks?.sessionUuid ?? null;
  };

  const providerTrack = (): bigint | null => {
    const tracks = session?.recorder.trackSet() as TrackSet | null;
    return tracks?.providerUuid ?? null;
  };

  const sessionTrack = (): bigint | null => {
    const tracks = session?.recorder.trackSet() as TrackSet | null;
    return tracks?.sessionUuid ?? null;
  };

  const workflowTrack = (): bigint | null => {
    const tracks = session?.recorder.trackSet() as TrackSet | null;
    return tracks?.workflowUuid ?? null;
  };

  /** Parent-side launch announcements from cooperating orchestrators (rig
   * emits `workflow-rig:worker-launched` on the shared bus). Covers spawn
   * paths invisible to tool hooks, e.g. rig slash commands. Validated and
   * metadata-only; malformed payloads are ignored. */
  const handleRigWorkerLaunched = (data: unknown): void => {
    if (session === null) return;
    try {
      if (!session.recorder.isRecording() || !session.recorder.categoryOn("workflow")) return;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as Record<string, unknown>;
      const str = (key: string, maxLen: number): string | null => {
        const value = payload[key];
        if (typeof value !== "string" || value === "") return null;
        return value.length > maxLen ? value.slice(0, maxLen) : value;
      };
      const taskId = str("taskId", 64);
      const childSession = str("sessionId", 64);
      if (taskId === null && childSession === null) return;
      const track = workflowTrack();
      if (track === null) return;
      const annotations: Record<string, string | number | boolean> = { source: "bus" };
      const namespace = str("namespace", 64);
      const rootId = str("rootId", 64);
      const role = str("role", 64);
      const mode = str("mode", 16);
      const outcome = str("outcome", 16);
      const parentSession = str("parentSessionId", 64);
      if (namespace !== null) annotations["namespace"] = namespace;
      if (rootId !== null) annotations["root_id"] = rootId;
      if (taskId !== null) annotations["task_id"] = taskId;
      if (childSession !== null) annotations["child_session"] = childSession;
      if (role !== null) annotations["role"] = role;
      if (mode !== null) annotations["mode"] = mode;
      if (outcome !== null) annotations["outcome"] = outcome;
      if (parentSession !== null) annotations["parent_session"] = parentSession;
      const attempt = payload["attempt"];
      if (typeof attempt === "number" && Number.isSafeInteger(attempt)) annotations["attempt"] = attempt;
      session.recorder.emitInstant({
        cat: "workflow",
        trackUuid: track,
        name: "launch",
        annotations,
      });
      session.recorder.noteChildLaunch({ task: taskId, childSession, correlation: null });
    } catch {
      // Observability must never break the agent.
    }
  };

  try {
    const bus = (pi as unknown as { events?: { on?: (name: string, listener: (data: unknown) => void) => void } }).events;
    bus?.on?.("workflow-rig:worker-launched", handleRigWorkerLaunched);
  } catch {
    // Runtimes without a shared event bus simply miss bus-sourced launches.
  }

  /** Open run slices by root id: `run-started` begins a long slice on the
   * workflow parent track, `run-terminal` ends it. The stop-time cutoff
   * machinery closes orphans, so a missing terminal never leaks a slice. */
  const rigRunSpans = new Map<string, number>();

  const rigRecord = (): boolean => {
    if (session === null) return false;
    return session.recorder.isRecording() && session.recorder.categoryOn("workflow");
  };

  const rigStr = (payload: Record<string, unknown>, key: string, maxLen: number): string | null => {
    const value = payload[key];
    if (typeof value !== "string" || value === "") return null;
    return value.length > maxLen ? value.slice(0, maxLen) : value;
  };

  const rigAnnotations = (
    payload: Record<string, unknown>,
    fields: Array<{ key: string; annotation?: string; maxLen: number }>,
  ): Record<string, string | number | boolean> => {
    const annotations: Record<string, string | number | boolean> = { source: "bus" };
    for (const field of fields) {
      const value = rigStr(payload, field.key, field.maxLen);
      if (value !== null) annotations[field.annotation ?? field.key] = value;
    }
    const attempt = payload["attempt"];
    if (typeof attempt === "number" && Number.isSafeInteger(attempt)) annotations["attempt"] = attempt;
    return annotations;
  };

  const handleRigRunStarted = (data: unknown): void => {
    if (session === null) return;
    try {
      if (!rigRecord()) return;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as Record<string, unknown>;
      const rootId = rigStr(payload, "rootId", 64);
      if (rootId === null) return;
      const track = workflowTrack();
      if (track === null) return;
      const previous = rigRunSpans.get(rootId);
      if (previous !== undefined) {
        session.recorder.emitEnd(previous, { superseded: true });
        rigRunSpans.delete(rootId);
      }
      const span = session.recorder.beginSlice({
        cat: "workflow",
        trackUuid: track,
        name: "run",
        annotations: rigAnnotations(payload, [
          { key: "rootId", annotation: "root_id", maxLen: 64 },
          { key: "namespace", maxLen: 64 },
          { key: "runId", annotation: "run_id", maxLen: 64 },
          { key: "workflowName", annotation: "workflow_name", maxLen: 120 },
        ]),
      });
      if (span !== null) rigRunSpans.set(rootId, span);
    } catch {
      // Observability must never break the agent.
    }
  };

  const handleRigReconcile = (data: unknown): void => {
    if (session === null) return;
    try {
      if (!rigRecord()) return;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as Record<string, unknown>;
      const rootId = rigStr(payload, "rootId", 64);
      const outcome = rigStr(payload, "outcome", 32) ?? "unknown";
      const track = workflowTrack();
      if (track === null) return;
      const annotations = rigAnnotations(payload, [
        { key: "namespace", maxLen: 64 },
        { key: "runId", annotation: "run_id", maxLen: 64 },
        { key: "source", maxLen: 32 },
      ]);
      const actionCount = payload["actionCount"];
      if (typeof actionCount === "number" && Number.isSafeInteger(actionCount)) annotations["action_count"] = actionCount;
      if (rootId !== null) annotations["root_id"] = rootId;
      annotations["outcome"] = outcome;
      const name = "reconcile";
      const duration = payload["durationMs"];
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
        annotations["duration_ms"] = duration;
        const endNs = process.hrtime.bigint();
        const beginNs = endNs - BigInt(Math.round(duration * 1e6));
        const span = session.recorder.beginSlice({ cat: "workflow", trackUuid: track, name, annotations, tNs: beginNs });
        if (span !== null) session.recorder.emitEnd(span, undefined, endNs);
      } else {
        session.recorder.emitInstant({ cat: "workflow", trackUuid: track, name, annotations });
      }
    } catch {
      // Observability must never break the agent.
    }
  };

  const handleRigRunTerminal = (data: unknown): void => {
    if (session === null) return;
    try {
      if (!rigRecord()) return;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as Record<string, unknown>;
      const rootId = rigStr(payload, "rootId", 64);
      const track = workflowTrack();
      if (track === null) return;
      const outcome = rigStr(payload, "outcome", 64);
      const reason = rigStr(payload, "reason", 200);
      const extra: Record<string, string | number | boolean> = {};
      if (rootId !== null) extra["root_id"] = rootId;
      if (outcome !== null) extra["outcome"] = outcome;
      if (reason !== null) extra["reason"] = reason;
      if (rootId !== null) {
        const span = rigRunSpans.get(rootId);
        rigRunSpans.delete(rootId);
        if (span !== undefined) {
          session.recorder.emitEnd(span, extra);
          return;
        }
      }
      session.recorder.emitInstant({
        cat: "workflow",
        trackUuid: track,
        name: "run-terminal",
        annotations: extra,
      });
    } catch {
      // Observability must never break the agent.
    }
  };

  const handleRigSpawnConfirm = (data: unknown): void => {
    if (session === null) return;
    try {
      if (!rigRecord()) return;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return;
      const payload = data as Record<string, unknown>;
      const track = workflowTrack();
      if (track === null) return;
      const taskId = rigStr(payload, "taskId", 64);
      const granted = payload["granted"];
      const annotations = rigAnnotations(payload, [{ key: "source", maxLen: 32 }]);
      if (taskId !== null) annotations["task_id"] = taskId;
      if (typeof granted === "boolean") annotations["granted"] = granted;
      session.recorder.emitInstant({
        cat: "workflow",
        trackUuid: track,
        name: "spawn-confirmation",
        annotations,
      });
    } catch {
      // Observability must never break the agent.
    }
  };

  // Subscriptions live after all handler definitions: referencing the const
  // handlers any earlier throws a temporal-dead-zone ReferenceError, which
  // the guarded block would swallow while silently dropping every event
  // after the first.
  try {
    const bus = (pi as unknown as { events?: { on?: (name: string, listener: (data: unknown) => void) => void } }).events;
    bus?.on?.("workflow-rig:run-started", handleRigRunStarted);
    bus?.on?.("workflow-rig:reconcile", handleRigReconcile);
    bus?.on?.("workflow-rig:run-terminal", handleRigRunTerminal);
    bus?.on?.("workflow-rig:spawn-confirm", handleRigSpawnConfirm);
  } catch {
    // Runtimes without a shared event bus simply miss bus-sourced run events.
  }

  // -- lifecycle --

  pi.on("session_start", async (_event, ctx) => {
    const { config, warnings } = loadConfig(ctx);
    const outDir = defaultOutDir(getAgentDir());
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {
      // Recorder reports IO failures via dropped counters / status.
    }
    const childRole = detectChildRole(process.env);
    const roleLabel = childRole === null ? undefined : childRole.role;
    const captureAnnotations: Record<string, string | number | boolean> = {};
    if (childRole !== null) {
      captureAnnotations.child_role = childRole.role;
      if (childRole.parentSession !== undefined) captureAnnotations.parent_session = childRole.parentSession;
      if (childRole.ownerPid !== undefined) captureAnnotations.owner_pid = childRole.ownerPid;
      if (childRole.subagentType !== undefined) captureAnnotations.subagent_type = childRole.subagentType;
      if (childRole.sessionKeyBytes !== undefined) captureAnnotations.session_key_bytes = childRole.sessionKeyBytes;
    }
    const recorder = new Recorder({
      config,
      outDir,
      sessionTag: sessionTagFor(ctx),
      identity: identityFor(sessionIdFor(ctx), roleLabel),
      captureAnnotations,
      collectChildren: true,
      recordingDirectory: process.env.PI_TRACING_RECORDING_DIR,
    });
    if (warnings.length > 0) recorder.setConfigError(warnings.join("; "));
    session = {
      recorder,
      warnings,
      initialEnv: {
        piTracing: process.env.PI_TRACING,
        recordingDirectory: process.env.PI_TRACING_RECORDING_DIR,
        subagentExtensions: process.env.PI_SUBAGENT_EXTENSIONS,
      },
      messageStreams: new Map(),
      promptData: {},
      promptInputFlow: undefined,
      // Resumed sessions already have their initial prompt. Capture restarts
      // must not make a later input look like a new child launch.
      childPromptPending: childRole !== null && !ctx.sessionManager.getEntries().some(
        entry => entry.type === "message" && entry.message.role === "user"),
      linkedChildSessions: new Set(),
      contextMessages: undefined,
      providerSpan: null,
      operationSpan: null,
      attemptSpan: null,
      turnSpan: null,
      compaction: null,
      toolSpans: new Map(),
      toolLastPartialBytes: new Map(),
      toolFlows: new Map(),
      childLaunches: new Map(),
    };
    const probe = runProbe();
    recorder.setProbePassedMonotonic(probe.find((result) => result.name === "clock-equivalence")?.ok === true);
    for (const note of await recorder.recoverParts()) warnings.push(note);
    if (warnings.length > 0) {
      try {
        notify(ctx, `pi-tracing: ${warnings.join("; ")}`, "warning");
      } catch {
        // ignore headless notify failures
      }
    }
    if (config.startupMode === "recording") {
      recorder.setRunConfiguration(runConfiguration(ctx));
      const started = await recorder.start();
      if (started.started) syncChildEnv();
      try {
        notify(ctx, `pi-tracing: ${started.message}`, started.started ? "info" : "error");
      } catch {
        // ignore
      }
      if (!started.started) recorder.setConfigError(`autostart failed: ${started.message}`);
    }
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (session === null) return;
    syncChildEnvRestore();
    try {
      const manifest = await session.recorder.shutdownFinalize(event.reason);
      if (manifest !== null) {
        try {
          // Pi may already have stopped its terminal UI. Write synchronously
          // so the path survives process.exit(), also keeping JSON stdout clean.
          const message = `pi-tracing: ${manifest.recordingPath ? "contributed to" : manifest.shutdownTruncated ? "retained" : "finalized"} ${manifest.recordingPath ?? manifest.path} (${manifest.packets} packets${manifest.incompleteProcesses ? ", incomplete child capture" : ""}${manifest.error ? `, ${manifest.error}` : ""})`;
          if (event.reason === "quit") {
            writeSync(2, `${message}\n`);
          } else {
            notify(ctx, message, manifest.shutdownTruncated || manifest.error ? "warning" : "info");
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // Bounded finalize never throws past this point.
    }
    setWidget(ctx, null);
    session = null;
  });

  // -- agent / turn --

  pi.on("before_agent_start", (event, ctx) => {
    withSession(ctx, (state) => {
      const prompt = (event as { prompt?: unknown }).prompt;
      state.promptData = promptAnnotations(prompt, state.recorder.categoryOn("prompt-data"));
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    withSession(ctx, (state) => {
      const inputFlow = state.promptInputFlow;
      state.promptInputFlow = undefined;
      const annotations = state.promptData;
      state.promptData = {};
      if (!state.recorder.categoryOn("prompt-data")) {
        delete annotations["text"];
        delete annotations["truncated"];
      }
      const track = mainThreadTrack();
      if (track === null) return;
      if (state.operationSpan === null) {
        state.operationSpan = state.recorder.beginSlice({ cat: "agent", trackUuid: track, name: "prompt",
          flowIds: inputFlow === undefined ? undefined : [inputFlow],
          additionalCategories: annotations["text"] === undefined ? [] : ["prompt-data"],
          annotations });
      } else {
        state.recorder.annotateSpan(state.operationSpan, annotations);
      }
      state.attemptSpan = state.recorder.beginSlice({ cat: "agent", trackUuid: track, name: "attempt" });
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    withSession(ctx, (state) => {
      const ended = state.recorder.captureTimestamp();
      for (const stream of state.messageStreams.values()) {
        state.recorder.emitEnd(stream.span, {...assistantAnnotations({}, stream, ended),
          "incomplete": true}, ended);
      }
      state.messageStreams.clear();
      state.contextMessages = undefined;
      // Provider failures do not necessarily emit after_provider_response.
      if (state.providerSpan !== null) {
        state.recorder.emitEnd(state.providerSpan, { "incomplete": true });
        state.providerSpan = null;
      }
      if (state.attemptSpan !== null) {
        state.recorder.emitEnd(state.attemptSpan);
        state.attemptSpan = null;
      }
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    withSession(ctx, (state) => {
      if (state.attemptSpan !== null) {
        state.recorder.emitEnd(state.attemptSpan);
        state.attemptSpan = null;
      }
      if (state.operationSpan !== null) {
        state.recorder.emitEnd(state.operationSpan);
        state.operationSpan = null;
      }
    });
  });

  pi.on("turn_start", (event, ctx) => {
    withSession(ctx, (state) => {
      const track = mainThreadTrack();
      if (track === null) return;
      state.turnSpan = state.recorder.beginSlice({ cat: "agent", trackUuid: track, name: "turn",
        annotations: { "kind": "turn", "index": event.turnIndex } });
    });
  });

  pi.on("turn_end", (_event, ctx) => {
    withSession(ctx, (state) => {
      if (state.turnSpan !== null) {
        state.recorder.emitEnd(state.turnSpan);
        state.turnSpan = null;
      }
    });
  });

  // -- messages: one response span, with streaming/usage metadata on its end --

  pi.on("message_start", (event, ctx) => {
    withSession(ctx, (state) => {
      if (!state.recorder.categoryOn("llm")) return;
      const message = (event as { message?: unknown }).message;
      if (msgRole(message) !== "assistant") return;
      const tracks = state.recorder.trackSet();
      if (tracks === null) return;
      const startNs = state.recorder.captureTimestamp();
      // Pi streams one assistant message at a time. Preserve a missing END
      // explicitly instead of nesting a later response inside the old one.
      for (const stream of state.messageStreams.values()) {
        state.recorder.emitEnd(stream.span, {...assistantAnnotations({}, stream, startNs),
          "incomplete": true}, startNs);
      }
      state.messageStreams.clear();
      const span = state.recorder.beginSlice({cat: "llm", trackUuid: tracks.responseUuid,
        name: "response", tNs: startNs, annotations: {"kind": "assistant-message"}});
      if (span === null) return;
      state.messageStreams.set(msgId(message), {
        span, startNs,
        firstUpdateNs: null,
        updates: 0,
        bytes: 0,
      });
    });
  });

  pi.on("message_update", (event, ctx) => {
    const state = session;
    if (state === null) return;
    try {
      if (!state.recorder.categoryOn("llm")) return;
      const message = (event as { message?: unknown }).message;
      const stream = state.messageStreams.get(msgId(message));
      const bytes = deltaBytes(event);
      // Aggregate only actual content deltas; lifecycle/status updates do not
      // define TTFT. Keep aggregation even when verbose events are enabled.
      if (stream !== undefined && bytes > 0) {
        const now = state.recorder.captureTimestamp();
        if (stream.firstUpdateNs === null) stream.firstUpdateNs = now;
        stream.updates++;
        stream.bytes += bytes;
        // Retain measured partial-stream data if capture stops before message_end.
        state.recorder.annotateSpan(stream.span, {
          "updates": stream.updates,
          "bytes": stream.bytes,
          "first_content_ns": Number(stream.firstUpdateNs - stream.startNs),
        });
      }
      if (state.recorder.categoryOn("stream.verbose")) {
        const track = providerTrack();
        if (track !== null) state.recorder.emitInstant({ cat: "stream.verbose", trackUuid: track, name: "message_update" });
      }
    } catch {
      // ignore
    }
  });

  pi.on("message_end", (event, ctx) => {
    withSession(ctx, (state) => {
      const message = (event as { message?: unknown }).message;
      if (msgRole(message) !== "assistant") return;
      const endNs = state.recorder.captureTimestamp();
      state.recorder.recordTokenUsage(message, endNs);
      const id = msgId(message);
      const stream = state.messageStreams.get(id);
      state.messageStreams.delete(id);
      const annotations = assistantAnnotations(message, stream, endNs);
      if (stream !== undefined) {
        state.recorder.emitEnd(stream.span, annotations, endNs);
      } else {
        const track = state.recorder.trackSet()?.responseUuid;
        if (track !== undefined) state.recorder.emitInstant({cat: "llm", trackUuid: track,
          name: "response", tNs: endNs,
          annotations: {...annotations, "start_not_recorded": true}});
      }
    });
  });

  // -- provider --

  pi.on("before_provider_request", (_event, ctx) => {
    withSession(ctx, (state) => {
      state.recorder.setRunConfiguration(runConfiguration(ctx));
      if (state.recorder.categoryOn("llm")) state.recorder.recordContextTokens(ctx.getContextUsage()?.tokens);
      const track = providerTrack();
      if (track === null || !state.recorder.categoryOn("llm")) return;
      if (state.providerSpan !== null) return;
      // Pi's after_provider_response runs at response headers, before streaming.
      state.providerSpan = state.recorder.beginSlice({ cat: "llm", trackUuid: track, name: "request",
        annotations: { "kind": "provider-request", "phase": "response-headers",
          ...(state.contextMessages === undefined ? {} : {"context_messages": state.contextMessages}),
          ...(ctx.model ? { "provider": ctx.model.provider, "model": ctx.model.id } : {}) } });
    });
  });

  pi.on("after_provider_response", (event, ctx) => {
    withSession(ctx, (state) => {
      if (state.providerSpan !== null) {
        state.recorder.emitEnd(state.providerSpan, { "status_code": event.status });
        state.providerSpan = null;
        return;
      }
      const track = providerTrack();
      if (track === null || !state.recorder.categoryOn("llm")) return;
      state.recorder.emitInstant({ cat: "llm", trackUuid: track, name: "request",
        annotations: {"kind": "provider-request", "phase": "response-headers",
          "status_code": event.status, "start_not_recorded": true} });
    });
  });

  const finishCompaction = (state: SessionState, annotations: Record<string, string | number | boolean>, tNs: bigint) => {
    const pending = state.compaction;
    if (pending?.span !== null && pending?.span !== undefined) {
      state.recorder.emitEnd(pending.span, annotations, tNs);
    } else {
      const track = state.recorder.trackSet()?.compactionUuid;
      if (track !== undefined) state.recorder.emitInstant({cat: "session", trackUuid: track,
        name: "compact", tNs, annotations: {...annotations, "kind": "compaction",
          "start_not_recorded": true}});
    }
    state.compaction = null;
  };

  pi.on("session_before_compact", (event, ctx) => {
    withSession(ctx, (state) => {
      if (!state.recorder.isRecording()) return;
      const tNs = state.recorder.captureTimestamp();
      if (state.compaction?.span != null) {
        state.recorder.emitEnd(state.compaction.span, {"status": "interrupted", "incomplete": true}, tNs);
      }
      const beforeTokens = tokenCount(event.preparation.tokensBefore);
      if (beforeTokens !== undefined) state.recorder.recordContextTokens(beforeTokens, tNs);
      const track = state.recorder.trackSet()?.compactionUuid;
      const span = track === undefined ? null : state.recorder.beginSlice({cat: "session", trackUuid: track,
        name: "compact", tNs, annotations: {"kind": "compaction", "reason": event.reason,
          "will_retry": event.willRetry,
          ...(beforeTokens === undefined ? {} : {"tokens_before": beforeTokens})}});
      state.compaction = {span, beforeTokens};
    });
  });

  pi.on("session_compact", (event, ctx) => {
    withSession(ctx, (state) => {
      if (!state.recorder.isRecording()) return;
      const tNs = state.recorder.captureTimestamp();
      const finalBefore = tokenCount(event.compactionEntry.tokensBefore);
      if (finalBefore !== undefined) state.recorder.recordPeakContextTokens(finalBefore);
      const after = tokenCount(ctx.getContextUsage()?.tokens);
      if (after === undefined) state.recorder.invalidateContextTokens(tNs);
      else state.recorder.recordContextTokens(after, tNs);
      const usage = event.compactionEntry.usage;
      if (usage !== undefined) state.recorder.recordTokenUsage({usage}, tNs);
      const reported = reportedTokenUsage({usage});
      finishCompaction(state, {"status": "success", "reason": event.reason,
        "will_retry": event.willRetry, "from_extension": event.fromExtension,
        "context_after_known": after !== undefined,
        ...(after === undefined ? {} : {"tokens_after": after}),
        ...(finalBefore === undefined || finalBefore === state.compaction?.beforeTokens
          ? {} : {"tokens_before_final": finalBefore}),
        ...(reported.input === undefined ? {} : {"input_tokens": reported.input}),
        ...(reported.output === undefined ? {} : {"output_tokens": reported.output})}, tNs);
    });
  });

  pi.on("session_compact_failed", (event, ctx) => {
    withSession(ctx, (state) => {
      if (!state.recorder.isRecording()) return;
      finishCompaction(state, {"status": event.aborted ? "aborted" : "failed",
        "reason": event.reason, "will_retry": event.willRetry,
        "from_extension": event.fromExtension}, state.recorder.captureTimestamp());
    });
  });

  pi.on("context", (event, ctx) => {
    withSession(ctx, (state) => {
      const messages = (event as { messages?: unknown }).messages;
      // This is the count observed by our context hook, before later handlers
      // may transform the transcript. Reuse it for retries of this context.
      state.contextMessages = Array.isArray(messages) ? messages.length : undefined;
    });
  });

  // -- tools: canonical span = execution start -> end --

  pi.on("tool_call", (event, ctx) => {
    withSession(ctx, (state) => {
      const track = mainThreadTrack();
      if (track === null || !state.recorder.categoryOn("tools")) return;
      const toolName = String((event as { toolName?: unknown }).toolName ?? "unknown");
      if (TRACING_CONTROL_TOOLS.has(toolName)) return;
      const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
      // Causal-link flow: this issue instant shares one flow id with the
      // execution BEGIN on the tool lane. tool_execution_start fires before
      // tool_call, so the linkage is created there; the instant is stamped
      // 1ns before BEGIN, matching true causal order (issue precedes
      // execution — the hook itself runs after execution started).
      let flowIds: bigint[] | undefined;
      let issueNs: bigint | undefined;
      if (typeof toolCallId === "string") {
        const linkage = state.toolFlows.get(toolCallId);
        if (linkage !== undefined) {
          flowIds = [linkage.flowId];
          issueNs = linkage.beginNs > 0n ? linkage.beginNs - 1n : linkage.beginNs;
        } else {
          const tracks = state.recorder.trackSet();
          if (tracks !== null) {
            try {
              flowIds = [randomFlowId(tracks.used)];
            } catch {
              // Flow ids are best-effort; the instant is still recorded.
            }
          }
        }
      }
      const input = (event as { input?: unknown }).input;
      const annotations = toolArgumentAnnotations(input, state.recorder.getConfig().captureContents && state.recorder.categoryOn("contents"));
      annotations["name"] = toolName;
      if (typeof toolCallId === "string") annotations["call_id"] = toolCallId;
      state.recorder.emitInstant({ cat: "tools", trackUuid: track, name: "tool-preflight", flowIds, tNs: issueNs, annotations });
    });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    withSession(ctx, (state) => {
      const { toolCallId, toolName } = event as { toolCallId?: unknown; toolName?: unknown };
      if (typeof toolName === "string" && TRACING_CONTROL_TOOLS.has(toolName)) return;
      if (typeof toolCallId !== "string") return;
      const name = typeof toolName === "string" ? toolName : "tool";
      // Create the flow linkage first: the BEGIN carries the id, and
      // tool_call (which fires after this) attaches it to the issue instant.
      let flowIds: bigint[] | undefined;
      const tracks = state.recorder.trackSet();
      const startedNs = state.recorder.captureTimestamp();
      if (tracks !== null) {
        try {
          const flowId = randomFlowId(tracks.used);
          flowIds = [flowId];
          if (state.toolFlows.size >= 128) {
            const oldest = state.toolFlows.keys().next();
            if (!oldest.done) state.toolFlows.delete(oldest.value);
          }
          state.toolFlows.set(toolCallId, { flowId, beginNs: startedNs });
        } catch {
          // Flow ids are best-effort; the slice is still recorded.
        }
      }
      const rawArgs = event as {args?: unknown; input?: unknown};
      const launch = typeof toolName === "string" && state.recorder.categoryOn("workflow") &&
        state.recorder.getConfig().childTools.includes(toolName)
        ? describeChildLaunch(toolName, rawArgs.args ?? rawArgs.input) : null;
      if (launch !== null) delete launch.annotations.tool; // The tool span already records its name.
      const span = state.recorder.beginToolSlice(toolCallId, name, startedNs, flowIds, {
        // Workflow-only recording still captures delegation on the tool lane.
        deferBegin: launch !== null,
        category: launch !== null && !state.recorder.categoryOn("tools") ? "workflow" : "tools",
        annotations: launch === null ? undefined : {...launch.annotations, delegation: true},
      });
      if (span !== null) {
        state.toolSpans.set(toolCallId, span);
        if (launch !== null) {
          const task = typeof launch.annotations["task_id"] === "string" ? launch.annotations["task_id"] : null;
          const correlation = typeof launch.annotations["correlation"] === "string" ? launch.annotations["correlation"] : null;
          state.childLaunches.set(toolCallId, {task, correlation});
        }
      }
    });
  });

  pi.on("tool_execution_update", (event, ctx) => {
    const state = session;
    if (state === null) return;
    try {
      const { toolCallId, toolName } = event as { toolCallId?: unknown; toolName?: unknown };
      if (typeof toolName === "string" && TRACING_CONTROL_TOOLS.has(toolName)) return;
      if (typeof toolCallId !== "string") return;
      const span = state.toolSpans.get(toolCallId);
      if (span === undefined) return;
      if (state.recorder.categoryOn("stream.verbose")) {
        const track = providerTrack();
        if (track !== null) state.recorder.emitInstant({ cat: "stream.verbose", trackUuid: track, name: "tool_update" });
      }
      const partial = (event as { partialResult?: unknown }).partialResult;
      const currentBytes = partialResultBytes(partial);
      const previousBytes = state.toolLastPartialBytes.get(toolCallId) ?? 0;
      state.toolLastPartialBytes.set(toolCallId, currentBytes);
      // partialResult is cumulative; count only newly-added bytes.
      state.recorder.accumulate(span, Math.max(0, currentBytes - previousBytes));
    } catch {
      // ignore
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    withSession(ctx, (state) => {
      const { toolCallId, toolName, isError, result } = event as {
        toolCallId?: unknown;
        toolName?: unknown;
        isError?: unknown;
        result?: unknown;
      };
      if (typeof toolName === "string" && TRACING_CONTROL_TOOLS.has(toolName)) return;
      if (typeof toolCallId !== "string") return;
      const endedNs = state.recorder.captureTimestamp();
      const span = state.toolSpans.get(toolCallId);
      state.toolSpans.delete(toolCallId);
      state.toolLastPartialBytes.delete(toolCallId);
      state.toolFlows.delete(toolCallId);
      const launch = state.childLaunches.get(toolCallId);
      state.childLaunches.delete(toolCallId);
      const childSession = launch !== undefined && typeof toolName === "string"
        ? extractChildSessionId(toolName, result) : null;
      const childKey = childSession?.toLowerCase();
      const childFlow = childKey === undefined || state.linkedChildSessions.has(childKey)
        ? undefined : childPromptFlowId(childKey);
      if (childKey !== undefined) state.linkedChildSessions.add(childKey);
      const summary = span === undefined ? null : state.recorder.emitEnd(span, {
        "is_error": isError === true,
        ...(childSession === null ? {} : {child_session: childSession}),
      }, endedNs, childFlow === undefined ? undefined : [childFlow]);
      if (launch !== undefined) {
        state.recorder.noteChildLaunch({task: launch.task, childSession, correlation: launch.correlation});
      }
      if (summary !== null) return;
      const track = mainThreadTrack();
      if (track === null || !state.recorder.categoryOn("tools")) return;
      const name = typeof toolName === "string" ? toolName : "tool";
      state.recorder.emitInstant({
        cat: "tools",
        trackUuid: track,
        name: "tool-result",
        annotations: {"name": name, "call_id": toolCallId, "is_error": isError === true,
          "start_not_recorded": true},
      });
    });
  });

  pi.on("tool_result", (event, ctx) => {
    withSession(ctx, (state) => {
      if (typeof event.toolName === "string" && TRACING_CONTROL_TOOLS.has(event.toolName)) return;
      const span = state.toolSpans.get(event.toolCallId);
      const annotations = {"middleware_is_error": event.isError};
      if (span !== undefined && state.recorder.annotateSpan(span, annotations)) return;
      const track = mainThreadTrack();
      if (track === null || !state.recorder.categoryOn("tools")) return;
      const toolName = String((event as { toolName?: unknown }).toolName ?? "unknown");
      state.recorder.emitInstant({ cat: "tools", trackUuid: track, name: "tool-middleware",
        annotations: {"is_error": event.isError, "name": toolName, "call_id": event.toolCallId, "start_not_recorded": true} });
    });
  });

  // -- session / model / input / user_bash --

  pi.on("input", (event, ctx) => {
    withSession(ctx, (state) => {
      const childFlow = state.childPromptPending ? childPromptFlowId(sessionIdFor(ctx)) : undefined;
      state.childPromptPending = false;
      state.promptInputFlow = undefined;
      const track = sessionTrack();
      const tracks = state.recorder.trackSet();
      if (track === null || tracks === null || !state.recorder.categoryOn("session")) return;
      const source = String((event as { source?: unknown }).source ?? "?");
      const flowId = randomFlowId(tracks.used);
      if (state.recorder.emitInstant({ cat: "session", trackUuid: track, name: "prompt-input",
        flowIds: childFlow === undefined ? [flowId] : [flowId, childFlow], annotations: {"source": source} })) {
        // Keep the latest input until the next agent start; retries must not reuse it.
        state.promptInputFlow = flowId;
      }
    });
  });

  pi.on("user_bash", (event, ctx) => {
    // v3 contract: no duration/exit promise (no completion hook exists).
    withSession(ctx, (state) => {
      const track = sessionTrack();
      if (track === null || !state.recorder.categoryOn("bash")) return;
      const command = String((event as { command?: unknown }).command ?? "");
      state.recorder.emitInstant({
        cat: "bash",
        trackUuid: track,
        name: "user_bash",
        annotations: {"executable": sanitizeArgv0(command), "length": command.length},
      });
    });
  });

  pi.on("model_select", (event, ctx) => {
    withSession(ctx, (state) => {
      state.recorder.setRunConfiguration({...runConfiguration(ctx), model: event.model.id,
        provider: event.model.provider, contextWindowTokens: event.model.contextWindow});
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    withSession(ctx, (state) => {
      state.recorder.setRunConfiguration({...runConfiguration(ctx), effort: event.level});
    });
  });

  // -- commands --

  const statusText = async (): Promise<string> => {
    if (session === null) return "pi-tracing: no active session";
    const config = session.recorder.getConfig();
    const stats = session.recorder.getStats();
    const enabled = ALL_CATEGORIES.filter((id) => config.categories[id]).join(",");
    const machineId = session.recorder.getMachineId();
    const lines = [
      `pi-tracing ${TRACE_VERSION} state=${session.recorder.getState()} startupMode=${config.startupMode}`,
      `categories on: ${enabled === "" ? "(none)" : enabled}`,
      `clock primary=REALTIME machineId=${machineId === 0 ? "host-default (boot identity unavailable)" : machineId}`,
      `pending=${stats.pending} (${stats.queuedBytes}B) packets=${stats.packets} dropped=${stats.dropped} openSpans=${stats.openSpans} laneOverflows=${stats.laneOverflows}`,
      `prompt-data=${config.categories["prompt-data"] ? "ON (prompt text)" : "off (length only)"} captureContents=${config.captureContents && config.categories.contents ? "ON (tool arguments only)" : "off"} maxFileMB=${config.maxFileMB} laneCap=${config.laneCap}${stats.fileLimitReached ? " FILE-LIMIT-REACHED" : ""}`,
      childEnvSummary(),
    ];
    const configError = session.recorder.getConfigError();
    if (configError !== null) lines.push(`config: ${configError}`);
    if (stats.writeError !== undefined) lines.push(`writer: ${stats.writeError}`);
    const last = session.recorder.getLastTrace();
    if (last !== null) {
      lines.push(`last trace: ${last.recordingPath ?? last.path} packets=${last.packets} dropped=${last.droppedEvents}${last.shutdownTruncated ? " TRUNCATED" : ""} (${last.reason})`);
    }
    const launches = session.recorder.getChildLaunches();
    if (launches.length > 0) {
      lines.push(`child launches: ${launches.length} (included in the session recording)`);
    }
    const siblings = listRecentTraceFiles(5);
    if (siblings.length > 0) {
      lines.push(`recent recordings:`);
      for (const sibling of siblings) lines.push(`- ${sibling}`);
    }
    return lines.join("\n");
  };

  /** Newest `.pftrace` files in the shared output dir — harness-agnostic
   * discovery for independent top-level recordings. */
  const listRecentTraceFiles = (limit: number): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(defaultOutDir(getAgentDir()));
    } catch {
      return [];
    }
    const files: Array<{ name: string; mtimeMs: number; size: number }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".pftrace")) continue;
      try {
        const info = statSync(join(defaultOutDir(getAgentDir()), entry));
        files.push({ name: entry, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Vanished mid-scan; skip.
      }
    }
    return files
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, limit))
      .map((file) => `${file.name} (${describeBytes(file.size)}, ${Math.round(Math.max(0, Date.now() - file.mtimeMs) / 1000)}s ago)`);
  };

  /** Shared stop reporting for the `stop` command and the toggle shortcut:
   * the owner publishes one file containing the participating processes. */
  const reportStopResult = async (ctx: ExtensionContext, manifest: TraceManifest | null): Promise<void> => {
    if (session === null) return;
    if (manifest === null) {
      notify(ctx, "pi-tracing: nothing recording", "warning");
      return;
    }
    const head = `pi-tracing: ${manifest.recordingPath ? "contributed to" : manifest.shutdownTruncated ? "retained" : "published"} ${manifest.recordingPath ?? manifest.path} (${manifest.packets} packets, ${manifest.droppedEvents} dropped${manifest.error ? `, error: ${manifest.error}` : ""})`;
    const detail = manifest.incompleteProcesses ? " Some child processes could not flush before stop; their available events are included and open spans are marked incomplete." : "";
    notify(ctx, head + detail, manifest.shutdownTruncated || manifest.error || manifest.incompleteProcesses ? "warning" : "info");
  };

  const startCapture = async (ctx: ExtensionContext, name?: string, outputPath?: string) => {
    if (session === null) return {started: false, message: "no active Pi session", path: undefined};
    const state = session;
    if (outputPath !== undefined && (outputPath.trim() === "" || !outputPath.endsWith(".pftrace"))) {
      return {started: false, message: "output_path must name a .pftrace file", path: undefined};
    }
    state.recorder.setRunConfiguration(runConfiguration(ctx));
    const started = await state.recorder.start(name, outputPath === undefined ? undefined : resolve(ctx.cwd, outputPath));
    if (started.started) {
      clearCorrelationState(state);
      syncChildEnv();
    }
    refreshWidget(ctx);
    return {...started, path: state.recorder.getRecordingPath()};
  };

  const stopCapture = async (ctx: ExtensionContext, reason: string): Promise<TraceManifest | null> => {
    if (session === null) return null;
    const manifest = await session.recorder.stop(reason);
    clearCorrelationState(session);
    syncChildEnv();
    refreshWidget(ctx);
    return manifest;
  };

  pi.registerTool({
    name: "tracing_start",
    label: "Start tracing",
    description: "Start an Agent Profiler recording. Optionally label it and choose the final .pftrace path. Returns the expected absolute trace path; call tracing_stop to publish it.",
    executionMode: "sequential",
    parameters: Type.Object({
      name: Type.Optional(Type.String({description: "Short capture label"})),
      output_path: Type.Optional(Type.String({description: "Final .pftrace path, absolute or relative to the current directory"})),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await startCapture(ctx, params.name, params.output_path);
      return {content: [{type: "text", text: result.started
        ? `Tracing started. Expected trace: ${result.path}`
        : `Tracing did not start: ${result.message}${result.path ? ` (current trace: ${result.path})` : ""}`}],
        details: {started: result.started, path: result.path, message: result.message},
        isError: !result.started};
    },
  });

  pi.registerTool({
    name: "tracing_stop",
    label: "Stop tracing",
    description: "Stop and publish the current Agent Profiler recording. Returns the actual .pftrace path and any finalization warning.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const manifest = await stopCapture(ctx, "tool");
      if (manifest === null) return {content: [{type: "text", text: "No recording is active."}],
        details: {stopped: false}, isError: true};
      const path = manifest.shutdownTruncated ? manifest.path : manifest.recordingPath ?? manifest.path;
      const successful = !manifest.shutdownTruncated && manifest.error === undefined;
      const published = !manifest.shutdownTruncated && manifest.recordingPath === undefined;
      const warning = manifest.error ?? (manifest.incompleteProcesses ? "some child processes did not flush completely" : undefined);
      return {content: [{type: "text", text: `${manifest.shutdownTruncated ? "Retained" : manifest.recordingPath ? "Contributed to" : "Published"} trace: ${path}${warning ? `; warning: ${warning}` : ""}`}],
        details: {stopped: true, path, published, contributed: manifest.recordingPath !== undefined, packets: manifest.packets,
          droppedEvents: manifest.droppedEvents, incompleteProcesses: manifest.incompleteProcesses ?? false,
          warning}, isError: !successful};
    },
  });

  pi.registerCommand("tracing", {
    description: "Self-controlled Perfetto capture: start|stop|status|categories|probe|arm|disarm",
    handler: async (raw, ctx) => {
      const args = raw.trim().split(/\s+/).filter((part) => part !== "");
      const sub = args.shift() ?? "status";
      if (session === null) {
        notify(ctx, "pi-tracing: no active session", "warning");
        return;
      }
      if (sub === "status") {
        notify(ctx, await statusText(), "info");
        refreshWidget(ctx);
        return;
      }
      if (sub === "start") {
        const name = args.join("-").slice(0, 40);
        const started = await startCapture(ctx, name === "" ? undefined : name);
        notify(ctx, `pi-tracing: ${started.message}`, started.started ? "info" : "warning");
        return;
      }
      if (sub === "stop") {
        const manifest = await stopCapture(ctx, "stop");
        await reportStopResult(ctx, manifest);
        return;
      }
      if (sub === "categories") {
        const rest = args;
        if (rest.length === 0) {
          const config = session.recorder.getConfig();
          const lines = ALL_CATEGORIES.map((id) => `${id}=${config.categories[id] ? "on" : "off"}`).join(" ");
          notify(ctx, `pi-tracing categories: ${lines}`, "info");
          return;
        }
        if (rest[0] === "save") {
          const error = saveGlobalConfig(session.recorder.getConfig());
          notify(ctx, error ?? "pi-tracing: global config saved", error ? "error" : "info");
          return;
        }
        const [id, value] = rest as [string?, string?];
        if (id === undefined || !ALL_CATEGORIES.includes(id as CategoryId)) {
          notify(ctx, `pi-tracing: unknown category "${id ?? ""}" (try: ${ALL_CATEGORIES.join(" ")})`, "error");
          return;
        }
        const cat = id as CategoryId;
        if (cat === "system" && value !== "off") {
          notify(ctx, "pi-tracing: system capture is reserved for the native-helper follow-up; staying off", "warning");
          return;
        }
        const config = session.recorder.getConfig();
        if (value === "on") config.categories[cat] = true;
        else if (value === "off") config.categories[cat] = false;
        else {
          notify(ctx, 'pi-tracing: usage: /tracing categories <name> <on|off> (or "save", or no args to list)', "error");
          return;
        }
        session.recorder.setConfig(config);
        notify(ctx, `pi-tracing: ${cat}=${value}`, "info");
        refreshWidget(ctx);
        return;
      }
      if (sub === "probe") {
        notify(ctx, formatProbe(runProbe()), "info");
        return;
      }
      if (sub === "arm" || sub === "disarm") {
        notify(ctx, "pi-tracing: ARMED flight recorder lands in P3; use start/stop for now", "warning");
        return;
      }
      notify(ctx, "pi-tracing: usage: /tracing start|stop|status|categories|probe|arm|disarm", "error");
    },
  });

  // -- shortcuts (TUI only; commands/flags cover headless) --

  try {
    pi.registerShortcut("ctrl+shift+t", {
      description: "Toggle pi-tracing recording (start or stop)",
      handler: async (ctx) => {
        if (session === null) return;
        if (session.recorder.isRecording()) {
          const manifest = await stopCapture(ctx, "shortcut");
          await reportStopResult(ctx, manifest);
        } else {
          const started = await startCapture(ctx);
          notify(ctx, `pi-tracing: ${started.message}`, started.started ? "info" : "warning");
        }
      },
    });
  } catch {
    // Shortcut unavailable on this runtime: commands remain.
  }

}

function saveGlobalConfig(config: TracingConfig): string | undefined {
  try {
    const path = join(getAgentDir(), GLOBAL_CONFIG_NAME);
    mkdirSync(join(getAgentDir()), { recursive: true });
    // This command is intentionally category-scoped: do not persist temporary
    // project/env/CLI overrides (especially autostart or content capture).
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const payload = { ...existing, categories: { ...config.categories } };
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    return undefined;
  } catch (error) {
    return `pi-tracing: could not save global config: ${error instanceof Error ? error.message : String(error)}`;
  }
}
