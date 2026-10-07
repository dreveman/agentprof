// SPDX-License-Identifier: Apache-2.0
import {createHash} from "node:crypto";

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

export function randomCorrelationId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function rigLaunchInfo(args: Record<string, unknown>, annotations: Record<string, string | number | boolean>): string {
  const taskId = asBoundedString(args["task_id"], 64);
  const rootId = asBoundedString(args["root_id"], 64);
  const namespace = asBoundedString(args["namespace"], 64);
  const expectedSession = asBoundedString(args["expected_session_id"], 64);
  const mode = asBoundedString(args["mode"], 16);
  if (taskId !== undefined) annotations["task_id"] = taskId;
  if (rootId !== undefined) annotations["root_id"] = rootId;
  if (namespace !== undefined) annotations["namespace"] = namespace;
  if (expectedSession !== undefined && UUID_PATTERN.test(expectedSession)) {
    annotations["expected_session"] = expectedSession;
  }
  if (mode !== undefined) annotations["mode"] = mode;
  return "launch";
}

function subagentInfo(args: Record<string, unknown>, annotations: Record<string, string | number | boolean>): string {
  // bg-tasks/typed subagent args carry free-form task text: lengths only.
  let taskBytes = 0;
  try {
    taskBytes = new TextEncoder().encode(JSON.stringify(args) ?? "").length;
  } catch {
    taskBytes = -1;
  }
  annotations["task_bytes"] = taskBytes;
  const type = asBoundedString(args["type"], 64);
  if (type !== undefined) annotations["subagent_type"] = type;
  return "delegate";
}

/** Describe one child-agent launch/delegate tool call. Returns null when the
 * tool is not a recognized child spawner (caller checks childTools first;
 * this only shapes known tools, unknown tools get a generic label). */
export function describeChildLaunch(toolName: string, args: unknown): ChildLaunchInfo {
  const annotations: Record<string, string | number | boolean> = {
    correlation: randomCorrelationId(),
    tool: toolName.slice(0, 64),
  };
  const record = asRecord(args);
  let label: string;
  if (toolName === "rig_launch" && record !== null) {
    label = rigLaunchInfo(record, annotations);
  } else if (toolName === "subagent" && record !== null) {
    label = subagentInfo(record, annotations);
  } else {
    label = "launch";
  }
  return { label, annotations };
}

/** Best-effort extraction of the child's session UUID from a launch tool's
 * result content (e.g. rig_launch's "Spawned detached Pi session <uuid>"). */
export function extractChildSessionId(toolName: string, result: unknown): string | null {
  void toolName;
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
  ownerPid?: number;
  subagentType?: string;
  sessionKeyBytes?: number;
}

/** Detect that this Pi process is itself a spawned child worker. Reads only
 * the standard orchestrator-provided variables; never model content. */
export function detectChildRole(env: NodeJS.ProcessEnv): ChildRoleInfo | null {
  if (env["WORKFLOW_RIG_PROCESS"] === "worker") {
    const info: ChildRoleInfo = { role: "rig-worker" };
    const parent = env["DEVMATE_PARENT_SESSION_ID"];
    if (typeof parent === "string" && UUID_PATTERN.test(parent)) info.parentSession = parent;
    const owner = env["WORKFLOW_RIG_OWNER_PID"];
    if (typeof owner === "string" && /^[0-9]{1,10}$/.test(owner)) info.ownerPid = Number(owner);
    return info;
  }
  const subagentType = env["PI_SUBAGENT_TYPE"];
  if (typeof subagentType === "string" && subagentType !== "") {
    const info: ChildRoleInfo = { role: "subagent", subagentType: subagentType.slice(0, 64) };
    const parent = env["DEVMATE_PARENT_SESSION_ID"];
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
