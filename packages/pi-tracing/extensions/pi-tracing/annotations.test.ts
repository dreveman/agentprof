// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { assistantAnnotations, promptAnnotations, scriptAnnotations, toolArgumentAnnotations } from "./annotations.ts";

test('script metadata counts physical lines without treating a final newline as another line', () => {
  expect(scriptAnnotations('JavaScript', 'one\r\n\r\ntwo\r\n')).toEqual({language: 'JavaScript', line_count: 3});
  expect(scriptAnnotations('JavaScript', '')).toEqual({language: 'JavaScript', line_count: 0});
  expect(scriptAnnotations('JavaScript', undefined)).toEqual({language: 'JavaScript'});
  expect(scriptAnnotations('JavaScript', 'one\rtwo')).toEqual({language: 'JavaScript', line_count: 2});
});

test("tool argument metadata records UTF-8 byte counts and keys without values", () => {
  const input = {text: "secret 🌍", count: 42, enabled: false};
  const attrs = toolArgumentAnnotations(input, 'metadata');
  expect(attrs["bytes"]).toBe(new TextEncoder().encode(JSON.stringify(input)).length);
  expect(attrs["keys"]).toEqual(["text", "count", "enabled"]);
  expect(JSON.stringify(attrs)).not.toContain("secret");
  let reads = 0;
  const guarded = {toJSON() {reads++; throw new Error('must not serialize');},
    get secret() {reads++; throw new Error('must not inspect values');}};
  expect(toolArgumentAnnotations(guarded, false)).toEqual({});
  expect(toolArgumentAnnotations(guarded, 'disabled')).toEqual({});
  expect(reads).toBe(0);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(toolArgumentAnnotations(circular, true)).toEqual({"serializable": false});
});

test("captured tool arguments retain scalar and collection types with bounded content", () => {
  const input = {count: -2, ratio: 1.25, enabled: false, labels: ["a", "b"]};
  expect(toolArgumentAnnotations(input, true)["args"]).toEqual(input);
  const command = 'printf ' + 'x'.repeat(6000);
  expect(toolArgumentAnnotations({command}, true)["args"]).toEqual({command});
  const edit = {path: 'file.ts', oldText: 'old'.repeat(2000), newText: 'new'.repeat(2000)};
  expect(toolArgumentAnnotations(edit, true)["args"]).toEqual(edit);
  const bounded = toolArgumentAnnotations({text: "x".repeat(65531) + "🌍more"}, true);
  expect(bounded["truncated"]).toBe(true);
  expect((bounded["args"] as {text: string}).text).toBe('x'.repeat(65531));
  const sparse = toolArgumentAnnotations([1, null, 2], true);
  expect(sparse["args"]).toEqual([1]);
  expect(sparse["truncated"]).toBe(true);
});

test("prompt capture retains length when disabled and flags bounded text without splitting Unicode", () => {
  expect(promptAnnotations("hello 🌍", false)).toEqual({"length": 8});
  expect(promptAnnotations("hello 🌍", true)).toEqual({"length": 8, "text": "hello 🌍"});
  expect(promptAnnotations(undefined, true)).toEqual({});
  expect(promptAnnotations("", true)).toEqual({"length": 0, "text": ""});
  const long = "x".repeat(65535) + "🌍";
  expect(promptAnnotations(long, true)).toEqual({"length": 65537,
    "text": "x".repeat(65535), "truncated": true});
});

const stream = { startNs: 100n, firstUpdateNs: 120n, updates: 3, bytes: 10 };

test("assistant metadata preserves measured zeroes and omits unknown usage", () => {
  const attrs = assistantAnnotations({ usage: { input: 0, output: 4, cacheRead: -1, cacheWrite: NaN } }, stream, 200n);
  expect(attrs["input_tokens"]).toBe(0);
  expect(attrs["output_tokens"]).toBe(4);
  expect(attrs["cache_read_tokens"]).toBeUndefined();
  expect(attrs["cache_write_tokens"]).toBeUndefined();
  expect(attrs["total_tokens"]).toBeUndefined();
  expect(attrs["first_content_ns"]).toBe(20);
  expect(attrs["duration_ns"]).toBe(100);
});

test("assistant metadata never copies content, headers, errors, or arbitrary fields", () => {
  const attrs = assistantAnnotations({ model: "example", content: "SECRET", errorMessage: "SECRET",
    headers: { authorization: "SECRET" }, usage: { extra: "SECRET", output: "4" } },
    { ...stream, firstUpdateNs: null }, 200n);
  expect(Object.values(attrs)).not.toContain("SECRET");
  expect(attrs["first_content_ns"]).toBeUndefined();
  expect(attrs["output_tokens"]).toBeUndefined();
  expect(attrs["model"]).toBe("example");
});

test('run configuration whitelists bounded metadata and preserves effort off', async () => {
  const {runConfigurationAnnotations} = await import('./annotations.ts');
  expect(runConfigurationAnnotations({model: 'model-a', provider: 'provider-a', effort: 'off',
    contextWindowTokens: 200000})).toEqual({
    'harness': 'pi', 'model': 'model-a',
    'provider': 'provider-a', 'effort': 'off', 'context_window_tokens': 200000,
  });
  expect(runConfigurationAnnotations({model: 'x'.repeat(201), provider: {}, effort: undefined})).toEqual({
    'harness': 'pi',
  });
  expect(runConfigurationAnnotations({contextWindowTokens: 0})).toEqual({'harness': 'pi'});
  expect(runConfigurationAnnotations({sessionLabels: ['codemode', ' sandbox, A ', 'codemode', '', 7]}))
    .toEqual({harness: 'pi', session_labels: ['codemode', 'sandbox, A']});
  expect(runConfigurationAnnotations({sessionLabels: []})).toEqual({harness: 'pi'});
  expect(runConfigurationAnnotations({sessionLabels: ['x'.repeat(101), null]})).toEqual({harness: 'pi'});
  expect(runConfigurationAnnotations({sessionLabels: 'codemode'})).toEqual({harness: 'pi'});
  expect(runConfigurationAnnotations({sessionLabels: Array.from({length: 40}, (_, i) => `label-${i}`)})
    .session_labels).toHaveLength(32);
});
