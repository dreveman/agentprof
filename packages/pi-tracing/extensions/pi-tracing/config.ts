// SPDX-License-Identifier: Apache-2.0
// Layered, validated, package-owned configuration. There is deliberately no
// top-level `settings.json` key: ExtensionAPI exposes no SettingsManager and
// Pi's settings schema is closed. Precedence (high -> low):
//   live in-memory > CLI flags > PI_TRACING_* env > trusted project override
//   > global file > built-ins.

export type StartupMode = "off" | "armed" | "recording";

export type CategoryId =
  | "agent"
  | "llm"
  | "tools"
  | "bash"
  | "session"
  | "model"
  | "runtime"
  | "node.perf"
  | "node.gc"
  | "contents"
  | "prompt-data"
  | "system"
  | "stream.verbose"
  | "workflow";

export const ALL_CATEGORIES: CategoryId[] = [
  "agent",
  "llm",
  "tools",
  "bash",
  "session",
  "model",
  "runtime",
  "node.perf",
  "node.gc",
  "contents",
  "prompt-data",
  "system",
  "stream.verbose",
  "workflow",
];

export interface TracingConfig {
  startupMode: StartupMode;
  categories: Record<CategoryId, boolean>;
  sampleHz: number;
  maxFileMB: number;
  maxFiles: number;
  captureContents: boolean;
  queueDepth: number;
  queueBytes: number;
  finalizeDeadlineMs: number;
  laneCap: number;
  /** Tool names treated as child-agent launch/delegate calls. Matched exactly
   * against toolName; delegation metadata belongs to the tool execution span. */
  childTools: string[];
}

