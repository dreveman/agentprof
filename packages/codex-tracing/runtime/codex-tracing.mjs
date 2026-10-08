#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// packages/codex-tracing/plugin.ts
import { spawn as spawn2, spawnSync } from "node:child_process";
import { createHash as createHash5, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync5, openSync as openSync2, closeSync as closeSync2, readFileSync as readFileSync8, renameSync as renameSync3, rmdirSync as rmdirSync2, rmSync as rmSync2, unlinkSync as unlinkSync4 } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createInterface as createInterface2 } from "node:readline";
import { dirname as dirname4, join as join5, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { setTimeout as delay3 } from "node:timers/promises";

// packages/codex-tracing/plugin-config.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
function privateSocketPath(generation) {
  if (!/^[0-9a-f]{32}$/.test(generation))
    throw new Error("Invalid receiver generation.");
  const directory = mkdtempSync("/tmp/agentprof-codex-");
  chmodSync(directory, 448);
  return join(directory, `receiver-${generation}.sock`);
}
function privateSocketDirectory(socket, generation) {
  const directory = dirname(socket);
  if (dirname(directory) !== "/tmp" || !/^agentprof-codex-[A-Za-z0-9]{6}$/.test(basename(directory)) || socket !== join(directory, `receiver-${generation}.sock`))
    return;
  if (existsSync(directory)) {
    const stat = statSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 511) !== 448)
      throw new Error("Unsafe Codex recorder socket directory.");
  }
  return directory;
}
function stateDirectory(pluginData) {
  if (pluginData) {
    let directory = resolve(pluginData);
    while (dirname(directory) !== directory) {
      if (basename(directory) === "plugins")
        return join(dirname(directory), "agentprof");
      directory = dirname(directory);
    }
    throw new Error("Cannot locate Codex home from PLUGIN_DATA.");
  }
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "agentprof");
}
function readConnection(state) {
  const value = JSON.parse(readFileSync(join(state, "connection.json"), "utf8"));
  const legacyPort = Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535;
  const privateSocket = value.run === true && typeof value.socket === "string" && /^[0-9a-f]{32}$/.test(value.generation) && privateSocketDirectory(value.socket, value.generation);
  if (!legacyPort && !privateSocket || !/^[0-9a-f]{64}$/.test(value.token) || value.generation !== undefined && !/^[0-9a-f]{32}$/.test(value.generation) || value.run !== undefined && value.run !== true)
    throw new Error("Invalid Agent Profiler connection configuration.");
  return value;
}
var hookEvents = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt"
];
function hookProfile(state, runtime, autoStart) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const hookCommand = `${quote(process.execPath)} ${quote(runtime)} hook --state ${quote(state)}`;
  const windowsCommand = `"${process.execPath}" "${runtime}" hook --state "${state}"`;
  return `# Agent Profiler hooks (no persistent telemetry endpoint)
` + `[features]
hooks = true

[plugins."agentprof@agentprof"]
enabled = true

` + hookEvents.map((event) => `[[hooks.${event}]]
[[hooks.${event}.hooks]]
type = "command"
` + `command = ${JSON.stringify(hookCommand + (autoStart && event === "SessionStart" ? " --auto-start" : ""))}
` + `commandWindows = ${JSON.stringify(windowsCommand + (autoStart && event === "SessionStart" ? " --auto-start" : ""))}
` + `timeout = ${["SessionEnd", "Interrupt"].includes(event) ? 3 : 15}
`).join(`
`);
}
function writeInstalledProfile(state, codexHome, runtime, autoStart = false) {
  mkdirSync(state, { recursive: true, mode: 448 });
  const path = join(codexHome, "agentprof.config.toml"), marker = join(state, "profile.sha256");
  const profile = hookProfile(state, runtime, autoStart);
  if (existsSync(path) && readFileSync(path, "utf8") !== profile) {
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (!existsSync(marker) || readFileSync(marker, "utf8") !== hash)
      throw new Error(`Profile already exists with different settings: ${path}`);
  }
  const hash = createHash("sha256").update(profile).digest("hex");
  if (existsSync(path) && readFileSync(path, "utf8") === profile && existsSync(marker) && readFileSync(marker, "utf8") === hash)
    return path;
  const nonce = randomBytes(8).toString("hex");
  const pending = join(state, "profile-pending.sha256");
  const temporary = join(codexHome, `.agentprof-profile-${nonce}.tmp`);
  const temporaryMarker = join(state, `profile-${nonce}.tmp`);
  try {
    writeFileSync(temporary, profile, { flag: "wx", mode: 384 });
    writeFileSync(temporaryMarker, hash, { flag: "wx", mode: 384 });
    writeFileSync(pending, hash, { mode: 384 });
    renameSync(temporary, path);
    renameSync(temporaryMarker, marker);
    unlinkSync(pending);
  } finally {
    for (const file of [temporary, temporaryMarker])
      if (existsSync(file))
        unlinkSync(file);
  }
  return path;
}

// packages/codex-tracing/plugin-collector.ts
import { createServer } from "node:http";
import { createHash as createHash3 } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeFileSync as writeFileSync3, readFileSync as readFileSync6, existsSync as existsSync3, mkdirSync as mkdirSync3, unlinkSync as unlinkSync3, chmodSync as chmodSync2, rmdirSync } from "node:fs";
import { join as join3, dirname as dirname3 } from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

// packages/codex-tracing/plugin-journal.ts
import { mkdirSync as mkdirSync2, openSync, writeSync, fsyncSync, closeSync, readFileSync as readFileSync4, writeFileSync as writeFileSync2, existsSync as existsSync2, linkSync, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname as dirname2, join as join2, resolve as resolve2, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

// packages/pi-tracing/extensions/pi-tracing/tracer.ts
import { constants as fsConstants, readFileSync as readFileSync3 } from "node:fs";
import { hostname, uptime } from "node:os";

// packages/pi-tracing/extensions/pi-tracing/encoder.ts
var WIRE_VARINT = 0;
var WIRE_FIXED64 = 1;
var WIRE_LD = 2;
var TRACK_EVENT_BEGIN = 1;
var TRACK_EVENT_END = 2;
var TRACK_EVENT_INSTANT = 3;
var TRACK_EVENT_COUNTER = 4;
var SIBLING_MERGE_BY_TRACK_NAME = 1;
var SIBLING_MERGE_NONE = 2;
var CLOCK_REALTIME = 1;
var CLOCK_BOOTTIME = 6;
var COUNTER_UNIT_UNSPECIFIED = 0;
var COUNTER_UNIT_COUNT = 2;
var COUNTER_UNIT_BYTES = 3;
var textEncoder = new TextEncoder;
function encodeVarint(value) {
  let x = typeof value === "number" ? BigInt(value) : value;
  if (x < 0n)
    throw new Error("pi-tracing encoder: negative varint unsupported");
  const out = [];
  while (x > 0x7fn) {
    out.push(Number(x & 0x7fn | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}
function encodeFixed64(value) {
  let x = typeof value === "number" ? BigInt(value) : value;
  if (x < 0n)
    throw new Error("pi-tracing encoder: negative fixed64 unsupported");
  const out = [];
  for (let i = 0;i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}
function encodeTag(fieldNo, wire) {
  return encodeVarint(fieldNo << 3 | wire);
}
function encodeUint32Field(fieldNo, value) {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new Error(`pi-tracing encoder: uint32 out of range (field ${fieldNo})`);
  }
  return [...encodeTag(fieldNo, WIRE_VARINT), ...encodeVarint(value)];
}
function encodeUint64Field(fieldNo, value) {
  return [...encodeTag(fieldNo, WIRE_VARINT), ...encodeVarint(value)];
}
function encodeStringField(fieldNo, value) {
  const bytes = textEncoder.encode(value);
  return [
    ...encodeTag(fieldNo, WIRE_LD),
    ...encodeVarint(bytes.length),
    ...bytes
  ];
}
function encodeBytesField(fieldNo, bytes) {
  const len = bytes.length;
  return [...encodeTag(fieldNo, WIRE_LD), ...encodeVarint(len), ...bytes];
}
function encodeFixed64Field(fieldNo, value) {
  return [...encodeTag(fieldNo, WIRE_FIXED64), ...encodeFixed64(value)];
}
function concat(...parts) {
  const out = [];
  for (const part of parts) {
    for (const byte of part)
      out.push(byte);
  }
  return out;
}
function toU8(bytes) {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}
function encodeDoubleField(fieldNo, value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...encodeTag(fieldNo, WIRE_FIXED64), ...bytes];
}
function buildDebugAnnotation(name, value) {
  const parts = name === undefined ? [] : [encodeStringField(10, name)];
  if (typeof value === "boolean") {
    parts.push(encodeUint32Field(2, value ? 1 : 0));
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      parts.push(encodeUint64Field(value >= 0 ? 3 : 4, BigInt.asUintN(64, BigInt(value))));
    } else {
      parts.push(encodeDoubleField(5, value));
    }
  } else if (typeof value === "string") {
    parts.push(encodeStringField(6, value));
  } else if (Array.isArray(value)) {
    for (const item of value)
      parts.push(encodeBytesField(12, buildDebugAnnotation(undefined, item)));
  } else {
    for (const [key, item] of Object.entries(value))
      parts.push(encodeBytesField(11, buildDebugAnnotation(key, item)));
  }
  return concat(...parts);
}
function buildTrackEvent(args) {
  if (args.trackUuid === 0n)
    throw new Error("pi-tracing encoder: track_uuid 0 is the implicit global track; pass an explicit track");
  if (args.type === TRACK_EVENT_COUNTER && args.counterValue === undefined) {
    throw new Error("pi-tracing encoder: TYPE_COUNTER requires counterValue");
  }
  const parts = [
    encodeUint32Field(9, args.type),
    encodeUint64Field(11, args.trackUuid)
  ];
  for (const category of args.categories) {
    parts.push(encodeStringField(22, category));
  }
  if (args.name !== undefined)
    parts.push(encodeStringField(23, args.name));
  if (args.counterValue !== undefined) {
    parts.push([...encodeTag(30, WIRE_VARINT), ...encodeVarint(args.counterValue)]);
  }
  if (args.flowIds !== undefined) {
    for (const flowId of args.flowIds) {
      if (flowId === 0n)
        throw new Error("pi-tracing encoder: flow id 0 is reserved");
      parts.push(encodeFixed64Field(47, flowId));
    }
  }
  if (args.debugAnnotations !== undefined) {
    for (const [name, value] of Object.entries(args.debugAnnotations)) {
      parts.push(encodeBytesField(4, buildDebugAnnotation(name, value)));
    }
  }
  return toU8(concat(...parts));
}
function buildProcessDescriptor(info) {
  const parts = [encodeUint32Field(1, info.pid)];
  parts.push(encodeStringField(6, info.processName));
  for (const label of info.labels)
    parts.push(encodeStringField(8, label));
  return concat(...parts);
}
function buildCounterDescriptor(info) {
  if (!info.unitName)
    throw new Error("pi-tracing encoder: counter unit_name is required");
  const parts = [encodeUint32Field(3, info.unit), encodeStringField(6, info.unitName)];
  if (info.yAxisShareKey !== undefined)
    parts.push(encodeStringField(7, info.yAxisShareKey));
  return concat(...parts);
}
function buildTrackDescriptor(args) {
  if (args.uuid === 0n)
    throw new Error("pi-tracing encoder: TrackDescriptor uuid 0 is reserved for the implicit track");
  const parts = [encodeUint64Field(1, args.uuid)];
  if (args.name !== undefined)
    parts.push(encodeStringField(2, args.name));
  if (args.process !== undefined)
    parts.push(encodeBytesField(3, buildProcessDescriptor(args.process)));
  if (args.thread !== undefined)
    parts.push(encodeBytesField(4, concat(encodeUint32Field(1, args.thread.pid), encodeUint64Field(2, args.thread.tid), ...args.thread.threadName === undefined ? [] : [encodeStringField(5, args.thread.threadName)])));
  if (args.parentUuid !== undefined)
    parts.push(encodeUint64Field(5, args.parentUuid));
  if (args.counter !== undefined)
    parts.push(encodeBytesField(8, buildCounterDescriptor(args.counter)));
  if (args.description !== undefined)
    parts.push(encodeStringField(14, args.description));
  if (args.siblingMergeBehavior !== undefined)
    parts.push(encodeUint32Field(15, args.siblingMergeBehavior));
  return toU8(concat(...parts));
}
function buildClockSnapshot(clocks, primaryTraceClock) {
  const parts = [];
  for (const clock of clocks) {
    const clockBytes = concat(encodeUint32Field(1, clock.clockId), encodeUint64Field(2, clock.timestampNs));
    parts.push(encodeBytesField(1, clockBytes));
  }
  parts.push(encodeUint32Field(2, primaryTraceClock));
  return toU8(concat(...parts));
}
function buildTracePacket(args) {
  if (args.seqId === 0)
    throw new Error("pi-tracing encoder: trusted_packet_sequence_id must be nonzero");
  const set = [args.trackEvent, args.trackDescriptor, args.clockSnapshot].filter((part) => part !== undefined);
  if (set.length !== 1)
    throw new Error("pi-tracing encoder: TracePacket needs exactly one data field");
  if (args.timestampNs === undefined !== (args.clockId === undefined)) {
    throw new Error("pi-tracing encoder: timestamp and clock id must be provided together");
  }
  if (args.trackEvent !== undefined && args.timestampNs === undefined) {
    throw new Error("pi-tracing encoder: TrackEvent packets require a timestamp and clock id");
  }
  const parts = [encodeUint32Field(10, args.seqId)];
  if (args.machineId !== undefined && args.machineId !== 0) {
    parts.push(encodeUint32Field(98, args.machineId));
  }
  if (args.timestampNs !== undefined && args.clockId !== undefined) {
    parts.unshift(encodeUint32Field(58, args.clockId));
    parts.unshift(encodeUint64Field(8, args.timestampNs));
  }
  if (args.trackEvent !== undefined)
    parts.push(encodeBytesField(11, args.trackEvent));
  if (args.trackDescriptor !== undefined)
    parts.push(encodeBytesField(60, args.trackDescriptor));
  if (args.clockSnapshot !== undefined)
    parts.push(encodeBytesField(6, args.clockSnapshot));
  return toU8(concat(...parts));
}
function framePacket(packet) {
  return toU8(encodeBytesField(1, packet));
}

// packages/agent-tracing/content.ts
function captureContentsEnabled(value, fallback = true) {
  if (value === false || typeof value === "string" && ["0", "false"].includes(value.toLowerCase()))
    return false;
  if (value === true || typeof value === "string" && ["1", "true"].includes(value.toLowerCase()))
    return true;
  return fallback;
}
var metadataAttribute = /^(?:event\.(?:name|timestamp|kind|sequence)|agentprof\.control_script|(?:conversation|thread|turn|session)\.id|(?:gen_ai\.system|model|provider_name|reasoning_effort|app\.version|tool_name|call_id|cell\.id|outcome|success|reason|status_code|tool_use_id)|[\w.]+(?:_tokens?|_count|_bytes|_length|_ms|_ns|_id|_code))$/i;
function omitContent(value) {
  if (Array.isArray(value))
    return value.map(omitContent);
  if (value === null || typeof value !== "object")
    return value;
  const source = value;
  if (typeof source.key === "string" && (!metadataAttribute.test(source.key) || /(?:prompt|argument|output|input|content|body|text|tool_response|tool_result)/i.test(source.key) && !/(?:length|bytes|tokens|count|duration|status|exit_code)$/i.test(source.key)))
    return;
  return Object.fromEntries(Object.entries(source).flatMap(([key, entry]) => {
    if (/(?:^|[._-])(?:prompt|arguments?|output|input|content|body|text|tool_response|tool_result|error|message|description|stack|script)(?:$|[._-])/i.test(key) && !/(?:length|bytes|tokens|count|duration|status|exit_code)$/i.test(key))
      return [];
    const safe = omitContent(entry);
    return safe === undefined ? [] : [[key, safe]];
  }));
}

// packages/pi-tracing/extensions/pi-tracing/annotations.ts
function scriptAnnotations(language, code) {
  if (typeof code !== "string")
    return { language };
  if (!code.length)
    return { language, line_count: 0 };
  let lines = 1;
  for (let i = 0;i < code.length; i++) {
    const char = code.charCodeAt(i);
    if (char === 13) {
      lines++;
      if (code.charCodeAt(i + 1) === 10)
        i++;
    } else if (char === 10)
      lines++;
  }
  if (/[\r\n]$/.test(code))
    lines--;
  return { language, line_count: lines };
}
function toolArgumentAnnotations(input, mode) {
  if (mode === false || mode === "disabled")
    return {};
  const attrs = {};
  let json;
  try {
    json = JSON.stringify(input);
  } catch {}
  if (json === undefined) {
    attrs["serializable"] = false;
    return attrs;
  }
  attrs["bytes"] = new TextEncoder().encode(json).length;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const keys = Object.keys(input);
    attrs["keys"] = keys.slice(0, 12).map((key) => key.slice(0, 200));
    if (keys.length > 12 || keys.some((key) => key.length > 200))
      attrs["keys_truncated"] = true;
  }
  if (mode === "metadata")
    return attrs;
  let remainingNodes = 128;
  let remainingText = 65536;
  let truncated = false;
  const copy = (value, depth) => {
    if (--remainingNodes < 0 || depth > 8) {
      truncated = true;
      return;
    }
    if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))
      return value;
    if (typeof value === "string") {
      let size = Math.min(value.length, remainingText);
      if (size < value.length && size > 0 && /[\uD800-\uDBFF]/.test(value[size - 1]))
        size--;
      remainingText -= size;
      if (size < value.length)
        truncated = true;
      return value.slice(0, size);
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) {
        const child = copy(item, depth + 1);
        if (child === undefined)
          break;
        result.push(child);
      }
      return result;
    }
    if (value !== null && typeof value === "object") {
      const result = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (remainingNodes <= 0 || remainingText < key.length) {
          truncated = true;
          break;
        }
        remainingText -= key.length;
        const child = copy(item, depth + 1);
        if (child !== undefined)
          result[key] = child;
      }
      return result;
    }
    truncated = true;
    return;
  };
  const value = copy(JSON.parse(json), 0);
  if (value !== undefined)
    attrs["args"] = value;
  if (truncated)
    attrs["truncated"] = true;
  return attrs;
}
function promptAnnotations(prompt, captureText) {
  if (typeof prompt !== "string")
    return {};
  const attrs = { length: prompt.length };
  if (captureText) {
    let limit = 65536;
    if (prompt.length > limit && /[\uD800-\uDBFF]/.test(prompt[limit - 1]))
      limit--;
    attrs["text"] = prompt.slice(0, limit);
    if (prompt.length > limit)
      attrs["truncated"] = true;
  }
  return attrs;
}

