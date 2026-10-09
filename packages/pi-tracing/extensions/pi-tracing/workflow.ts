// SPDX-License-Identifier: Apache-2.0
import {createHash, randomBytes} from "node:crypto";

// Pure, testable helpers for child-agent (workflow) tracing. No Pi imports:
// parent-side launch description, child session extraction, and child-side
// role detection from the environment. All outputs are metadata-only —
// identifiers needed for parent/child correlation plus lengths, never bodies.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SCAN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Stable, nonzero ID for delegation to a session's first prompt. */
export function childPromptFlowId(sessionId: string): bigint | undefined {
  if (!UUID_PATTERN.test(sessionId)) return undefined;
  return createHash("sha256").update(`pi.delegation.first-prompt:${sessionId.toLowerCase()}`)
    .digest().readBigUInt64LE(0) || 1n;
}

function asBoundedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Tool payloads are usually plain JSON, but metadata collection must never
// invoke an accessor or toJSON supplied by an arbitrary tool implementation.
function ownValue(value: Record<string, unknown>, key: string): unknown {
  try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}
}

export function randomCorrelationId(): string {
  return randomBytes(4).toString("hex");
}

/** Append our extension path to a comma-separated `--extension` list without
 * duplicating entries. Pure helper for child-env mirroring (tested). */
export function mergeExtensionPath(existing: string | undefined, own: string): string {
  const parts = (existing ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (!parts.includes(own)) parts.push(own);
  return parts.join(",");
}

export interface ChildLaunchInfo {
  /** Short display label for the workflow slice (identifiers only). */
  label: string;
  /** Bounded debug annotations for the BEGIN event. */
  annotations: Record<string, string | number | boolean>;
}

function workflowLaunchInfo(args: Record<string, unknown>, annotations: Record<string, string | number | boolean>): string {
  const taskId = asBoundedString(ownValue(args, "task_id"), 64);
  const rootId = asBoundedString(ownValue(args, "root_id"), 64);
  const namespace = asBoundedString(ownValue(args, "namespace"), 64);
  const expectedSession = asBoundedString(ownValue(args, "expected_session_id"), 64);
  const mode = asBoundedString(ownValue(args, "mode"), 16);
  if (taskId !== undefined) annotations["task_id"] = taskId;
  if (rootId !== undefined) annotations["root_id"] = rootId;
  if (namespace !== undefined) annotations["namespace"] = namespace;
  if (expectedSession !== undefined && UUID_PATTERN.test(expectedSession)) {
    annotations["expected_session"] = expectedSession;
  }
  if (mode !== undefined) annotations["mode"] = mode;
  return "launch";
}

function subagentInfo(args: Record<string, unknown>, annotations: Record<string, string | number | boolean>, captureContents: boolean): string {
  // Only content-enabled captures calculate exact JSON size. Disabled captures
  // must not stringify even when they retain the stable subagent type.
  if (captureContents) {
    let taskBytes = 0;
    try {taskBytes = new TextEncoder().encode(JSON.stringify(args) ?? "").length;}
    catch {taskBytes = -1;}
    annotations["task_bytes"] = taskBytes;
  }
  const type = asBoundedString(ownValue(args, "type"), 64);
  if (type !== undefined) annotations["subagent_type"] = type;
  return "delegate";
}

/** Describe one child-agent launch/delegate tool call. Returns null when the
 * tool is not a recognized child spawner (caller checks childTools first;
 * this only shapes known tools, unknown tools get a generic label). */
export function describeChildLaunch(toolName: string, args: unknown, captureContents = true): ChildLaunchInfo {
  const annotations: Record<string, string | number | boolean> = {
    correlation: randomCorrelationId(),
    tool: toolName.slice(0, 64),
  };
  const record = asRecord(args);
  let label: string;
  if (toolName === "subagent" && record !== null) {
    label = subagentInfo(record, annotations, captureContents);
  } else if (record !== null) {
    label = workflowLaunchInfo(record, annotations);
  } else {
    label = "launch";
  }
  return { label, annotations };
}

/** Best-effort extraction of the child's session UUID from a launch tool's
 * result content (e.g. "Spawned detached Pi session <uuid>"). */
export function extractChildSessionId(toolName: string, result: unknown, captureContents = true): string | null {
  void toolName;
  if (!captureContents) {
    // Search known result wrappers without serializing arbitrarily large tool
    // output. Correlation is best-effort when content is disabled.
    const pending: unknown[] = [result], seen = new WeakSet<object>();
    for (let visited = 0; pending.length && visited < 128; visited++) {
      const value = pending.shift();
      if (typeof value === 'string') {
        const match = UUID_SCAN.exec(value.slice(0, 8192));
        if (match) return match[0];
      } else if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 128); i++) try {pending.push(value[i]);} catch {}
      } else if (value && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        const record = value as Record<string, unknown>;
        for (const key of ['child_session_id', 'childSession', 'session_id', 'sessionId', 'text', 'output', 'result', 'content'])
          pending.push(ownValue(record, key));
      }
    }
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(result) ?? "";
  } catch {
    return null;
  }
  if (text.length > 8192) text = text.slice(0, 8192);
  const match = UUID_SCAN.exec(text);
  return match !== null ? match[0] : null;
}

export interface ChildRoleInfo {
  /** Stable role token for labels and track names (no free-form text). */
  role: string;
  parentSession?: string;
  subagentType?: string;
  sessionKeyBytes?: number;
}

/** Detect that this Pi process is itself a spawned child worker. Reads only
 * the standard orchestrator-provided variables; never model content. */
export function detectChildRole(env: NodeJS.ProcessEnv): ChildRoleInfo | null {
  const subagentType = env["PI_SUBAGENT_TYPE"];
  if (typeof subagentType === "string" && subagentType !== "") {
    const info: ChildRoleInfo = { role: "subagent", subagentType: subagentType.slice(0, 64) };
    const parent = env["PI_TRACING_PARENT_SESSION_ID"];
    if (typeof parent === "string" && UUID_PATTERN.test(parent)) info.parentSession = parent;
    const sessionKey = env["PI_SUBAGENT_SESSION_KEY"];
    if (typeof sessionKey === "string") {
      try {
        info.sessionKeyBytes = new TextEncoder().encode(sessionKey).length;
      } catch {
        info.sessionKeyBytes = -1;
      }
    }
    return info;
  }
  return null;
}