export function defaultConfig(): TracingConfig {
  return {
    startupMode: "off",
    categories: {
      agent: true,
      llm: true,
      tools: true,
      bash: true,
      session: true,
      model: true,
      runtime: true,
      "node.perf": false,
      "node.gc": false,
      contents: true,
      "prompt-data": true,
      system: false,
      "stream.verbose": false,
      workflow: true,
    },
    sampleHz: 1,
    maxFileMB: 64,
    maxFiles: 5,
    captureContents: true,
    queueDepth: 1024,
    queueBytes: 1024 * 1024,
    finalizeDeadlineMs: 1000,
    laneCap: 64,
    childTools: ["rig_launch", "subagent"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an explicit child-tool allowlist: 0-32 exact tool names, each
 * 1-64 chars. Falls back to `fallback` with a warning on any violation. */
export function parseChildTools(value: unknown, fallback: string[], source: string, warnings: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 32 || !value.every((entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 64)) {
    warnings.push(`${source}: childTools must be an array of 0-32 tool names (1-64 chars each); ignored`);
    return [...fallback];
  }
  return [...new Set(value as string[])];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export interface ConfigParse {
  config: TracingConfig;
  warnings: string[];
}

/** Merge one raw JSON object over `base`. Unknown categories warn; `system`
 *  cannot be enabled because this recorder has no system tracing backend. */
export function applyRawConfig(base: TracingConfig, raw: unknown, source: string): ConfigParse {
  const warnings: string[] = [];
  const config: TracingConfig = {
    ...base,
    categories: { ...base.categories },
  };
  if (!isRecord(raw)) {
    warnings.push(`${source}: not a JSON object; ignored`);
    return { config, warnings };
  }
  const startup = raw["startupMode"] ?? raw["startup"];
  if (startup !== undefined) {
    if (startup === "off" || startup === "armed" || startup === "recording") {
      config.startupMode = startup;
    } else {
      warnings.push(`${source}: bad startupMode; expected off|armed|recording`);
    }
  }
  // Legacy v1/v2 keys map onto startupMode explicitly (no silent combination).
  const enabled = raw["enabled"];
  const armed = raw["armed"];
  if (typeof enabled === "boolean" || typeof armed === "boolean") {
    if (enabled === true) config.startupMode = "recording";
    else if (armed === true) config.startupMode = "armed";
    else if (enabled === false && armed !== true) config.startupMode = "off";
    warnings.push(`${source}: legacy enabled/armed mapped to startupMode=${config.startupMode}`);
  }
  const categories = raw["categories"];
  if (isRecord(categories)) {
    for (const [key, value] of Object.entries(categories)) {
      if (!ALL_CATEGORIES.includes(key as CategoryId)) {
        warnings.push(`${source}: unknown category "${key}"; ignored`);
        continue;
      }
      if (typeof value !== "boolean") {
        warnings.push(`${source}: category "${key}" must be boolean; ignored`);
        continue;
      }
      const id = key as CategoryId;
      if (id === "system" && value === true) {
        warnings.push(`${source}: system capture is unsupported; staying off`);
        continue;
      }
      config.categories[id] = value;
    }
  } else if (categories !== undefined) {
    warnings.push(`${source}: categories must be an object; ignored`);
  }
  config.sampleHz = clampInt(raw["sampleHz"], config.sampleHz, 0, 60);
  if (raw["maxEvents"] !== undefined) {
    warnings.push(`${source}: maxEvents is unsupported and is ignored`);
  }
  config.maxFileMB = clampInt(raw["maxFileMB"], config.maxFileMB, 1, 1024);
  config.maxFiles = clampInt(raw["maxFiles"], config.maxFiles, 1, 50);
  config.queueDepth = clampInt(raw["queueDepth"], config.queueDepth, 64, 65536);
  config.queueBytes = clampInt(raw["queueBytes"], config.queueBytes, 64 * 1024, 64 * 1024 * 1024);
  config.finalizeDeadlineMs = clampInt(raw["finalizeDeadlineMs"], config.finalizeDeadlineMs, 100, 5000);
  config.laneCap = clampInt(raw["laneCap"], config.laneCap, 1, 64);
  config.childTools = parseChildTools(raw["childTools"], config.childTools, source, warnings);
  if (typeof raw["captureContents"] === "boolean") config.captureContents = raw["captureContents"];
  return { config, warnings };
}

export interface EnvOverrides {
  config: Omit<Partial<TracingConfig>, "categories"> & { categories?: Partial<Record<CategoryId, boolean>> };
  warnings: string[];
  autostart: boolean;
}

/** PI_TRACING=1 forces recording autostart; PI_TRACING=0 forces off.
 *  PI_TRACING_CATEGORIES supports "agent,llm,-tools" and "all"/"none". */
export function parseEnv(env: NodeJS.ProcessEnv): EnvOverrides {
  const warnings: string[] = [];
  const config: EnvOverrides["config"] = {};
  let autostart = false;
  const master = env["PI_TRACING"];
  if (master === "1" || master === "true") autostart = true;
  else if (master === "0" || master === "false") autostart = false;
  else if (master !== undefined && master !== "") warnings.push(`PI_TRACING=${master}: expected 0|1`);

  const startup = env["PI_TRACING_STARTUP"];
  if (startup === "off" || startup === "armed" || startup === "recording") {
    (config as { startupMode?: StartupMode }).startupMode = startup;
  } else if (startup !== undefined) {
    warnings.push(`PI_TRACING_STARTUP=${startup}: expected off|armed|recording`);
  }

  const cats = env["PI_TRACING_CATEGORIES"];
  if (cats !== undefined && cats.trim() !== "") {
    const parsed: Partial<Record<CategoryId, boolean>> = {};
    for (const token of cats.split(",")) {
      const trimmed = token.trim();
      if (trimmed === "") continue;
      if (trimmed === "all") {
        for (const id of ALL_CATEGORIES) {
          if (id !== "system") parsed[id] = true;
        }
        continue;
      }
      if (trimmed === "none") {
        for (const id of ALL_CATEGORIES) parsed[id] = false;
        continue;
      }
      const negated = trimmed.startsWith("-");
      const name = negated ? trimmed.slice(1) : trimmed.replace(/^\+/, "");
      if (!ALL_CATEGORIES.includes(name as CategoryId)) {
        warnings.push(`PI_TRACING_CATEGORIES: unknown category "${name}"`);
        continue;
      }
      const id = name as CategoryId;
      if (id === "system" && !negated) {
        warnings.push("PI_TRACING_CATEGORIES: system capture is unsupported; staying off");
        continue;
      }
      parsed[id] = !negated;
    }
    config.categories = parsed;
  }

  const maxMB = env["PI_TRACING_MAX_FILE_MB"];
  if (maxMB !== undefined && maxMB !== "") {
    const parsed = Math.floor(Number(maxMB));
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 1024) {
      config.maxFileMB = parsed;
    } else {
      warnings.push(`PI_TRACING_MAX_FILE_MB=${maxMB}: expected 1..1024`);
    }
  }
  const childTools = env["PI_TRACING_CHILD_TOOLS"];
  if (childTools !== undefined && childTools.trim() !== "") {
    const names = childTools.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (names.length > 32 || !names.every((entry) => entry.length <= 64)) {
      warnings.push("PI_TRACING_CHILD_TOOLS: expected 0-32 comma-separated tool names (<=64 chars each)");
    } else {
      config.childTools = [...new Set(names)];
    }
  }
  const capture = env["PI_TRACING_CAPTURE_CONTENTS"];
  if (capture === "1" || capture === "true") config.captureContents = true;
  else if (capture === "0" || capture === "false") config.captureContents = false;
  else if (capture !== undefined) warnings.push(`PI_TRACING_CAPTURE_CONTENTS=${capture}: expected 0|1`);

  return { config, warnings, autostart };
}

export function applyEnvOverrides(base: TracingConfig, env: NodeJS.ProcessEnv): ConfigParse {
  const parsed = parseEnv(env);
  const warnings = [...parsed.warnings];
  const config: TracingConfig = { ...base, categories: { ...base.categories } };
  if (parsed.config.startupMode !== undefined) {
    if (parsed.config.startupMode === "armed") {
      warnings.push("PI_TRACING_STARTUP=armed: flight recording is unsupported; starting OFF instead");
      config.startupMode = "off";
    } else {
      config.startupMode = parsed.config.startupMode;
    }
  }
  // The explicit master switch wins over other environment values.
  if (parsed.autostart) config.startupMode = "recording";
  else if (env["PI_TRACING"] === "0" || env["PI_TRACING"] === "false") config.startupMode = "off";
  if (parsed.config.categories !== undefined) {
    for (const [key, value] of Object.entries(parsed.config.categories)) {
      if (value !== undefined) config.categories[key as CategoryId] = value;
    }
  }
  if (parsed.config.maxFileMB !== undefined) config.maxFileMB = parsed.config.maxFileMB;
  if (parsed.config.childTools !== undefined) config.childTools = parsed.config.childTools;
  if (parsed.config.captureContents !== undefined) config.captureContents = parsed.config.captureContents;
  return { config, warnings };
}
