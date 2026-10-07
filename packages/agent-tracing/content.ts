// SPDX-License-Identifier: Apache-2.0
/** Shared capture policy. Existing recordings remain content-on unless the
 * user explicitly opts out; a disabled policy is always inherited by exports. */
export function captureContentsEnabled(value: unknown, fallback = true): boolean {
  if (value === false || (typeof value === 'string' && ['0', 'false'].includes(value.toLowerCase()))) return false;
  if (value === true || (typeof value === 'string' && ['1', 'true'].includes(value.toLowerCase()))) return true;
  return fallback;
}

/** Strip values before writing a raw OTLP/CLI journal. Keep numerical usage,
 * timing and identity attributes, but never serialize text-bearing fields. */
const metadataAttribute = /^(?:event\.(?:name|timestamp|kind|sequence)|(?:conversation|thread|turn|session)\.id|(?:gen_ai\.system|model|provider_name|reasoning_effort|app\.version|tool_name|call_id|cell\.id|outcome|success|reason|status_code|tool_use_id)|[\w.]+(?:_tokens?|_count|_bytes|_length|_ms|_ns|_id|_code))$/i;

export function omitContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitContent);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  if (typeof source.key === 'string' &&
      (!metadataAttribute.test(source.key) || /(?:prompt|argument|output|input|content|body|text|tool_response|tool_result)/i.test(source.key) &&
      !/(?:length|bytes|tokens|count|duration|status|exit_code)$/i.test(source.key))) return undefined;
  return Object.fromEntries(Object.entries(source).flatMap(([key, entry]) => {
    if (/(?:^|[._-])(?:prompt|arguments?|output|input|content|body|text|tool_response|tool_result|error|message|description|stack|script)(?:$|[._-])/i.test(key) &&
        !/(?:length|bytes|tokens|count|duration|status|exit_code)$/i.test(key)) return [];
    const safe = omitContent(entry);
    return safe === undefined ? [] : [[key, safe]];
  }));
}