// packages/pi-tracing/extensions/pi-tracing/machine.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
var FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
var FNV1A_64_PRIME = 0x100000001b3n;
var UINT64_MASK = 0xffffffffffffffffn;
var UINT32_MASK = 0xffffffffn;
var utf8 = new TextEncoder;
var defaultDependencies = {
  readTextFile(path) {
    return readFileSync2(path, "utf8");
  },
  readSysctl(name) {
    return execFileSync("/usr/sbin/sysctl", ["-n", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    });
  }
};
function fnv1a64(value) {
  let digest = FNV1A_64_OFFSET_BASIS;
  for (const byte of utf8.encode(value)) {
    digest ^= BigInt(byte);
    digest = digest * FNV1A_64_PRIME & UINT64_MASK;
  }
  return digest;
}
function machineIdFromDigest(digest) {
  const id = Number(digest & UINT32_MASK);
  return id === 0 ? 1 : id;
}
function machineIdFromBootId(rawBootId) {
  const bootId = rawBootId.trim();
  return bootId === "" ? 0 : machineIdFromDigest(fnv1a64(bootId));
}
function resolveMachineIdentity(platform = process.platform, dependencies = defaultDependencies) {
  try {
    if (platform === "linux") {
      const id = machineIdFromBootId(dependencies.readTextFile("/proc/sys/kernel/random/boot_id"));
      return id === 0 ? { id: 0, source: "unavailable" } : { id, source: "linux-boot-id" };
    }
    if (platform === "darwin") {
      const id = machineIdFromBootId(dependencies.readSysctl("kern.bootsessionuuid"));
      return id === 0 ? { id: 0, source: "unavailable" } : { id, source: "darwin-boot-session" };
    }
  } catch {}
  return { id: 0, source: "unavailable" };
}
var cachedMachineIdentity;
function currentMachineIdentity() {
  cachedMachineIdentity ??= resolveMachineIdentity();
  return cachedMachineIdentity;
}

// packages/pi-tracing/extensions/pi-tracing/context.ts
var CONTEXT_CATEGORIES = {
  system: "System instructions",
  rules: "Rules and memory",
  skills: "Skills",
  tools: "Tool definitions",
  environment: "Environment",
  prompts: "User prompts",
  assistant: "Assistant history",
  results: "Tool results",
  summaries: "Compaction summaries",
  overhead: "Harness overhead",
  messages: "Conversation",
  unattributed: "Unattributed"
};
var estimateContextTokens = (chars) => Math.ceil(chars / 4);
var obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
var str = (v) => typeof v === "string" ? v : "";
var count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
function instructionCategory(name) {
  if (/rule|memory|claude.?md|agents.?md|instruction.?file/i.test(name))
    return "rules";
  if (/skill/i.test(name))
    return "skills";
  if (/environment|date|workspace|session.?info|project|email/i.test(name))
    return "environment";
  if (/reminder|wrapper/i.test(name))
    return "overhead";
  if (/tool|agent|command/i.test(name))
    return "tools";
  return "system";
}
function contentChars(value) {
  if (typeof value === "string")
    return value.length;
  if (!Array.isArray(value))
    return 0;
  return value.reduce((n, raw) => {
    const b = obj(raw);
    return n + str(b.text ?? b.thinking).length + (b.type === "toolCall" || b.type === "tool_use" ? str(b.name).length + JSON.stringify(b.arguments ?? b.input ?? {}).length : 0);
  }, 0);
}
function transcriptItems(messages) {
  if (!Array.isArray(messages))
    return [];
  const items = [];
  const sections = new Map, tools = new Map;
  messages.forEach((raw, index) => {
    const m = obj(raw), role = str(m.role), id = str(m.id ?? m.uuid) || `message:${role}:${m.timestamp ?? index}`;
    const category = role === "system" ? "system" : role === "assistant" ? "assistant" : role === "toolResult" || role === "tool" ? "results" : /compaction|summary/i.test(role) ? "summaries" : role === "user" ? "prompts" : "unattributed";
    const chars = contentChars(m.content ?? m.text ?? m.summary);
    if (chars)
      items.push({
        id,
        category,
        chars,
        tokens: estimateContextTokens(chars),
        source_id: str(m.toolCallId ?? m.tool_use_id),
        source_kind: category === "results" ? "tool" : category === "prompts" ? "prompt" : "response",
        label: category === "results" ? str(m.toolName ?? m.name) || "Tool result" : CONTEXT_CATEGORIES[category]
      });
    for (const [name, text] of Object.entries(obj(m.sections))) {
      if (text === null)
        sections.delete(name);
      else if (typeof text === "string")
        sections.set(name, {
          id: `section:${name}`,
          category: instructionCategory(name),
          chars: text.length,
          tokens: estimateContextTokens(text.length),
          label: name.slice(0, 96)
        });
    }
    for (const [i, tool] of (Array.isArray(m.toolsAdded) ? m.toolsAdded : []).entries()) {
      const chars = JSON.stringify(tool).length;
      const name = str(obj(tool).name) || String(i);
      tools.set(name, {
        id: `tool:${name}`,
        category: "tools",
        tokens: estimateContextTokens(chars),
        chars,
        label: name.slice(0, 96)
      });
    }
    for (const tool of Array.isArray(m.toolsRemoved) ? m.toolsRemoved : [])
      tools.delete(typeof tool === "string" ? tool : str(obj(tool).name));
  });
  return [...items, ...sections.values(), ...tools.values()];
}

class ContextTracker {
  previous;
  model;
  reset() {
    this.previous = undefined;
    this.model = undefined;
  }
  snapshot(items, options) {
    const baseline = this.previous === undefined || options.model !== this.model;
    const previous = baseline ? new Map : this.previous;
    const current = new Map(items.filter((i) => count(i.tokens) !== undefined).map((i) => {
      const item = Object.fromEntries(Object.entries(i).filter(([, value]) => value !== undefined));
      return [item.id, item];
    }));
    const categories = {};
    for (const item of current.values())
      categories[item.category] = (categories[item.category] ?? 0) + item.tokens;
    const changes = [];
    for (const item of current.values()) {
      const old = previous.get(item.id);
      if (!old || old.tokens !== item.tokens || old.category !== item.category)
        changes.push({
          ...item,
          change: !old ? baseline ? "baseline" : "added" : "replaced",
          delta_tokens: item.tokens - (old?.tokens ?? 0)
        });
    }
    for (const item of previous.values())
      if (!current.has(item.id))
        changes.push({ ...item, change: "removed", delta_tokens: -item.tokens });
    changes.sort((a, b) => Math.abs(b.delta_tokens) - Math.abs(a.delta_tokens));
    this.previous = current;
    this.model = options.model;
    const measured = options.categories ?? categories;
    return {
      version: 1,
      stage: options.stage,
      basis: options.basis ?? "chars/4",
      coverage: options.coverage ?? "partial",
      baseline,
      ...options.item_stage ? { item_stage: options.item_stage } : {},
      categories: measured,
      ...Object.keys(measured).length ? { estimated_tokens: Object.values(measured).reduce((a, b) => a + b, 0) } : {},
      ...count(options.reported_tokens) !== undefined ? { reported_tokens: options.reported_tokens } : {},
      ...count(options.window_tokens) !== undefined ? { window_tokens: options.window_tokens } : {},
      ...count(options.compact_threshold_tokens) !== undefined ? { compact_threshold_tokens: options.compact_threshold_tokens } : {},
      ...count(options.effective_window_tokens) !== undefined ? { effective_window_tokens: options.effective_window_tokens } : {},
      ...options.model ? { model: options.model } : {},
      changes: changes.slice(0, 64),
      omitted_changes: Math.max(0, changes.length - 64)
    };
  }
}

