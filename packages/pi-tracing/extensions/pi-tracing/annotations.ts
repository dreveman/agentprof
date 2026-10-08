// SPDX-License-Identifier: Apache-2.0
import type { DebugAnnotationValue } from "./encoder.ts";

export const SCHEMA_VERSION = 1;
export const TRACE_VERSION = "0.1.0-internal";
type Attrs = Record<string, DebugAnnotationValue>;

/** Script metadata remains useful when source capture is disabled or bounded. */
export function scriptAnnotations(language: string, code: unknown): Attrs {
  if (typeof code !== 'string') return {language};
  if (!code.length) return {language, line_count: 0};
  // Count without allocating an array proportional to an uncaptured script.
  let lines = 1;
  for (let i = 0; i < code.length; i++) {
    const char = code.charCodeAt(i);
    if (char === 13) {lines++; if (code.charCodeAt(i + 1) === 10) i++;}
    else if (char === 10) lines++;
  }
  if (/[\r\n]$/.test(code)) lines--;
  return {language, line_count: lines};
}

/** Full values, metadata-only (for content-on preflight), or no traversal at
 * all when the recording policy disables content. A false boolean remains a
 * convenient shorthand for disabled; it must not serialize the input. */
export function toolArgumentAnnotations(input: unknown, mode: boolean | 'metadata' | 'disabled'): Attrs {
  if (mode === false || mode === 'disabled') return {};
  const attrs: Attrs = {};
  let json: string | undefined;
  try { json = JSON.stringify(input); } catch { /* Invalid/circular input. */ }
  if (json === undefined) {
    attrs["serializable"] = false;
    return attrs;
  }
  attrs["bytes"] = new TextEncoder().encode(json).length;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const keys = Object.keys(input);
    attrs["keys"] = keys.slice(0, 12).map(key => key.slice(0, 200));
    if (keys.length > 12 || keys.some(key => key.length > 200)) attrs["keys_truncated"] = true;
  }
  if (mode === 'metadata') return attrs;
  let remainingNodes = 128;
  let remainingText = 65536;
  let truncated = false;
  const copy = (value: unknown, depth: number): DebugAnnotationValue | undefined => {
    if (--remainingNodes < 0 || depth > 8) { truncated = true; return undefined; }
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value === "string") {
      let size = Math.min(value.length, remainingText);
      if (size < value.length && size > 0 && /[\uD800-\uDBFF]/.test(value[size - 1]!)) size--;
      remainingText -= size;
      if (size < value.length) truncated = true;
      return value.slice(0, size);
    }
    if (Array.isArray(value)) {
      const result: DebugAnnotationValue[] = [];
      for (const item of value) {
        const child = copy(item, depth + 1);
        // Preserve array positions: keep a prefix rather than removing holes.
        if (child === undefined) break;
        result.push(child);
      }
      return result;
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, DebugAnnotationValue> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (remainingNodes <= 0 || remainingText < key.length) { truncated = true; break; }
        remainingText -= key.length;
        const child = copy(item, depth + 1);
        if (child !== undefined) result[key] = child;
      }
      return result;
    }
    // DebugAnnotation has no null scalar representation.
    truncated = true;
    return undefined;
  };
  const value = copy(JSON.parse(json), 0);
  if (value !== undefined) attrs["args"] = value;
  if (truncated) attrs["truncated"] = true;
  return attrs;
}

/** Keep prompt packets bounded without silently losing the operation itself. */
export function promptAnnotations(prompt: unknown, captureText: boolean): Attrs {
  if (typeof prompt !== "string") return {};
  const attrs: Attrs = {"length": prompt.length};
  if (captureText) {
    let limit = 65536;
    // Do not split a UTF-16 surrogate pair at the capture limit.
    if (prompt.length > limit && /[\uD800-\uDBFF]/.test(prompt[limit - 1]!)) limit--;
    attrs["text"] = prompt.slice(0, limit);
    if (prompt.length > limit) attrs["truncated"] = true;
  }
  return attrs;
}

export interface RunConfiguration {
  sessionLabels?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
  contextWindowTokens?: unknown;
}

export function runConfigurationAnnotations(config: RunConfiguration): Attrs {
  const attrs: Attrs = { "harness": "pi" };
  if (Array.isArray(config.sessionLabels)) {
    const labels = [...new Set(config.sessionLabels.slice(0, 32)
      .filter((label): label is string => typeof label === "string")
      .map(label => label.trim()).filter(label => label.length > 0 && label.length <= 100))];
    if (labels.length > 0) attrs["session_labels"] = labels;
  }
  for (const key of ["model", "provider", "effort"] as const) {
    const value = config[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 200) {
      attrs[key] = value;
    }
  }
  const contextWindowTokens = tokenCount(config.contextWindowTokens);
  if (contextWindowTokens !== undefined && contextWindowTokens > 0) {
    attrs["context_window_tokens"] = contextWindowTokens;
  }
  return attrs;
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function reportedTokenUsage(message: unknown): { input?: number; output?: number } {
  const usage = record(record(message).usage);
  return { input: tokenCount(usage.input), output: tokenCount(usage.output) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Whitelist metadata only. Missing/invalid usage stays absent, never zero. */
export function assistantAnnotations(message: unknown, stream: {
  startNs: bigint;
  firstUpdateNs: bigint | null;
  updates: number;
  bytes: number;
} | undefined, endNs: bigint): Attrs {
  const attrs: Attrs = {
    "kind": "assistant-message",
    ...(stream === undefined ? {} : {
      "duration_ns": Number(endNs - stream.startNs),
      "updates": stream.updates,
      "bytes": stream.bytes,
    }),
  };
  if (stream !== undefined && stream.firstUpdateNs !== null) {
    attrs["first_content_ns"] = Number(stream.firstUpdateNs - stream.startNs);
  }
  const msg = record(message);
  for (const key of ["provider", "model", "stopReason"] as const) {
    if (typeof msg[key] === "string" && msg[key].length <= 200) {
      attrs[key === "stopReason" ? "stop_reason" : key] = msg[key];
    }
  }
  const usage = record(msg.usage);
  const tokenFields = {input: "input_tokens", output: "output_tokens", cacheRead: "cache_read_tokens",
    cacheWrite: "cache_write_tokens", totalTokens: "total_tokens"} as const;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const value = usage[key];
    if (tokenCount(value) !== undefined) {
      attrs[tokenFields[key]] = value as number;
    }
  }
  return attrs;
}