// packages/pi-tracing/extensions/pi-tracing/tracks.ts
var DEFAULT_COUNTERS = [
  ...Object.entries(CONTEXT_CATEGORIES).map(([key, name]) => ({
    key: `context.${key}`,
    trackName: name,
    unit: COUNTER_UNIT_UNSPECIFIED,
    unitName: "tokens",
    yAxisShareKey: "llm.context.tokens",
    category: "llm",
    group: "Context"
  })),
  { key: "llm.tokens.input", trackName: "Input tokens", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", category: "llm" },
  { key: "llm.tokens.output", trackName: "Output tokens", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", category: "llm" },
  { key: "llm.context.estimated_tokens", trackName: "Context size", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", yAxisShareKey: "llm.context.tokens", category: "llm" },
  { key: "llm.context.window_tokens", trackName: "Context window", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", yAxisShareKey: "llm.context.tokens", category: "llm" },
  { key: "runtime.rss", trackName: "Resident memory", group: "Runtime", unit: COUNTER_UNIT_BYTES, unitName: "bytes" },
  { key: "runtime.heap", trackName: "JS heap", group: "Runtime", unit: COUNTER_UNIT_BYTES, unitName: "bytes" },
  { key: "runtime.cpu", trackName: "CPU time (interval)", description: "Process CPU time consumed since the previous sample, in microseconds; not utilization.", group: "Runtime", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "us" },
  { key: "tracing.droppedEvents", trackName: "Dropped events", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
  { key: "tracing.queueDepth", trackName: "Queue depth", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
  { key: "tracing.laneOverflows", trackName: "Lane overflows", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" }
];

// packages/pi-tracing/extensions/pi-tracing/tracer.ts
var FLUSH_BATCH_BYTES = 64 * 1024;
var FINALIZE_RESERVE_BYTES = 64 * 1024;
var MAX_TIMESTAMP_NS = (1n << 64n) - 1n;
var OWNER_GRACE_MS = 5 * 60 * 1000;
var utf82 = new TextEncoder;
var runtimeIdentity = randomToken();
function nowSourceNs() {
  return process.hrtime.bigint();
}
function realtimeNowNs() {
  return BigInt(Date.now()) * 1000000n;
}
function boottimeNsForPlatform(platform, realtimeNs, uptimeSeconds) {
  if (platform !== "linux")
    return realtimeNs;
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new Error("system uptime clock unavailable");
  }
  return BigInt(Math.round(uptimeSeconds * 1e9));
}
function linuxUptimeReading(readText = () => readFileSync3("/proc/uptime", "utf8"), fallback = uptime) {
  try {
    const seconds = Number(readText().trim().split(/\s+/)[0]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { seconds, resolutionNs: 10000000n };
    }
  } catch {}
  return { seconds: fallback(), resolutionNs: 1000000000n };
}
function captureClockReadings() {
  const sourceBefore = nowSourceNs();
  const realtimeBefore = realtimeNowNs();
  const boot = process.platform === "linux" ? linuxUptimeReading() : { seconds: 0, resolutionNs: 0n };
  const realtimeAfter = realtimeNowNs();
  const sourceAfter = nowSourceNs();
  const realtimeNs = realtimeBefore + (realtimeAfter - realtimeBefore) / 2n;
  const samplingUncertainty = (sourceAfter - sourceBefore) / 2n;
  const realtimeDelta = realtimeAfter >= realtimeBefore ? realtimeAfter - realtimeBefore : realtimeBefore - realtimeAfter;
  const realtimeUncertainty = realtimeDelta / 2n;
  const quantizationUncertainty = boot.resolutionNs + 1000000n;
  const uncertaintyNs = quantizationUncertainty + samplingUncertainty + realtimeUncertainty;
  return {
    sourceNs: sourceBefore + (sourceAfter - sourceBefore) / 2n,
    boottimeNs: boottimeNsForPlatform(process.platform, realtimeNs, boot.seconds),
    realtimeNs,
    uncertaintyNs
  };
}
function randomToken() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// packages/agent-tracing/context.ts
function attachContext(slice, snapshot, counters, at = slice.start) {
  slice.attrs.context = { ...snapshot, sample_offset_ns: Number(at - slice.start) };
  for (const [key, value] of Object.entries(snapshot.categories)) {
    const name = CONTEXT_CATEGORIES[key] ?? key;
    let counter = counters.find((c) => c.session === slice.session && c.name === `Context: ${name}`);
    if (!counter) {
      counter = { session: slice.session, name: `Context: ${name}`, group: "Context", unit: "tokens", axis: "llm.context.tokens", samples: [] };
      counters.push(counter);
    }
    counter.samples.push({ at, value });
  }
  for (const c of counters.filter((c) => c.session === slice.session && c.group === "Context"))
    if (!Object.keys(snapshot.categories).some((key) => c.name === `Context: ${CONTEXT_CATEGORIES[key] ?? key}`))
      c.samples.push({ at, value: 0 });
}

// packages/agent-tracing/trace.ts
var compareTime = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function writeTrace(options) {
  if (!options.capture || !Number.isInteger(options.pid) || options.pid <= 0)
    throw new Error("Missing process/capture identity");
  if (!options.clocks.length)
    throw new Error("Missing boot/realtime clock snapshot");
  const uuid = (key) => fnv1a64(`${options.capture}:${key}`) || 1n;
  const seqId = Number(uuid("sequence") & 0xffffffffn) || 1;
  const packets = [];
  const packet = (data, at) => packets.push(framePacket(buildTracePacket({
    seqId,
    machineId: options.machineId,
    ...at === undefined ? {} : { timestampNs: at, clockId: CLOCK_REALTIME },
    ...data
  })));
  for (const clock of options.clocks)
    packet({ clockSnapshot: buildClockSnapshot([
      { clockId: CLOCK_REALTIME, timestampNs: clock.realtimeNs },
      { clockId: CLOCK_BOOTTIME, timestampNs: clock.boottimeNs }
    ], CLOCK_REALTIME) });
  const process2 = uuid("process");
  packet({ trackDescriptor: buildTrackDescriptor({ uuid: process2, process: {
    pid: options.pid,
    processName: options.processName,
    labels: [options.processLabel]
  } }) });
  const events = [];
  const event = (at, rank, trackUuid, type, name, attrs, flows, counterValue) => {
    events.push({ at, rank, data: buildTrackEvent({
      trackUuid,
      type,
      name,
      categories: type === TRACK_EVENT_END ? [] : [`${options.category}.${name?.startsWith("profile (") || name === "run-configuration" ? "metadata" : "activity"}`],
      debugAnnotations: attrs,
      flowIds: flows,
      counterValue
    }) });
  };
  for (const session of options.sessions) {
    const root = uuid(`capture:${session.id}`), profile = uuid(`profile:${session.id}`);
    packet({ trackDescriptor: buildTrackDescriptor({ uuid: root, parentUuid: process2, name: "agentprof.capture", siblingMergeBehavior: SIBLING_MERGE_NONE }) });
    packet({ trackDescriptor: buildTrackDescriptor({ uuid: profile, parentUuid: root, name: "Session" }) });
    event(session.start, -4, profile, TRACK_EVENT_BEGIN, "profile (1)", { ...session.attrs, kind: "capture", schema_version: 1, session_id: session.id, capture_id: root.toString(16) });
    event(session.end, 4, profile, TRACK_EVENT_END);
    const groups = new Map;
    for (const slice of options.slices.filter((s) => s.session === session.id)) {
      const group = groups.get(slice.track) ?? [];
      group.push(slice);
      groups.set(slice.track, group);
    }
    for (const [name, slices] of groups) {
      const lanes = [];
      for (const slice of slices.sort((a, b) => compareTime(a.start, b.start))) {
        let lane = lanes.find((l) => l.end <= slice.start);
        if (!lane) {
          lane = { uuid: uuid(`${session.id}:${name}:${lanes.length}`), end: slice.start };
          lanes.push(lane);
          packet({ trackDescriptor: buildTrackDescriptor({ uuid: lane.uuid, parentUuid: root, name, siblingMergeBehavior: SIBLING_MERGE_BY_TRACK_NAME }) });
        }
        lane.end = slice.end === slice.start ? slice.start + 1n : slice.end ?? slice.start;
        event(slice.start, slice.end === undefined ? -1 : 0, lane.uuid, slice.end === undefined ? TRACK_EVENT_INSTANT : TRACK_EVENT_BEGIN, slice.name, slice.attrs, [...new Set(slice.flows)]);
        if (slice.end !== undefined)
          event(slice.end, slice.end === slice.start ? 1 : -2, lane.uuid, TRACK_EVENT_END);
      }
    }
    const describedGroups = new Set;
    for (const counter of options.counters.filter((c) => c.session === session.id && c.samples.length)) {
      const id = uuid(`${session.id}:counter:${counter.name}`);
      const parent = counter.group ? uuid(`${session.id}:group:${counter.group}`) : root;
      if (counter.group && !describedGroups.has(counter.group)) {
        packet({ trackDescriptor: buildTrackDescriptor({ uuid: parent, parentUuid: root, name: counter.group }) });
        describedGroups.add(counter.group);
      }
      packet({ trackDescriptor: buildTrackDescriptor({
        uuid: id,
        parentUuid: parent,
        name: counter.name,
        counter: { unit: 0, unitName: counter.unit, ...counter.axis ? { yAxisShareKey: counter.axis } : {} }
      }) });
      if (!counter.group)
        event(session.start, -3, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
      for (const sample of counter.samples.sort((a, b) => compareTime(a.at, b.at)))
        event(sample.at, 2, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, BigInt(sample.value));
      event(session.end, 3, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
    }
  }
  events.sort((a, b) => compareTime(a.at, b.at) || a.rank - b.rank);
  for (const e of events)
    packet({ trackEvent: e.data }, e.at);
  return Buffer.concat(packets);
}

// packages/codex-tracing/otel.ts
import { createHash as createHash2 } from "node:crypto";
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
var array = (v) => Array.isArray(v) ? v : [];
var string = (v) => typeof v === "string" ? v : "";
function number(v) {
  const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
var integer = (v) => {
  const n = number(v);
  return Number.isSafeInteger(n) ? n : undefined;
};
function ns(v) {
  if (typeof v === "string" && /^\d+$/.test(v))
    return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v);
  return;
}
function isoTime(v) {
  if (typeof v !== "string")
    return;
  const value = Date.parse(v);
  return Number.isFinite(value) && value >= 0 ? BigInt(value) * 1000000n : undefined;
}
function attributes(raw) {
  const result = Object.create(null);
  for (const entry of array(raw)) {
    const a = object(entry), v = object(a.value), key = string(a.key);
    if (typeof v.stringValue === "string")
      result[key] = v.stringValue;
    else if (typeof v.boolValue === "boolean")
      result[key] = v.boolValue;
    else if (integer(v.intValue) !== undefined)
      result[key] = integer(v.intValue);
    else if (number(v.doubleValue) !== undefined)
      result[key] = number(v.doubleValue);
  }
  return result;
}
function readOtel(rows) {
  const spans = new Map, logs = new Map;
  for (const row of rows) {
    for (const resource of array(row.data.resourceSpans))
      for (const scope of array(object(resource).scopeSpans)) {
        for (const entry of array(object(scope).spans)) {
          const s = object(entry), start = ns(s.startTimeUnixNano), end = ns(s.endTimeUnixNano);
          if (start === undefined || end === undefined || end < start || !s.spanId || !s.traceId)
            continue;
          const trace = string(s.traceId), key = `${trace}:${s.spanId}`;
          spans.set(key, {
            key,
            trace,
            parent: `${trace}:${s.parentSpanId ?? ""}`,
            name: string(s.name),
            start,
            end,
            attrs: attributes(s.attributes),
            error: [2, "STATUS_CODE_ERROR"].includes(object(s.status).code)
          });
        }
      }
    for (const resource of array(row.data.resourceLogs))
      for (const scope of array(object(resource).scopeLogs)) {
        for (const entry of array(object(scope).logRecords)) {
          const l = object(entry), attrs = attributes(l.attributes);
          const at = ns(l.timeUnixNano) || isoTime(attrs["event.timestamp"]);
          if (at === undefined)
            continue;
          const key = createHash2("sha256").update(JSON.stringify([at.toString(), l.traceId, l.spanId, Object.entries(attrs).sort()])).digest("hex");
          logs.set(key, { key, trace: string(l.traceId), span: `${l.traceId}:${l.spanId}`, at, attrs });
        }
      }
  }
  return { spans, logs: [...logs.values()] };
}

// packages/codex-tracing/plugin-observations.ts
var isControl = (name) => /(?:^|__)tracing_(?:start|stop|status)$/.test(name);
var isControlScript = (source) => {
  const calls = [...source.matchAll(/\btools\.([\w]+)\s*\(/g)];
  return calls.length > 0 && calls.every((call) => isControl(call[1]));
};
function tagControlScripts(wire) {
  for (const resource of array(wire.resourceLogs))
    for (const scope of array(object(resource).scopeLogs))
      for (const raw of array(object(scope).logRecords)) {
        const log = object(raw), attrs = attributes(log.attributes);
        if (attrs["event.name"] !== "codex.tool_result" || typeof attrs.arguments !== "string" || attrs.arguments.length > 4096)
          continue;
        array(log.attributes).push({ key: "agentprof.control_script", value: { boolValue: isControlScript(attrs.arguments) } });
      }
}
function addHooks(rows, spans, logs, first, last, captureContents = true) {
  const extra = [], tools = new Map, compactions = new Map;
  const hooks = rows.filter((row) => row.source === "codex.hook");
  for (const control of rows.filter((row) => row.source === "codex.control")) {
    for (const [key, span] of spans) {
      if (span.name === "session_task.turn" && control.data.turn_id && span.attrs["turn.id"] === control.data.turn_id && (span.attrs["conversation.id"] ?? span.attrs["thread.id"]) === control.data.session_id)
        spans.delete(key);
    }
    const at = BigInt(control.timestamp);
    const candidates = logs.filter((log) => log.attrs["event.name"] === "codex.user_prompt" && log.attrs["conversation.id"] === control.data.session_id && integer(log.attrs.prompt_length) === control.data.prompt_length && log.at <= at && at - log.at < 2000000000n);
    const prompt = candidates.reduce((nearest, log) => !nearest || log.at > nearest.at ? log : nearest, undefined);
    if (prompt)
      logs.splice(logs.indexOf(prompt), 1);
  }
  const prompts = hooks.filter((row) => row.data.hook_event_name === "UserPromptSubmit");
  for (let i = logs.length - 1;i >= 0; i--) {
    const log = logs[i];
    if (log.attrs["event.name"] === "codex.user_prompt" && prompts.some((row) => row.data.session_id === log.attrs["conversation.id"] && (BigInt(row.timestamp) - log.at < 1000000000n && log.at - BigInt(row.timestamp) < 1000000000n)))
      logs.splice(i, 1);
  }
  for (const span of spans.values()) {
    if (span.start < first || span.end > last)
      span.attrs["capture.incomplete"] = true;
    if (span.end > last)
      span.attrs["capture.end_incomplete"] = true;
    span.start = span.start < first ? first : span.start;
    span.end = span.end > last ? last : span.end;
    if (span.end < span.start)
      spans.delete(span.key);
  }
  const turns = new Map;
  for (const row of hooks) {
    const data = row.data, id = string(data.session_id), event = string(data.hook_event_name);
    const at = BigInt(row.timestamp), turn = string(data.turn_id), key = `hook:${id}:${turn}`;
    const attrs = { "conversation.id": id };
    const log = (name, fields) => logs.push({
      key: `${key}:${logs.length}`,
      trace: key,
      span: "",
      at,
      attrs: { ...attrs, "event.name": name, ...fields }
    });
    if (event === "SessionStart")
      log("codex.conversation_starts", { model: string(data.model) });
    if (event === "SubagentStart")
      logs.push({
        key: `${key}:child`,
        trace: key,
        span: "",
        at,
        attrs: { "conversation.id": string(data.agent_id), "event.name": "codex.conversation_starts", model: string(data.model) }
      });
    if (event === "UserPromptSubmit") {
      log("codex.user_prompt", {
        prompt_length: integer(data.prompt_length) ?? string(data.prompt).length,
        ...captureContents ? { prompt: string(data.prompt) } : {}
      });
      const native = [...spans.values()].find((span) => span.name === "session_task.turn" && (span.attrs["conversation.id"] ?? span.attrs["thread.id"]) === id && span.attrs["turn.id"] === turn);
      if (native) {
        native.start = at;
        native.attrs["capture.started_before"] = data.started_before_capture === true;
        native.attrs["capture.incomplete"] = data.started_before_capture === true || native.attrs["capture.end_incomplete"] === true;
        turns.set(key, native);
      } else {
        const span = {
          key,
          trace: key,
          parent: "",
          name: "session_task.turn",
          start: at,
          end: last,
          error: false,
          attrs: { ...attrs, "turn.id": turn, "capture.incomplete": true, "capture.started_before": data.started_before_capture === true }
        };
        spans.set(key, span);
        turns.set(key, span);
      }
    }
    if (event === "Stop" || event === "Interrupt") {
      const span = turns.get(key);
      if (span) {
        span.end = at;
        span.attrs["capture.incomplete"] = event === "Interrupt" || span.attrs["capture.started_before"] === true;
      }
    }
    const call = string(data.tool_use_id), tool = string(data.tool_name);
    if (event === "PreToolUse" && !isControl(tool)) {
      const native = logs.some((log) => log.attrs["event.name"] === "codex.tool_result" && log.attrs["conversation.id"] === id && log.attrs.call_id === call);
      if (!native) {
        const annotation = data.tool_input === undefined ? {} : toolArgumentAnnotations(data.tool_input, captureContents);
        if (annotation.truncated !== undefined) {
          annotation.args_truncated = annotation.truncated;
          delete annotation.truncated;
        }
        const slice = {
          id: `hook-tool:${id}:${call}`,
          session: id,
          track: "Tool dispatch",
          name: tool === "Bash" ? "bash" : tool,
          start: at,
          end: last,
          flows: [],
          attrs: { kind: "tool-execution", call_id: call, timing: "hook-dispatch", incomplete: true, ...annotation }
        };
        tools.set(`${id}:${call}`, slice);
        extra.push(slice);
      }
    }
    if (event === "PostToolUse") {
      const slice = tools.get(`${id}:${call}`);
      if (slice) {
        slice.end = at;
        slice.attrs.incomplete = false;
        const result = object(data.tool_response);
        const exit = typeof result.exit_code === "number" ? result.exit_code : integer(data.exit_code);
        if (exit !== undefined) {
          slice.attrs.exit_code = exit;
          slice.attrs.is_error = exit !== 0;
        } else if (typeof result.isError === "boolean" || typeof data.is_error === "boolean")
          slice.attrs.is_error = typeof result.isError === "boolean" ? result.isError : data.is_error;
      }
    }
    if (event === "PreCompact") {
      const slice = {
        id: `compact:${id}:${at}`,
        session: id,
        track: "Compaction",
        name: "compaction",
        start: at,
        end: last,
        flows: [],
        attrs: { kind: "compaction", trigger: string(data.trigger), incomplete: true }
      };
      extra.push(slice);
      compactions.set(id, slice);
    }
    if (event === "PostCompact") {
      const slice = compactions.get(id);
      if (slice) {
        slice.end = at;
        slice.attrs.incomplete = false;
        compactions.delete(id);
      }
    }
  }
  return extra;
}

// packages/codex-tracing/convert.ts
var uuidPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
var ms = (value) => BigInt(Math.round(value * 1e6));
var min = (a, b) => a < b ? a : b;
var max = (a, b) => a > b ? a : b;
function convertObservations(rows) {
  const processStart = rows.find((r) => r.source === "process_start");
  const pid = integer(processStart?.data.pid), capture = string(processStart?.data.captureId);
  if (!pid || !capture || !processStart)
    throw new Error("Missing recorded Codex process identity");
  const captureContents = processStart.data.capture_contents !== false;
  const first = BigInt(processStart.timestamp), processEnd = rows.findLast((r) => r.source === "process_end");
  const last = BigInt(processEnd?.timestamp ?? rows.at(-1)?.timestamp ?? processStart.timestamp);
  const { spans, logs } = readOtel(rows);
  const plugin = processStart.data.recorder === "codex-plugin-1";
  const nativeTelemetry = rows.some((row) => row.source === "/v1/logs" || row.source === "/v1/traces");
  const extra = plugin ? addHooks(rows, spans, logs, first, last, captureContents) : [];
  const ordered = [...spans.values()].sort((a, b) => compareTime(a.start, b.start));
  logs.sort((a, b) => compareTime(a.at, b.at));
  const cli = rows.filter((r) => r.source === "cli").map((r) => r.data);
  const rootSession = string(processStart.data.sessionId) || string(cli.find((r) => r.type === "thread.started")?.thread_id) || string(logs.find((l) => l.attrs["event.name"] === "codex.user_prompt")?.attrs["conversation.id"]);
  if (!rootSession)
    throw new Error("No Codex session identity was captured.");
  const traceSessions = new Map;
  const remember = (trace, id) => {
    if (!trace || !uuidPattern.test(id))
      return;
    const ids = traceSessions.get(trace) ?? new Set;
    ids.add(id);
    traceSessions.set(trace, ids);
  };
  for (const log of logs)
    remember(log.trace, string(log.attrs["conversation.id"]));
  for (const span of ordered)
    remember(span.trace, string(span.attrs["conversation.id"]) || string(span.attrs["thread.id"]));
  const ancestors = (s) => {
    const result = [], seen = new Set;
    let current = s;
    while (current && !seen.has(current.key)) {
      seen.add(current.key);
      result.push(current);
      current = spans.get(current.parent);
    }
    return result;
  };
  const spanSession = (s) => {
    for (const a of ancestors(s)) {
      const id = string(a.attrs["conversation.id"]) || string(a.attrs["thread.id"]);
      if (uuidPattern.test(id))
        return id;
    }
    const ids = traceSessions.get(s.trace);
    return ids?.size === 1 ? [...ids][0] : "";
  };
  const sessions = new Map;
  const getSession = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        start: id === rootSession ? first : last,
        end: id === rootSession ? last : first,
        attrs: {
          harness: "codex",
          recorder_version: plugin ? "codex-plugin-1" : "codex-prototype-1",
          timing: plugin && !nativeTelemetry ? "hooks-and-transcript" : "native-otel",
          ...!processEnd || processEnd.data.dropped !== 0 || processEnd.data.incomplete || rows.some((r) => r.source === "recovery") ? { incomplete: true } : {}
        }
      };
      sessions.set(id, s);
    }
    return s;
  };
  getSession(rootSession);
  for (const row of rows.filter((r) => r.source === "codex.hook")) {
    const id = string(row.data.session_id);
    const s = getSession(id);
    if (row.data.parent_session)
      s.attrs.parent_session = string(row.data.parent_session);
    if (row.data.hook_event_name === "SubagentStart") {
      const child = getSession(string(row.data.agent_id));
      child.attrs.parent_session = id;
      child.attrs.child_role = string(row.data.agent_type) || "subagent";
    }
  }
  for (const log of logs) {
    const id = string(log.attrs["conversation.id"]);
    if (!uuidPattern.test(id))
      continue;
    const s = getSession(id);
    s.start = min(s.start, log.at);
    s.end = max(s.end, log.at);
    if (log.attrs["event.name"] === "codex.conversation_starts") {
      for (const [key, field] of [["model", "model"], ["provider_name", "provider"], ["reasoning_effort", "effort"], ["app.version", "harness_version"]]) {
        if (log.attrs[key])
          s.attrs[field] = field === "provider" ? string(log.attrs[key]).toLowerCase() : log.attrs[key];
      }
    }
  }
  for (const span of ordered) {
    const id = spanSession(span);
    if (!id)
      continue;
    const s = getSession(id);
    s.start = min(s.start, span.start);
    s.end = max(s.end, span.end);
  }
  const metadata = rows.filter((r) => r.source === "session_metadata").map((r) => ({ session: string(r.data.session_id), record: object(r.data.record) }));
  const tokenMetadata = new Map;
  const configurations = new Map;
  for (const { session, record } of metadata) {
    if (!sessions.has(session))
      continue;
    const p = object(record.payload), s = getSession(session);
    if (record.type === "session_meta") {
      const spawn = object(object(object(p.source).subagent).thread_spawn);
      if (uuidPattern.test(string(spawn.parent_thread_id))) {
        s.attrs.parent_session = string(spawn.parent_thread_id);
        s.attrs.child_role = string(spawn.agent_role) || "subagent";
      }
      if (p.model_provider && !s.attrs.provider)
        s.attrs.provider = string(p.model_provider);
      if (p.cli_version)
        s.attrs.harness_version = string(p.cli_version);
    }
    if (record.type === "turn_context" && plugin) {
      const at = isoTime(record.timestamp);
      if (at !== undefined && at <= last) {
        const values = configurations.get(session) ?? [];
        values.push({ at, model: string(p.model), effort: string(p.effort) });
        configurations.set(session, values);
      }
    }
    if (record.type === "event_msg" && p.type === "token_count") {
      const info = object(p.info), at = isoTime(record.timestamp);
      if (at === undefined || at < first || at > last)
        continue;
      const values = tokenMetadata.get(session) ?? [];
      values.push({ at, usage: object(info.last_token_usage), limit: integer(info.model_context_window) });
      tokenMetadata.set(session, values);
    }
  }
  for (const [id, values] of configurations) {
    values.sort((a, b) => compareTime(a.at, b.at));
    const initial = values.findLast((value) => value.at <= first) ?? values[0];
    const session = getSession(id);
    if (initial.model)
      session.attrs.model = initial.model;
    if (initial.effort)
      session.attrs.effort = initial.effort;
  }
  const slices = [...extra], counters = [];
  const add = (session, id, track, name, start, end, attrs) => {
    const slice = { session, id, track, name, start, end, attrs, flows: [] };
    slices.push(slice);
    return slice;
  };
  const edge = (from, to) => {
    if (!from || !to || to.start < from.start)
      return;
    const flow = fnv1a64(`${capture}:flow:${from.id}:${to.id}`) || 1n;
    from.flows.push(flow);
    to.flows.push(flow);
  };
  const prompts = [];
  const inputs = new Map;
  const usedPrompts = new Set;
  for (const turn of ordered.filter((s) => s.name === "session_task.turn")) {
    const id = spanSession(turn);
    if (!id)
      continue;
    const log = logs.find((l) => !usedPrompts.has(l) && l.attrs["event.name"] === "codex.user_prompt" && l.attrs["conversation.id"] === id && l.at >= turn.start - ms(1000) && l.at <= turn.end);
    if (log)
      usedPrompts.add(log);
    const start = log?.at ?? turn.start;
    const input = add(id, `${turn.key}:input`, "Inputs", "prompt-input", start, undefined, { source: id === rootSession ? "user" : "agent" });
    const prompt = add(id, turn.key, "Session", "prompt", start, turn.end, {
      kind: "prompt",
      turn_id: string(turn.attrs["turn.id"]),
      ...turn.attrs["capture.incomplete"] ? { incomplete: true } : {},
      ...promptAnnotations(log?.attrs.prompt === "[REDACTED]" ? undefined : log?.attrs.prompt, captureContents),
      ...integer(log?.attrs.prompt_length) !== undefined ? { length: integer(log?.attrs.prompt_length) } : {}
    });
    edge(input, prompt);
    prompts.push(prompt);
    if (!inputs.has(id))
      inputs.set(id, input);
  }
  for (const log of logs.filter((l) => l.attrs["event.name"] === "codex.user_prompt" && !usedPrompts.has(l))) {
    const id = string(log.attrs["conversation.id"]);
    if (!sessions.has(id))
      continue;
    const input = add(id, `${log.key}:input`, "Inputs", "prompt-input", log.at, undefined, { source: "user" });
    const prompt = add(id, log.key, "Session", "prompt", log.at, getSession(id).end, {
      kind: "prompt",
      incomplete: true,
      ...promptAnnotations(log.attrs.prompt, captureContents),
      ...integer(log.attrs.prompt_length) !== undefined ? { length: integer(log.attrs.prompt_length) } : {}
    });
    edge(input, prompt);
    prompts.push(prompt);
    inputs.set(id, input);
  }
  const ownerPrompt = (slice) => prompts.find((p) => p.session === slice.session && p.start <= slice.start && p.end >= slice.start);
  const requests = ordered.filter((s) => ["responses_websocket.stream_request", "responses.stream_request"].includes(s.name));
  const prewarm = (s) => ancestors(s).some((a) => a.name === "startup_prewarm" || a.attrs["websocket.warmup"] === true) || ordered.some((a) => a.trace === s.trace && a.name === "startup_prewarm" && a.start <= s.start && a.end >= s.end);
  const usedRequests = new Set;
  const responses = [];
  const compactionResponses = [];
  let unmeasuredResponses = 0, prewarms = 0;
  for (const log of logs.filter((l) => l.attrs["event.kind"] === "response.completed")) {
    const id = string(log.attrs["conversation.id"]);
    if (!sessions.has(id))
      continue;
    const matches = requests.filter((s) => !usedRequests.has(s) && spanSession(s) === id && s.start <= log.at + ms(1) && s.end >= log.at - ms(1) && s.end <= log.at + ms(5));
    const request = matches.length === 1 ? matches[0] : undefined;
    if (request)
      usedRequests.add(request);
    const start = request?.start ?? log.at, end = request?.end ?? log.at;
    const warm = request !== undefined && prewarm(request);
    const compaction = extra.some((slice) => slice.session === id && slice.attrs.kind === "compaction" && slice.start <= start && slice.end >= end);
    const configuration = configurations.get(id)?.findLast((value) => value.at <= start);
    const attrs = {
      kind: warm ? "startup" : compaction ? "compaction-response" : "assistant-message",
      model: string(log.attrs.model) || configuration?.model || string(getSession(id).attrs.model),
      ...getSession(id).attrs.provider ? { provider: getSession(id).attrs.provider } : {},
      timing: request ? "native-stream" : "unmeasured",
      ...request ? { is_error: request.error, ...request.attrs["capture.incomplete"] ? { incomplete: true } : {} } : { incomplete: true }
    };
    for (const [source, target] of [
      ["input_token_count", "input_tokens"],
      ["output_token_count", "output_tokens"],
      ["cached_token_count", "cache_read_tokens"],
      ["cache_write_token_count", "cache_write_tokens"],
      ["reasoning_token_count", "reasoning_tokens"]
    ]) {
      const value = integer(log.attrs[source]);
      if (value !== undefined)
        attrs[target] = value;
    }
    const effort = log.attrs.model_reasoning_effort ?? (configuration ? configuration.effort : getSession(id).attrs.effort);
    if (effort !== undefined && effort !== "")
      attrs.effort = effort;
    const ttft = number(log.attrs.ttft_ms);
    if (ttft !== undefined)
      attrs.ttft_ns = Math.round(ttft * 1e6);
    const slice = add(id, log.key, warm ? "Tracing" : compaction ? "Compaction responses" : "Responses", warm ? "prewarm" : "response", start, end, attrs);
    if (warm) {
      prewarms++;
      continue;
    }
    if (!request)
      unmeasuredResponses++;
    const samples = tokenMetadata.get(id) ?? [];
    const sample = samples.find((v) => v.at >= end - ms(5) && v.at <= end + ms(1000) && v.usage.input_tokens === attrs.input_tokens && v.usage.output_tokens === attrs.output_tokens);
    const limit = sample?.limit;
    if (limit)
      attrs.context_window_tokens = limit;
    if (attrs.input_tokens !== undefined)
      attrs.context_tokens = attrs.input_tokens;
    if (compaction) {
      compactionResponses.push(slice);
      continue;
    }
    responses.push(slice);
    add(id, `${log.key}:turn`, "Turns", "turn", start, end, { kind: "turn", ...request ? {} : { incomplete: true } });
    edge(ownerPrompt(slice), slice);
  }
  if (plugin && !nativeTelemetry)
    for (const [id, samples] of tokenMetadata)
      for (const sample of samples) {
        if (!sessions.has(id) || integer(sample.usage.input_tokens) === undefined && integer(sample.usage.output_tokens) === undefined)
          continue;
        const configuration = configurations.get(id)?.findLast((value) => value.at <= sample.at);
        const session = getSession(id);
        const compact = extra.some((slice) => slice.session === id && slice.attrs.kind === "compaction" && slice.start <= sample.at && slice.end !== undefined && slice.end >= sample.at);
        const attrs = {
          kind: compact ? "compaction-response" : "assistant-message",
          timing: "transcript-completion",
          incomplete: true,
          model: configuration?.model || string(session.attrs.model),
          ...session.attrs.provider ? { provider: session.attrs.provider } : {},
          ...configuration?.effort || session.attrs.effort ? { effort: configuration?.effort || session.attrs.effort } : {}
        };
        for (const [source, target] of [
          ["input_tokens", "input_tokens"],
          ["output_tokens", "output_tokens"],
          ["cached_input_tokens", "cache_read_tokens"],
          ["reasoning_output_tokens", "reasoning_tokens"]
        ]) {
          const value = integer(sample.usage[source]);
          if (value !== undefined)
            attrs[target] = value;
        }
        if (sample.limit)
          attrs.context_window_tokens = sample.limit;
        if (attrs.input_tokens !== undefined)
          attrs.context_tokens = attrs.input_tokens;
        const response = add(id, `transcript:${sample.at}:${responses.length + compactionResponses.length}`, compact ? "Compaction responses" : "Responses", "response", sample.at, sample.at, attrs);
        unmeasuredResponses++;
        if (compact)
          compactionResponses.push(response);
        else {
          responses.push(response);
          add(id, `${response.id}:turn`, "Turns", "turn", sample.at, sample.at, { kind: "turn", incomplete: true });
          edge(ownerPrompt(response), response);
        }
      }
  for (const request of requests.filter((s) => !usedRequests.has(s))) {
    const id = spanSession(request);
    if (!id)
      continue;
    const warm = prewarm(request);
    add(id, request.key, warm ? "Tracing" : "Requests", warm ? "prewarm" : "request", request.start, request.end, {
      kind: warm ? "startup" : "provider-request",
      timing: "native-stream",
      ...request.error ? { is_error: true } : {},
      ...!warm ? { incomplete: true, reason: "completion_not_received" } : {}
    });
  }
  const scripts = new Map;
  const toolSlices = [];
  for (const log of logs.filter((l) => l.attrs["event.name"] === "codex.tool_result")) {
    const id = string(log.attrs["conversation.id"]), duration = number(log.attrs.duration_ms);
    if (!sessions.has(id) || duration === undefined)
      continue;
    const call = string(log.attrs.call_id), name = string(log.attrs.tool_name) || "tool";
    if (isControl(name))
      continue;
    const native = ordered.find((s) => s.name === "code_mode.handler.execute" && s.attrs.call_id === call && spanSession(s) === id);
    const start = native?.start ?? log.at - ms(duration), end = native?.end ?? log.at;
    const source = string(log.attrs.arguments);
    if (native && (log.attrs["agentprof.control_script"] === true || captureContents && isControlScript(source)))
      continue;
    let args;
    if (captureContents && source) {
      try {
        args = JSON.parse(source);
      } catch {
        args = { code: source };
      }
    }
    const annotation = captureContents && source ? toolArgumentAnnotations(args, true) : {};
    if (annotation.truncated !== undefined) {
      annotation.args_truncated = annotation.truncated;
      delete annotation.truncated;
    }
    const output = captureContents ? string(log.attrs.output) : "";
    const exit = ["exec_command", "write_stdin", "shell", "shell_command"].includes(name) ? output.match(/(?:Process exited with code |"exit_code"\s*:\s*)(-?\d+)/) : null;
    const denied = logs.some((l) => l.attrs["event.name"] === "codex.sandbox_outcome" && l.attrs["conversation.id"] === id && l.attrs.call_id === call && l.attrs.outcome === "denied");
    const failed = log.attrs.success === false || log.attrs.success === "false" || native?.error || denied;
    const attrs = {
      kind: native ? "script" : "tool-execution",
      call_id: call,
      ...annotation,
      timing: native ? "native-span" : "native-tool-duration",
      ...failed ? { is_error: true } : native?.attrs.outcome === "completed" ? { is_error: false } : exit ? { is_error: Number(exit[1]) !== 0 } : {},
      ...exit ? { exit_code: Number(exit[1]) } : {},
      ...native ? scriptAnnotations("JavaScript", captureContents ? source : undefined) : {}
    };
    if (native?.attrs["capture.incomplete"])
      attrs.incomplete = true;
    const intent = captureContents ? object(args).description ?? object(args).justification : undefined;
    if (captureContents && typeof intent === "string" && intent)
      attrs.intent = intent;
    const slice = add(id, log.key, "Tools", name, start, end, attrs);
    if (plugin && start < first) {
      slice.start = first;
      slice.attrs.incomplete = true;
    }
    if (native) {
      scripts.set(`${id}:${native.attrs["cell.id"]}`, slice);
      getSession(id).attrs.session_labels = ["scripted tools"];
    }
    toolSlices.push({ slice, log });
    edge(ownerPrompt(slice), slice);
  }
  for (const { slice, log } of toolSlices) {
    if (slice.attrs.kind === "script")
      continue;
    const brokers = ordered.filter((s) => s.trace === log.trace && s.name === "code_mode.broker.invoke_tool" && spanSession(s) === slice.session);
    if (brokers.length === 1) {
      const script = scripts.get(`${slice.session}:${brokers[0].attrs["cell.id"]}`);
      if (script) {
        slice.attrs.parent_call_id = script.attrs.call_id;
        edge(script, slice);
      }
    }
    const response = responses.filter((s) => s.session === slice.session && s.start <= slice.start).sort((a, b) => compareTime(b.start, a.start))[0];
    edge(response, slice);
  }
  for (const session of sessions.values()) {
    const parent = string(session.attrs.parent_session);
    if (!parent)
      continue;
    const launch = captureContents ? toolSlices.find(({ slice, log }) => slice.session === parent && slice.name.endsWith("spawn_agent") && string(log.attrs.output).includes(session.id))?.slice : undefined;
    if (launch) {
      launch.attrs.delegation = true;
      launch.attrs.child_session = session.id;
      edge(launch, inputs.get(session.id));
    }
  }
  for (const session of sessions.values()) {
    const work = responses.filter((s) => s.session === session.id).sort((a, b) => compareTime(a.start, b.start));
    const limits = [...new Set(work.map((s) => integer(s.attrs.context_window_tokens)).filter((v) => v !== undefined))];
    if (limits.length === 1)
      session.attrs.context_window_tokens = limits[0];
    let config, previous = "";
    for (const response of work) {
      const attrs = { harness: "codex" };
      for (const key of ["provider", "model", "effort", "context_window_tokens"])
        if (response.attrs[key] !== undefined)
          attrs[key] = response.attrs[key];
      if (session.attrs.session_labels)
        attrs.session_labels = session.attrs.session_labels;
      const value = JSON.stringify(attrs);
      if (value === previous)
        continue;
      if (config)
        config.end = response.start;
      config = add(session.id, `config:${response.id}`, "Configuration", "run-configuration", response.start, session.end, attrs);
      previous = value;
    }
    for (const [name, field] of [
      ["Input tokens", "input_tokens"],
      ["Output tokens", "output_tokens"],
      ["Context size", "context_tokens"],
      ["Context window", "context_window_tokens"]
    ]) {
      let total = 0;
      const cumulative = field === "input_tokens" || field === "output_tokens";
      const samples = [];
      const usage = [...work, ...compactionResponses.filter((slice) => slice.session === session.id)];
      for (const response of usage.sort((a, b) => compareTime(cumulative ? a.end : a.start, cumulative ? b.end : b.start))) {
        const value = integer(response.attrs[field]);
        if (value === undefined) {
          if (field === "context_window_tokens" && samples.length)
            samples.push({ at: response.start, value: 0 });
          continue;
        }
        total += value;
        samples.push({ at: cumulative ? response.end : response.start, value: cumulative ? total : value });
      }
      counters.push({ session: session.id, name, unit: "tokens", ...!cumulative ? { axis: "llm.context.tokens" } : {}, samples });
    }
  }
  if (!plugin && !responses.length && !toolSlices.length)
    throw new Error("No Codex model/tool telemetry captured; check the installed CLI telemetry support.");
  if (plugin)
    for (const session of sessions.values()) {
      session.start = max(first, session.start);
      session.end = min(last, session.end);
    }
  for (const { session, record } of metadata)
    if (record.type === "context_snapshot") {
      const at = isoTime(record.timestamp);
      if (at === undefined || at < first || at > last)
        continue;
      const operation = slices.filter((s) => s.session === session && s.attrs.kind === "assistant-message" && s.start <= at).sort((a, b) => compareTime(b.start, a.start))[0];
      if (operation)
        attachContext(operation, record.payload, counters, at);
    }
  const trace = writeTrace({
    capture,
    pid,
    machineId: integer(processStart.data.machineId) ?? 0,
    processName: "codex",
    processLabel: "Codex",
    category: "codex",
    sessions: [...sessions.values()].filter((s) => s.end >= s.start),
    slices,
    counters,
    clocks: rows.filter((r) => r.source === "clock_snapshot").map((r) => {
      const realtimeNs = ns(r.data.realtimeNs), boottimeNs = ns(r.data.boottimeNs);
      if (realtimeNs === undefined || boottimeNs === undefined)
        throw new Error("Invalid clock snapshot");
      return { realtimeNs, boottimeNs };
    })
  });
  return { trace, summary: {
    sessions: sessions.size,
    responses: responses.length,
    scripts: scripts.size,
    tools: slices.filter((slice) => slice.attrs.kind === "tool-execution").length,
    nestedTools: toolSlices.filter((t) => t.slice.attrs.parent_call_id).length,
    prewarms,
    unmeasuredResponses,
    compactions: extra.filter((slice) => slice.attrs.kind === "compaction").length,
    inputTokens: [...responses, ...compactionResponses].reduce((sum, s) => sum + (integer(s.attrs.input_tokens) ?? 0), 0),
    outputTokens: [...responses, ...compactionResponses].reduce((sum, s) => sum + (integer(s.attrs.output_tokens) ?? 0), 0),
    dropped: processEnd?.data.dropped ?? null,
    processExitCode: processEnd?.data.code ?? null,
    limitations: [
      "Context is sampled request input; reported input includes cached tokens.",
      "TTFT is retained separately from first-content timing.",
      "CPU/heap sampling is not supported."
    ]
  } };
}

// packages/agent-tracing/journal.ts
function parseObservationJournal(text) {
  const lines = text.split(`
`), tail = lines.pop();
  const rows = [];
  let corruptRecords = tail ? 1 : 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row === null || typeof row !== "object" || Array.isArray(row))
        throw new Error("invalid observation");
      const value = row;
      if (typeof value.source !== "string" || !value.source || typeof value.timestamp !== "string" || !/^\d{1,20}$/.test(value.timestamp) || BigInt(value.timestamp) > (1n << 64n) - 1n || value.data === null || typeof value.data !== "object" || Array.isArray(value.data))
        throw new Error("invalid observation");
      rows.push(value);
    } catch {
      corruptRecords++;
    }
  }
  return { rows, corruptRecords };
}

// packages/codex-tracing/plugin-journal.ts
var now = () => String(BigInt(Date.now()) * 1000000n);

class Journal {
  sessionId;
  captureContents;
  output;
  directory;
  start = now();
  fd;
  bytes = 0;
  dropped = 0;
  constructor(sessionId, pid, cwd, path, captureContents = true) {
    this.sessionId = sessionId;
    this.captureContents = captureContents;
    if (path !== undefined && (!path.trim() || !path.endsWith(".pftrace") || path.includes("\x00")))
      throw new Error("output_path must name a .pftrace file.");
    const captureId = randomUUID();
    this.output = resolve2(cwd, path ?? join2("agentprof-traces", `codex-${new Date().toISOString().replace(/[:.]/g, "-")}-${captureId.slice(0, 8)}.pftrace`));
    this.directory = `${this.output}.capture`;
    if (existsSync2(this.output))
      throw new Error(`Output already exists: ${this.output}`);
    mkdirSync2(dirname2(this.output), { recursive: true });
    mkdirSync2(this.directory, { mode: 448 });
    this.fd = openSync(join2(this.directory, "observations.jsonl"), "wx", 384);
    this.add({ source: "process_start", timestamp: this.start, data: {
      pid,
      captureId,
      sessionId,
      output: this.output,
      machineId: currentMachineIdentity().id,
      recorder: "codex-plugin-1",
      capture_contents: this.captureContents
    } });
    this.clock();
  }
  clock() {
    this.add({ source: "clock_snapshot", timestamp: now(), data: Object.fromEntries(Object.entries(captureClockReadings()).map(([key, value]) => [key, String(value)])) });
  }
  add(row) {
    const safe = this.captureContents || ["process_start", "process_end", "clock_snapshot", "session_metadata"].includes(row.source) ? row : { ...row, data: row.source === "codex.hook" ? Object.fromEntries(Object.entries(row.data).filter(([key]) => [
      "hook_event_name",
      "session_id",
      "parent_session",
      "agent_id",
      "agent_type",
      "turn_id",
      "tool_name",
      "tool_use_id",
      "model",
      "source",
      "trigger",
      "prompt_length",
      "started_before_capture",
      "exit_code",
      "is_error"
    ].includes(key))) : omitContent(row.data) };
    const line = JSON.stringify(safe) + `
`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > 128 * 1024 * 1024 && row.source !== "process_end") {
      this.dropped++;
      return;
    }
    writeSync(this.fd, line);
    this.bytes += size;
  }
  flush() {
    fsyncSync(this.fd);
  }
  close(end, incomplete) {
    this.add({ source: "process_end", timestamp: end, data: { dropped: this.dropped, incomplete } });
    this.flush();
    closeSync(this.fd);
  }
}
function publish(directory, output) {
  const { rows, corruptRecords } = parseObservationJournal(readFileSync4(join2(directory, "observations.jsonl"), "utf8"));
  if (corruptRecords)
    rows.push({
      source: "recovery",
      timestamp: rows.at(-1)?.timestamp ?? now(),
      data: { incomplete: true, corrupt_records: corruptRecords }
    });
  const original = rows.find((r) => r.source === "process_start")?.data.output;
  if (!output && (typeof original !== "string" || !isAbsolute(original) || !resolve2(directory).endsWith(".pftrace.capture") || resolve2(original) !== resolve2(directory).slice(0, -".capture".length)))
    throw new Error("Invalid Codex capture identity or output path.");
  const target = output ? resolve2(output) : original;
  if (!target || !target.endsWith(".pftrace"))
    throw new Error("Missing trace output path.");
  if (existsSync2(target))
    throw new Error(`Output already exists: ${target}`);
  const result = convertObservations(rows);
  const temporary = join2(directory, `recording-${randomUUID()}.tmp`);
  writeFileSync2(temporary, result.trace, { flag: "wx", mode: 384 });
  try {
    linkSync(temporary, target);
  } finally {
    unlinkSync2(temporary);
  }
  const summary = { output: target, ...result.summary, corruptRecords };
  writeFileSync2(join2(directory, "summary.json"), JSON.stringify(summary, null, 2) + `
`, { mode: 384 });
  return summary;
}

// packages/codex-tracing/metadata.ts
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
async function readKnownSession(path, id, emit) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let matched = false, owner = id;
  let items = [];
  let model;
  const tracker = new ContextTracker;
  let context;
  for await (const line of lines) {
    if (line.length > 8 * 1024 * 1024)
      continue;
    let r;
    try {
      r = object(JSON.parse(line));
    } catch {
      continue;
    }
    const p = object(r.payload);
    if (r.type === "session_meta") {
      if (matched) {
        owner = "";
        continue;
      }
      if ((p.id ?? p.session_id) !== id)
        break;
      matched = true;
      const spawn = object(object(object(p.source).subagent).thread_spawn);
      emit({ session_id: id, record: { type: r.type, timestamp: r.timestamp, payload: {
        id,
        model_provider: string(p.model_provider),
        cli_version: string(p.cli_version),
        source: { subagent: { thread_spawn: { parent_thread_id: string(spawn.parent_thread_id), agent_role: string(spawn.agent_role) } } }
      } } });
    }
    if (!matched)
      continue;
    if (owner === id && r.type === "response_item") {
      if (p.type === "message")
        items.push(...transcriptItems([{ ...p, id: string(p.id) || `message:${items.length}` }]));
      if (["function_call_output", "custom_tool_call_output"].includes(string(p.type))) {
        const chars = typeof p.output === "string" ? p.output.length : JSON.stringify(p.output ?? "").length;
        items.push({
          id: `result:${p.call_id}`,
          category: "results",
          tokens: estimateContextTokens(chars),
          chars,
          source_id: string(p.call_id),
          source_kind: "tool",
          label: "Tool result"
        });
      }
      if (["function_call", "custom_tool_call"].includes(string(p.type))) {
        const chars = string(p.arguments ?? p.input).length;
        items.push({
          id: `call:${p.call_id}`,
          category: "assistant",
          tokens: estimateContextTokens(chars),
          chars,
          source_id: string(p.call_id),
          source_kind: "tool",
          label: "Tool arguments"
        });
      }
    }
    if (owner === id && r.type === "compacted") {
      items = Array.isArray(p.replacement_history) ? p.replacement_history.flatMap((m, i) => transcriptItems([{ ...object(m), id: `compact:${i}` }])) : [];
      if (typeof p.message === "string")
        items.push({
          id: "summary",
          category: "summaries",
          chars: p.message.length,
          tokens: estimateContextTokens(p.message.length),
          label: "Compaction summary"
        });
    }
    if (r.type === "turn_context" && owner === id)
      model = string(p.model) || undefined;
    if (r.type === "turn_context")
      context = {
        type: r.type,
        timestamp: r.timestamp,
        payload: { model: p.model, effort: p.effort, turn_id: p.turn_id }
      };
    if (r.type === "token_usage_record") {
      owner = string(p.thread_id);
      if (owner === id && context && object(context.payload).turn_id === p.turn_id) {
        model = string(object(context.payload).model) || undefined;
        emit({ session_id: id, record: context });
        context = undefined;
      }
    }
    if (r.type === "event_msg" && p.type === "token_count" && owner === id) {
      const info = object(p.info);
      if (items.length)
        emit({ session_id: id, record: {
          type: "context_snapshot",
          timestamp: r.timestamp,
          payload: tracker.snapshot(items, {
            stage: "transcript-observed",
            basis: "chars/4",
            coverage: "partial",
            model,
            window_tokens: typeof info.model_context_window === "number" ? info.model_context_window : undefined
          })
        } });
      emit({ session_id: id, record: { type: r.type, timestamp: r.timestamp, payload: {
        type: "token_count",
        info: {
          model_context_window: info.model_context_window,
          last_token_usage: info.last_token_usage,
          total_token_usage: info.total_token_usage
        }
      } } });
    }
  }
  return matched;
}

// packages/agent-tracing/process-identity.ts
import { readFileSync as readFileSync5 } from "node:fs";
function linuxProcessStartMarker(stat) {
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 1).trim().split(/\s+/);
  const value = fields[19];
  return value && /^\d+$/.test(value) ? value : undefined;
}
function processStartMarker(pid, platform = process.platform, read = (path, encoding) => readFileSync5(path, encoding)) {
  if (platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0)
    return;
  try {
    return linuxProcessStartMarker(read(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return;
  }
}
function sameProcess(pid, marker, exists = pidExists, start = processStartMarker) {
  if (!exists(pid))
    return false;
  if (!marker)
    return true;
  const current = start(pid);
  return current === undefined || current === marker;
}
function pidExists(pid, signal = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return false;
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// packages/codex-tracing/plugin-collector.ts
var validId = (id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

class Collector {
  state;
  drainMs;
  captureContents;
  identity;
  sessions = new Map;
  pendingGenerations = new Map;
  captures = new Map;
  terminalResults = new Map;
  routes = new Map;
  pending = new Map;
  pendingBytes = 0;
  spans = new Map;
  lastClock = Date.now();
  constructor(state, drainMs = 7000, captureContents = true, identity = { start: processStartMarker, same: sameProcess }) {
    this.state = state;
    this.drainMs = drainMs;
    this.captureContents = captureContents;
    this.identity = identity;
    mkdirSync3(state, { recursive: true, mode: 448 });
  }
  recordState(id, value) {
    writeFileSync3(join3(this.state, `${id}.json`), JSON.stringify(value), { mode: 384 });
  }
  rememberTerminal(id, result) {
    this.terminalResults.set(id, result);
    if (this.terminalResults.size > 256)
      this.terminalResults.delete(this.terminalResults.keys().next().value);
  }
  status(id) {
    if (!validId(id))
      throw new Error("Missing current Codex session identity.");
    const capture = this.captureFor(id);
    if (capture)
      return {
        state: capture.end ? "saving" : "recording",
        output: capture.journal.output,
        session_id: capture.journal.sessionId,
        native_telemetry_received: capture.telemetry
      };
    const terminal = this.terminalResults.get(id);
    if (terminal)
      return terminal;
    const path = join3(this.state, `${id}.json`);
    if (existsSync3(path)) {
      const status = JSON.parse(readFileSync6(path, "utf8"));
      if (["recording", "saving"].includes(status.state) && typeof status.output === "string") {
        const directory = `${status.output}.capture`, summary = join3(directory, "summary.json");
        try {
          if (existsSync3(status.output) && existsSync3(summary))
            return { state: "saved", ...JSON.parse(readFileSync6(summary, "utf8")) };
        } catch {}
        const error = join3(directory, "error.txt");
        try {
          if (existsSync3(error))
            return {
              state: "error",
              output: status.output,
              journal: directory,
              error: readFileSync6(error, "utf8").trim()
            };
        } catch {}
      }
      if (["recording", "saving"].includes(status.state))
        return {
          ...status,
          state: "interrupted",
          message: "Recorder restarted. Recover the retained capture journal."
        };
      return status;
    }
    return { state: "idle", session_id: id };
  }
  captureFor(id) {
    const seen = new Set;
    while (id && !seen.has(id)) {
      seen.add(id);
      const capture = this.captures.get(id);
      if (capture)
        return capture;
      id = this.sessions.get(id)?.parent ?? "";
    }
  }
  add(capture, row) {
    if (capture.end && BigInt(row.timestamp) > BigInt(capture.end))
      return;
    capture.journal.add(row);
  }
  start(id, output, requestedContents = this.captureContents) {
    const session = this.sessions.get(id);
    if (!session || session.ended)
      throw new Error("No live Codex session. Enable and trust the Agent Profiler hooks.");
    if (session.parent)
      throw new Error("Start recording in the primary session; its subagents share the trace.");
    const existing = this.captureFor(id);
    if (existing) {
      if (existing.end)
        throw new Error("The previous recording is still being saved.");
      if (output)
        throw new Error(`Already recording to ${existing.journal.output}`);
      return this.status(id);
    }
    const policy = this.captureContents && session.captureContents !== false && requestedContents;
    const journal = new Journal(id, session.pid, session.cwd, output, policy);
    journal.dropped += session.skippedEvents ?? 0;
    session.skippedEvents = 0;
    const capture = { journal, sessions: new Set([id]), telemetry: false };
    this.terminalResults.delete(id);
    this.captures.set(id, capture);
    for (const item of this.sessions.values()) {
      if (this.captureFor(item.id) !== capture || item.ended)
        continue;
      capture.sessions.add(item.id);
      journal.add({ source: "codex.hook", timestamp: journal.start, data: {
        hook_event_name: "SessionStart",
        session_id: item.id,
        model: item.model,
        parent_session: item.parent,
        source: "recording"
      } });
      if (item.prompt)
        journal.add({
          ...item.prompt,
          timestamp: journal.start,
          data: { ...item.prompt.data, started_before_capture: true }
        });
    }
    journal.flush();
    const status = this.status(id);
    this.recordState(id, status);
    return status;
  }
  stop(id, incomplete = false) {
    const capture = this.captureFor(id);
    if (!capture)
      return this.status(id);
    if (capture.journal.sessionId !== id)
      throw new Error("Stop the recording from its primary session.");
    if (capture.saving)
      return this.status(id);
    capture.end = now();
    const saving = this.status(id);
    try {
      this.recordState(id, saving);
    } catch {}
    capture.saving = (async () => {
      try {
        await delay(this.drainMs);
        this.flushPending();
        for (const sessionId of capture.sessions) {
          const path = this.sessions.get(sessionId)?.transcript;
          if (!path)
            continue;
          try {
            await readKnownSession(path, sessionId, (data) => capture.journal.add({ source: "session_metadata", timestamp: now(), data }));
          } catch {
            capture.journal.dropped++;
          }
        }
        capture.journal.close(capture.end, incomplete);
        const summary = publish(capture.journal.directory);
        const result = { state: "saved", ...summary };
        try {
          this.recordState(id, result);
          this.terminalResults.delete(id);
        } catch {
          this.rememberTerminal(id, result);
        }
        return result;
      } catch (error) {
        const result = {
          state: "error",
          output: capture.journal.output,
          journal: capture.journal.directory,
          error: String(error)
        };
        try {
          this.recordState(id, result);
          this.terminalResults.delete(id);
        } catch {
          this.rememberTerminal(id, result);
        }
        try {
          writeFileSync3(join3(capture.journal.directory, "error.txt"), String(error), { mode: 384 });
        } catch {}
        return result;
      } finally {
        const waiting = [...this.pendingGenerations].filter(([pendingId]) => this.captureFor(pendingId) === capture);
        this.captures.delete(id);
        for (const [pendingId, pending] of waiting) {
          this.pendingGenerations.delete(pendingId);
          this.sessions.set(pendingId, pending);
          if (pending.autoStart && !pending.parent && !pending.ended)
            try {
              this.start(pendingId);
            } catch {}
        }
      }
    })();
    return saving;
  }
  async hook(data, pid, timestamp, autoStart = false, requestedContents = this.captureContents, reportedMarker) {
    const event = string(data.hook_event_name);
    if (data.agent_id && !["SubagentStart", "SubagentStop"].includes(event))
      data = { ...data, parent_session: data.session_id, session_id: data.agent_id };
    const id = string(data.session_id);
    if (!validId(id) || !Number.isInteger(pid) || pid <= 0)
      throw new Error("Invalid hook identity.");
    let session = this.sessions.get(id);
    const marker = reportedMarker && /^\d+$/.test(reportedMarker) ? reportedMarker : this.identity.start(pid);
    const pending = this.pendingGenerations.get(id);
    if (pending) {
      if (pending.pid !== pid || pending.processStartMarker && marker && pending.processStartMarker !== marker)
        throw new Error("Another Codex process generation is waiting for its prior recording to save.");
      if (data.transcript_path)
        pending.transcript = string(data.transcript_path);
      if (data.model)
        pending.model = string(data.model);
      if (event === "SessionEnd")
        pending.ended = true;
      if (event === "UserPromptSubmit") {
        const command = string(data.prompt).trim();
        if (/^tracing status$/.test(command))
          return { decision: "block", reason: "Agent Profiler: previous recording is saving; use tracing_status to check publication." };
        if (/^tracing (?:start|stop)(?:\s|$)/.test(command))
          return { decision: "block", reason: "Agent Profiler: previous recording is saving. Retry this control after publication." };
        if (pending.prompt)
          pending.skippedEvents = (pending.skippedEvents ?? 0) + 1;
        pending.prompt = { source: "codex.hook", timestamp, data: pending.captureContents ? data : { ...data, prompt: undefined, prompt_length: string(data.prompt).length } };
      } else if (event !== "SessionStart")
        pending.skippedEvents = (pending.skippedEvents ?? 0) + 1;
      return {};
    }
    const changed = !!session && (session.pid !== pid || !!session.processStartMarker && !!marker && session.processStartMarker !== marker);
    if (changed) {
      if (event !== "SessionStart")
        throw new Error("Codex process generation changed; start a new session before recording more work.");
      const previous = this.captureFor(id);
      if (previous && !previous.end)
        this.stop(previous.journal.sessionId, true);
      if (previous) {
        this.pendingGenerations.set(id, {
          id,
          pid,
          processStartMarker: marker,
          cwd: string(data.cwd),
          transcript: string(data.transcript_path),
          model: string(data.model),
          parent: session?.parent,
          captureContents: requestedContents && this.captureContents,
          autoStart: autoStart && ["startup", "resume"].includes(string(data.source))
        });
        return { systemMessage: "Previous Agent Profiler recording is saving; this Codex process can record after publication." };
      }
      session = undefined;
    }
    const firstStart = !session || session.ended;
    if (!session) {
      session = { id, pid, processStartMarker: marker, cwd: string(data.cwd), transcript: string(data.transcript_path), model: string(data.model) };
      this.sessions.set(id, session);
    }
    session.captureContents = session.captureContents !== false && requestedContents && this.captureContents;
    const liveCapture = this.captureFor(id);
    if (session.captureContents === false && liveCapture)
      liveCapture.journal.captureContents = false;
    session.pid = pid;
    session.processStartMarker = marker ?? session.processStartMarker;
    if (data.cwd)
      session.cwd = string(data.cwd);
    if (data.transcript_path && event !== "SubagentStart")
      session.transcript = string(data.transcript_path);
    if (data.model && event !== "SubagentStart")
      session.model = string(data.model);
    if (data.parent_session)
      session.parent = string(data.parent_session);
    if (event === "SessionStart")
      session.ended = false;
    if (event === "SessionStart" && firstStart && autoStart && ["startup", "resume"].includes(string(data.source))) {
      const result = this.start(id);
      return { systemMessage: `Agent Profiler: recording to ${result.output}` };
    }
    if (event === "UserPromptSubmit") {
      const control = string(data.prompt).trim().match(/^tracing (start|stop|status)(?:\s+(.+))?$/);
      if (control) {
        const capture = this.captureFor(id);
        const observation = { source: "codex.control", timestamp, data: {
          session_id: id,
          turn_id: data.turn_id,
          action: control[1],
          prompt_length: Buffer.byteLength(string(data.prompt))
        } };
        if (capture && !capture.end)
          capture.journal.add(observation);
        let result;
        try {
          result = control[1] === "start" ? this.start(id, control[2]) : control[1] === "stop" ? this.stop(id) : this.status(id);
        } catch (error) {
          result = { state: "error", error: String(error) };
        }
        if (!capture && control[1] === "start")
          this.captureFor(id)?.journal.add(observation);
        const status = object(result);
        const message = status.state === "recording" ? `Recording to ${status.output}` : status.state === "saved" ? `Saved ${status.output}` : status.state === "saving" ? `Saving ${status.output}` : status.state === "idle" ? "Not recording." : string(status.error) || string(status.message);
        return { decision: "block", reason: `Agent Profiler: ${message}` };
      }
      session.prompt = { source: "codex.hook", timestamp, data: session.captureContents ? data : { ...data, prompt: undefined, prompt_length: string(data.prompt).length } };
    }
    if (event === "SubagentStart" || event === "SubagentStop") {
      const childId = string(data.agent_id);
      if (validId(childId)) {
        let child = this.sessions.get(childId);
        if (!child) {
          child = { ...session, id: childId, prompt: undefined, transcript: "" };
          this.sessions.set(childId, child);
        }
        child.parent = id;
        child.ended = event === "SubagentStop";
        if (event === "SubagentStart" && data.transcript_path)
          child.transcript = string(data.transcript_path);
        if (data.model)
          child.model = string(data.model);
        if (data.agent_transcript_path)
          child.transcript = string(data.agent_transcript_path);
      }
    }
    const capture = this.captureFor(id);
    if (capture && !capture.end) {
      capture.sessions.add(id);
      if (data.agent_id)
        capture.sessions.add(string(data.agent_id));
      const response = object(data.tool_response);
      this.add(capture, { source: "codex.hook", timestamp, data: session.captureContents && capture.journal.captureContents ? data : {
        ...data,
        prompt: undefined,
        prompt_length: typeof data.prompt === "string" ? data.prompt.length : data.prompt_length,
        ...typeof response.exit_code === "number" ? { exit_code: response.exit_code } : {},
        ...typeof response.isError === "boolean" ? { is_error: response.isError } : {}
      } });
    }
    if (event === "Stop" || event === "Interrupt")
      session.prompt = undefined;
    if (event === "SessionEnd") {
      session.ended = true;
      if (capture && !capture.end && capture.journal.sessionId === id)
        this.stop(id);
    }
    this.flushPending();
    return {};
  }
  ingest(data) {
    if ([...this.captures.values()].some((c) => !c.journal.captureContents))
      tagControlScripts(data);
    const parsed = readOtel([{ source: "otel", timestamp: now(), data: omitContent(data) }]);
    const remember = (trace, id) => {
      if (!trace || !id)
        return;
      const ids = this.routes.get(trace) ?? new Set;
      ids.add(id);
      this.routes.set(trace, ids);
    };
    for (const log of parsed.logs)
      remember(log.trace, string(log.attrs["conversation.id"]));
    for (const span of parsed.spans.values()) {
      remember(span.trace, string(span.attrs["conversation.id"]) || string(span.attrs["thread.id"]));
      this.spans.set(span.key, { ...span, attrs: {
        "conversation.id": string(span.attrs["conversation.id"]),
        "thread.id": string(span.attrs["thread.id"])
      } });
    }
    for (const resource of array(data.resourceLogs))
      for (const scope of array(object(resource).scopeLogs))
        for (const log of array(object(scope).logRecords)) {
          const attrs = attributes(object(log).attributes), id = string(attrs["conversation.id"]);
          const capture = this.captureFor(id);
          if (!capture)
            continue;
          const row = { source: "/v1/logs", timestamp: now(), data: { resourceLogs: [{ scopeLogs: [{ logRecords: [log] }] }] } };
          const at = ns(object(log).timeUnixNano) || isoTime(attrs["event.timestamp"]);
          if (at === undefined || at < BigInt(capture.journal.start) || capture.end && at > BigInt(capture.end))
            continue;
          capture.sessions.add(id);
          capture.telemetry = true;
          capture.journal.add(row);
        }
    for (const resource of array(data.resourceSpans))
      for (const scope of array(object(resource).scopeSpans))
        for (const wire of array(object(scope).spans)) {
          const value = object(wire), key = `${value.traceId}:${value.spanId}`, span = parsed.spans.get(key);
          if (span) {
            const bytes = Buffer.byteLength(JSON.stringify(omitContent(wire))) + array(value.attributes).reduce((total, raw) => {
              const text = object(object(raw).value).stringValue;
              return total + (typeof text === "string" ? text.length * 6 : 0);
            }, 0);
            this.pendingBytes += bytes - (this.pending.get(key)?.bytes ?? 0);
            this.pending.set(key, { span, wire, bytes });
          }
        }
    this.flushPending();
    if (this.pending.size > 8192 || this.pendingBytes > 16 * 1024 * 1024 || this.spans.size > 32768 || this.routes.size > 32768) {
      for (const capture of this.captures.values())
        capture.journal.dropped++;
      this.pending.clear();
      this.pendingBytes = 0;
      this.spans.clear();
      this.routes.clear();
    }
    if (!this.captures.size) {
      this.pending.clear();
      this.pendingBytes = 0;
      this.spans.clear();
      this.routes.clear();
    }
  }
  flushPending() {
    for (const [key, { span, wire, bytes }] of this.pending) {
      let parent = span, id = "";
      const seen = new Set;
      while (parent && !seen.has(parent.key)) {
        seen.add(parent.key);
        id = string(parent.attrs["conversation.id"]) || string(parent.attrs["thread.id"]);
        if (id)
          break;
        parent = this.spans.get(parent.parent);
      }
      const route = this.routes.get(span.trace);
      if (!id && route?.size === 1)
        id = [...route][0];
      if (!id)
        continue;
      const capture = this.captureFor(id);
      if (capture && span.end >= BigInt(capture.journal.start) && (!capture.end || span.start <= BigInt(capture.end))) {
        capture.sessions.add(id);
        capture.telemetry = true;
        const value = object(wire);
        const attrs = [...array(value.attributes), { key: "conversation.id", value: { stringValue: id } }];
        capture.journal.add({ source: "/v1/traces", timestamp: now(), data: { resourceSpans: [{ scopeSpans: [{ spans: [{ ...value, attributes: attrs }] }] }] } });
      }
      this.pending.delete(key);
      this.pendingBytes -= bytes;
    }
  }
  tick() {
    for (const capture of this.captures.values())
      if (!capture.end) {
        capture.journal.flush();
        if (Date.now() - this.lastClock >= 60000)
          capture.journal.clock();
        const root = this.sessions.get(capture.journal.sessionId);
        if (root && !this.identity.same(root.pid, root.processStartMarker)) {
          root.ended = true;
          this.stop(root.id, true);
        }
      }
    if (Date.now() - this.lastClock >= 60000)
      this.lastClock = Date.now();
    for (const [id, session] of this.sessions)
      if (!this.captureFor(id) && (session.ended || !this.identity.same(session.pid, session.processStartMarker)))
        this.sessions.delete(id);
  }
}
async function serve(state, runConnection, persist = writeFileSync3) {
  const connection = runConnection ?? readConnection(state), collector = new Collector(state, runConnection?.socket ? 500 : 7000);
  const build = createHash3("sha256").update(readFileSync6(fileURLToPath(import.meta.url))).digest("hex");
  let timer, lastActivity = Date.now();
  const server = createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...connection.generation ? { "x-agentprof-generation": connection.generation } : {},
        "x-agentprof-build": build
      });
      response.end(JSON.stringify(data));
    };
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${connection.token}`)
      return reply(403, { error: "Forbidden" });
    lastActivity = Date.now();
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          reply(413, { error: "Request too large" });
          return;
        }
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "gzip")
        body = gunzipSync(body, { maxOutputLength: 8 * 1024 * 1024 });
      const data = object(JSON.parse(body.toString("utf8")));
      if (request.url === "/health")
        return reply(200, {
          ready: true,
          generation: connection.generation,
          build,
          active_captures: collector.captures.size
        });
      if (request.url === "/shutdown") {
        if (runConnection)
          return reply(409, { error: "The plugin receiver exits when its Codex sessions end." });
        if (collector.captures.size)
          return reply(409, { error: "Recording is still active." });
        reply(200, { stopping: true });
        setTimeout(() => {
          if (timer)
            clearInterval(timer);
          server.close();
        }, 0);
        return;
      }
      if ((request.url === "/v1/logs" || request.url === "/v1/traces") && !runConnection?.socket) {
        collector.ingest(data);
        return reply(200, {});
      }
      if (request.url === "/hook")
        return reply(200, await collector.hook(object(data.hook), Number(data.pid), string(data.timestamp), data.auto_start === true, data.capture_contents !== false, string(data.process_start_marker) || undefined));
      const id = string(data.session_id);
      if (request.url === "/start")
        return reply(200, collector.start(id, typeof data.output_path === "string" ? data.output_path : undefined, data.capture_contents !== false));
      if (request.url === "/stop")
        return reply(200, collector.stop(id));
      if (request.url === "/status")
        return reply(200, collector.status(id));
      reply(404, { error: "Unknown operation" });
    } catch (error) {
      reply(400, { error: String(error) });
    }
  });
  server.requestTimeout = 12000;
  await new Promise((done, reject) => {
    server.once("error", reject);
    if (connection.socket)
      server.listen(connection.socket, done);
    else
      server.listen(connection.port, "127.0.0.1", done);
  });
  let published = false;
  try {
    if (runConnection) {
      if (connection.socket)
        chmodSync2(connection.socket, 384);
      persist(join3(state, "connection.json"), JSON.stringify({ ...connection, run: true }), { flag: "wx", mode: 384 });
      published = true;
    }
    persist(join3(state, "receiver-owner.json"), JSON.stringify({
      pid: process.pid,
      marker: processStartMarker(process.pid),
      generation: connection.generation
    }), { mode: 384 });
    timer = setInterval(() => {
      collector.tick();
      if (runConnection?.socket && !collector.captures.size && !collector.sessions.size && Date.now() - lastActivity > 2500)
        shutdown();
    }, 1000);
  } catch (error) {
    await new Promise((done) => server.close(() => done()));
    if (published)
      try {
        unlinkSync3(join3(state, "connection.json"));
      } catch {}
    throw error;
  }
  async function shutdown() {
    if (timer)
      clearInterval(timer);
    if (server.listening)
      await new Promise((done, reject) => {
        server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : done());
      });
    if (connection.socket) {
      try {
        unlinkSync3(connection.socket);
      } catch {}
      try {
        rmdirSync(dirname3(connection.socket));
      } catch {}
    }
    try {
      const current = readConnection(state);
      if (current.generation === connection.generation) {
        unlinkSync3(join3(state, "connection.json"));
        unlinkSync3(join3(state, "receiver-owner.json"));
      }
    } catch {}
  }
  return { server, collector, close: shutdown };
}

// packages/agent-tracing/lease.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync7, realpathSync, renameSync as renameSync2, rmSync, statSync as statSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join4, win32 } from "node:path";
import { randomUUID as randomUUID2, createHash as createHash4 } from "node:crypto";
import { setTimeout as delay2 } from "node:timers/promises";
import { spawn } from "node:child_process";
function reaperCommand(path, timeoutMs, platform = process.platform) {
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const command = 'printf "READY\\n"; cat >/dev/null';
  if (platform === "win32") {
    let parent = win32.dirname(path);
    try {
      parent = realpathSync.native(parent);
    } catch {}
    const canonical = win32.join(parent, win32.basename(path)).toLowerCase();
    const name = `Global\\agentprof_${createHash4("sha256").update(canonical).digest("hex").slice(0, 32)}`;
    const powershell = `$m = [System.Threading.Mutex]::new($false, '${name}'); ` + `$locked = $false; try {$locked = $m.WaitOne(${timeoutMs})} ` + `catch [System.Threading.AbandonedMutexException] {$locked = $true}; ` + `if (!$locked) {exit 2}; [Console]::Out.WriteLine('READY'); ` + `[Console]::In.ReadToEnd() | Out-Null; $m.ReleaseMutex(); $m.Dispose()`;
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell]];
  }
  if (platform === "darwin")
    return ["lockf", ["-t", seconds, `${path}.reaper.lock`, "sh", "-c", command]];
  return ["flock", ["-x", "-w", seconds, `${path}.reaper.lock`, "sh", "-c", command]];
}
async function acquireReaper(path, timeoutMs) {
  const [binary, args] = reaperCommand(path, timeoutMs);
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for stale-owner recovery lock"));
    }, timeoutMs + 1000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (/READY\r?\n/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Stale-owner recovery lock failed (${code}): ${stderr}`));
    });
  });
  return () => {
    child.stdin.end();
  };
}
async function acquireDirectoryLease(path, timeoutMs = 5000) {
  const nonce = randomUUID2(), deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync4(path, { mode: 448 });
      try {
        writeFileSync4(join4(path, "owner.json"), JSON.stringify({
          pid: process.pid,
          marker: processStartMarker(process.pid),
          nonce
        }), { flag: "wx", mode: 384 });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      const owner = statSync2(path);
      return () => {
        try {
          const current = statSync2(path), stored = JSON.parse(readFileSync7(join4(path, "owner.json"), "utf8"));
          if (current.dev !== owner.dev || current.ino !== owner.ino || stored.nonce !== nonce)
            return;
          const quarantine = `${path}.release-${nonce}`;
          renameSync2(path, quarantine);
          const moved = statSync2(quarantine);
          if (moved.dev === owner.dev && moved.ino === owner.ino)
            rmSync(quarantine, { recursive: true, force: true });
          else if (!existsSync4(path))
            renameSync2(quarantine, path);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      try {
        const before = statSync2(path);
        let stale = false;
        try {
          const owner = JSON.parse(readFileSync7(join4(path, "owner.json"), "utf8"));
          stale = typeof owner.pid === "number" && !sameProcess(owner.pid, owner.marker);
        } catch {
          stale = Date.now() - before.mtimeMs > 15000;
        }
        if (stale) {
          const releaseReaper = await acquireReaper(path, timeoutMs);
          try {
            const current = statSync2(path);
            let stillStale = false;
            try {
              const owner = JSON.parse(readFileSync7(join4(path, "owner.json"), "utf8"));
              stillStale = typeof owner.pid === "number" && !sameProcess(owner.pid, owner.marker);
            } catch {
              stillStale = Date.now() - current.mtimeMs > 15000;
            }
            if (stillStale && current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
              const quarantine = `${path}.stale-${nonce}`;
              renameSync2(path, quarantine);
              rmSync(quarantine, { recursive: true, force: true });
            }
          } finally {
            releaseReaper();
          }
          continue;
        }
      } catch (error) {
        if (error.code !== "ENOENT")
          throw error;
      }
      await delay2(50);
    }
  }
  throw new Error(`Timed out waiting for receiver lease: ${path}`);
}

// packages/codex-tracing/plugin.ts
var script = fileURLToPath2(import.meta.url);
var buildId = createHash5("sha256").update(readFileSync8(script)).digest("hex");
var captureContents = captureContentsEnabled(process.env.AGENTPROF_CAPTURE_CONTENTS);
var args = process.argv.slice(2);
var command = args.shift();
function option(name) {
  const index = args.indexOf(name);
  if (index < 0)
    return;
  const value = args[index + 1];
  if (!value)
    throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}
var state = resolve3(option("--state") ?? stateDirectory(option("--plugin-data")));

class TransportError extends Error {
}
var portBound = (port) => new Promise((resolve) => {
  const client = connect({ host: "127.0.0.1", port });
  let done = false;
  const finish = (bound) => {
    if (done)
      return;
    done = true;
    client.destroy();
    resolve(bound);
  };
  client.once("connect", () => finish(true));
  client.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
  client.setTimeout(200, () => finish(true));
});
function ownerConnection() {
  if (!existsSync5(join5(state, "connection.json")))
    return;
  const connection = readConnection(state);
  if (!connection.run || !connection.socket)
    throw new Error("An old fixed-endpoint profile must be migrated before recording. Close old Codex sessions and run agentprof-codex install --migrate.");
  try {
    const owner = JSON.parse(readFileSync8(join5(state, "receiver-owner.json"), "utf8"));
    if (owner.generation === connection.generation && Number.isSafeInteger(owner.pid) && sameProcess(owner.pid, owner.marker))
      return connection;
  } catch {}
}
async function request(path, data, connection) {
  if (!connection.socket || !ownerConnection())
    throw new TransportError("No plugin receiver owns this socket.");
  const body = JSON.stringify({ ...object(data), capture_contents: captureContents });
  const response = await new Promise((done, reject) => {
    const client = httpRequest({
      socketPath: connection.socket,
      path,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
      timeout: 12000
    }, (reply) => {
      let text = "";
      reply.on("data", (chunk) => {
        text += chunk;
        if (text.length > 1024 * 1024)
          reply.destroy();
      });
      reply.once("end", () => done({ status: reply.statusCode ?? 0, headers: reply.headers, text }));
      reply.once("error", (error) => reject(new TransportError(String(error))));
    });
    client.once("timeout", () => client.destroy(new TransportError("Recorder request timed out.")));
    client.once("error", (error) => reject(new TransportError(String(error))));
    client.end(body);
  });
  if (response.headers["x-agentprof-generation"] !== connection.generation || response.headers["x-agentprof-build"] !== buildId)
    throw new Error("Plugin receiver does not match this installed runtime.");
  const result = object(JSON.parse(response.text));
  if (response.status >= 400)
    throw new Error(string(result.error) || `Recorder returned ${response.status}`);
  return result;
}
async function ensureReceiver() {
  const current = ownerConnection();
  if (current)
    return current;
  mkdirSync5(state, { recursive: true, mode: 448 });
  const release = await acquireDirectoryLease(join5(state, "receiver-lifecycle.lock"), 1e4);
  try {
    const live = ownerConnection();
    if (live)
      return live;
    if (existsSync5(join5(state, "connection.json"))) {
      const previous = readConnection(state);
      if (previous.socket) {
        try {
          unlinkSync4(previous.socket);
        } catch {}
        try {
          rmdirSync2(dirname4(previous.socket));
        } catch {}
      }
      unlinkSync4(join5(state, "connection.json"));
    }
    try {
      unlinkSync4(join5(state, "receiver-owner.json"));
    } catch {}
    const log = openSync2(join5(state, "receiver.log"), "a", 384);
    let child;
    try {
      child = spawn2(process.execPath, [script, "serve", "--state", state], { detached: true, windowsHide: true, stdio: ["ignore", log, log] });
    } finally {
      closeSync2(log);
    }
    await new Promise((done, reject) => {
      child.once("spawn", done);
      child.once("error", reject);
    });
    child.unref();
    for (let attempt = 0;attempt < 100; attempt++) {
      const connection = ownerConnection();
      if (connection)
        try {
          if ((await request("/health", {}, connection)).build === buildId)
            return connection;
        } catch {}
      await delay3(50);
    }
    throw new Error("Plugin receiver did not start. Check agentprof/receiver.log in the Codex home.");
  } finally {
    release();
  }
}
async function requestWithReceiver(path, data) {
  const connection = await ensureReceiver();
  try {
    return await request(path, data, connection);
  } catch (error) {
    if (!(error instanceof TransportError))
      throw error;
    for (let attempt = 0;attempt < 40; attempt++) {
      if (!ownerConnection())
        return request(path, data, await ensureReceiver());
      await delay3(50);
    }
    throw error;
  }
}
var tools = ["start", "stop", "status"].map((action) => ({
  name: `tracing_${action}`,
  description: action === "start" ? "Start a local Agent Profiler recording of this Codex session and its subagents. Returns the trace output path." : action === "stop" ? "Stop this recording and begin saving asynchronously. Returns a saving state and output path immediately; call tracing_status later to confirm saved or error." : "Get this session’s recording state and trace path.",
  inputSchema: { type: "object", properties: action === "start" ? { output_path: { type: "string", description: "Optional new .pftrace path, relative to the session working directory." } } : {}, additionalProperties: false },
  annotations: { readOnlyHint: action === "status", destructiveHint: false, openWorldHint: false }
}));
async function mcp() {
  const lines = createInterface2({ input: process.stdin, crlfDelay: Infinity });
  const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const handle = async (message) => {
    if (message.id === undefined)
      return;
    const params = object(message.params);
    if (message.method === "initialize")
      return reply(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agentprof", version: "0.2.0" }
      });
    if (message.method === "tools/list")
      return reply(message.id, { tools });
    if (message.method === "ping")
      return reply(message.id, {});
    if (message.method !== "tools/call")
      return console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" }
      }));
    try {
      const name = string(params.name);
      if (!tools.some((tool) => tool.name === name))
        throw new Error("Unknown tracing tool.");
      const metadata = object(params._meta);
      const id = string(metadata.threadId) || string(object(metadata["x-codex-turn-metadata"]).thread_id);
      if (!id)
        throw new Error("Codex did not supply the current session identity. Requires Codex CLI 0.160.0 or compatible.");
      const result = await requestWithReceiver(`/${name.slice("tracing_".length)}`, { ...object(params.arguments), session_id: id });
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.state === "error" });
    } catch (error) {
      reply(message.id, { isError: true, content: [{ type: "text", text: `${String(error)}
Enable the Agent Profiler profile with codex -p agentprof and review /hooks.` }] });
    }
  };
  for await (const line of lines) {
    if (line.length > 1024 * 1024)
      continue;
    try {
      handle(object(JSON.parse(line)));
    } catch {}
  }
}
try {
  if (process.platform === "win32" && ["install", "serve", "hook", "mcp", "start", "stop", "status"].includes(command ?? ""))
    throw new Error("The Codex plugin recorder requires a private Unix socket; Windows is not supported yet.");
  if (command === "serve") {
    mkdirSync5(state, { recursive: true, mode: 448 });
    const generation = randomBytes2(16).toString("hex"), socket = privateSocketPath(generation);
    try {
      await serve(state, { socket, token: randomBytes2(32).toString("hex"), generation, run: true });
    } catch (error) {
      rmSync2(dirname4(socket), { recursive: true, force: true });
      throw error;
    }
  } else if (command === "mcp")
    await mcp();
  else if (command === "hook") {
    const timestamp = now(), hook = object(JSON.parse(readFileSync8(0, "utf8")));
    try {
      console.log(JSON.stringify(await requestWithReceiver("/hook", {
        hook,
        pid: process.ppid,
        timestamp,
        process_start_marker: processStartMarker(process.ppid),
        auto_start: args.includes("--auto-start")
      })));
    } catch (error) {
      const message = `Agent Profiler: ${String(error)}. Enable the profile with codex -p agentprof and review /hooks.`;
      const control = hook.hook_event_name === "UserPromptSubmit" && /^tracing (start|stop|status)(?:\s|$)/.test(string(hook.prompt).trim());
      console.log(JSON.stringify(control ? { decision: "block", reason: message } : { systemMessage: message }));
    }
  } else if (command === "install") {
    mkdirSync5(state, { recursive: true, mode: 448 });
    const release = await acquireDirectoryLease(join5(state, "install.lock"), 1e4);
    let legacyRelease;
    try {
      legacyRelease = await acquireDirectoryLease(join5(state, "receiver-lifecycle.lock"), 30000);
      if (args.some((arg) => !["--migrate", "--auto-start"].includes(arg)))
        throw new Error("Usage: agentprof-codex install [--migrate] [--auto-start]");
      const profile = join5(dirname4(state), "agentprof.config.toml");
      const marker = join5(state, "profile.sha256"), pending = join5(state, "profile-pending.sha256");
      if (existsSync5(profile)) {
        const hash = createHash5("sha256").update(readFileSync8(profile)).digest("hex");
        if (existsSync5(pending) && readFileSync8(pending, "utf8") === hash && !readFileSync8(profile, "utf8").includes("[otel]"))
          renameSync3(pending, marker);
        if (!existsSync5(marker) || hash !== readFileSync8(marker, "utf8"))
          throw new Error("The Agent Profiler profile was edited. Nothing was changed; resolve it manually before installing.");
      }
      const previous = existsSync5(join5(state, "connection.json")) ? readConnection(state) : undefined;
      if (previous?.run && ownerConnection())
        try {
          await request("/health", {}, previous);
        } catch (error) {
          if (String(error).includes("does not match this installed runtime"))
            throw new Error("A receiver from an earlier plugin build is still active. Close its Codex sessions before reinstalling.");
          throw error;
        }
      const legacyPort = previous && !previous.run ? previous.port : undefined;
      if (existsSync5(profile) && readFileSync8(profile, "utf8").includes("[otel]") && !args.includes("--migrate"))
        throw new Error("An old fixed-endpoint profile exists. Close old Codex sessions, stop its receiver, then rerun install --migrate.");
      if (legacyPort && await portBound(legacyPort))
        throw new Error("The old receiver still owns its port. Close old Codex sessions and stop it before migrating.");
      const root = resolve3(dirname4(script), "../../..");
      const market = spawnSync("codex", ["plugin", "marketplace", "add", root], { stdio: "inherit" });
      if (market.status !== 0)
        throw new Error(`Codex marketplace installation failed: ${market.error ?? market.status}`);
      const installed = spawnSync("codex", ["plugin", "add", "agentprof@agentprof", "--json"], { encoding: "utf8" });
      if (installed.status !== 0)
        throw new Error(`Codex plugin installation failed: ${installed.stderr || installed.error || installed.status}`);
      const runtime = join5(string(object(JSON.parse(installed.stdout)).installedPath), "runtime/codex-tracing.mjs");
      if (legacyPort && await portBound(legacyPort))
        throw new Error("The old receiver restarted during installation; close old sessions and retry.");
      const hooks = writeInstalledProfile(state, dirname4(state), runtime, args.includes("--auto-start"));
      if (legacyPort && await portBound(legacyPort))
        throw new Error("Old receiver restarted during migration; its connection was retained.");
      if (previous && !previous.run)
        unlinkSync4(join5(state, "connection.json"));
      console.log(`Plugin installed: ${hooks}. Start Codex normally with: codex -p agentprof`);
    } finally {
      legacyRelease?.();
      release();
    }
  } else if (command === "recover" && args[0])
    console.log(JSON.stringify(publish(resolve3(args[0]), args[1])));
  else if (["start", "stop", "status"].includes(command ?? "")) {
    const id = option("--session");
    if (!id)
      throw new Error("Provide --session SESSION_ID, or use the recording tools inside Codex.");
    console.log(JSON.stringify(await requestWithReceiver(`/${command}`, { session_id: id, output_path: args[0] })));
  } else {
    console.log("Usage: agentprof-codex install [--migrate] [--auto-start] | start [OUTPUT.pftrace] --session ID | stop --session ID | status --session ID | recover CAPTURE_DIRECTORY [OUTPUT.pftrace]");
    if (command && command !== "--help")
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
export {
  tools
};
