// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {applyEnvOverrides, defaultConfig} from './config.ts';
import {captureContentsEnabled, omitContent} from '../../../agent-tracing/content.ts';

test('one opt-out disables Pi prompt text and tool values; legacy switch stays tool-only', () => {
  const defaults = defaultConfig();
  expect(defaults.captureContents).toBe(true);
  expect(defaults.categories['prompt-data']).toBe(true);
  const shared = applyEnvOverrides(defaults, {AGENTPROF_CAPTURE_CONTENTS: '0', PI_TRACING_CAPTURE_CONTENTS: '1'}).config;
  expect(shared.captureContents).toBe(false);
  expect(shared.categories['prompt-data']).toBe(false);
  const legacy = applyEnvOverrides(defaults, {PI_TRACING_CAPTURE_CONTENTS: '0'}).config;
  expect(legacy.captureContents).toBe(false);
  expect(legacy.categories['prompt-data']).toBe(true);
  expect(captureContentsEnabled('false')).toBe(false);
  expect(captureContentsEnabled(undefined)).toBe(true);
});

test('AGENTPROF_AUTO_TRACE wins over legacy Pi switches and TRACING_DIR is captured', () => {
  const on = applyEnvOverrides(defaultConfig(), {AGENTPROF_AUTO_TRACE: '1', PI_TRACING: '0', AGENTPROF_TRACING_DIR: ' traces '}).config;
  expect(on.autoTrace).toBe(true);
  expect(on.startupMode).toBe('recording');
  expect(on.traceDir).toBe('traces');
  const off = applyEnvOverrides(defaultConfig(), {AGENTPROF_AUTO_TRACE: '0', PI_TRACING: '1'}).config;
  expect(off.autoTrace).toBe(false);
  expect(off.startupMode).toBe('off');
  const legacy = applyEnvOverrides(defaultConfig(), {PI_TRACING: '1'}).config;
  expect(legacy.autoTrace).toBe(false);
  expect(legacy.startupMode).toBe('recording');
  expect(legacy.traceDir).toBeUndefined();
  const bad = applyEnvOverrides(defaultConfig(), {AGENTPROF_AUTO_TRACE: 'yes'});
  expect(bad.config.startupMode).toBe('off');
  expect(bad.warnings.join(' ')).toContain('AGENTPROF_AUTO_TRACE');
});

test('metadata-only journals redact nested OTLP text without losing counters and identities', () => {
  const raw = {resourceLogs: [{scopeLogs: [{logRecords: [{attributes: [
    {key: 'event.name', value: {stringValue: 'codex.tool_result'}},
    {key: 'conversation.id', value: {stringValue: 'session'}},
    {key: 'arguments', value: {stringValue: 'SECRET_COMMAND'}},
    {key: 'output', value: {stringValue: 'SECRET_RESULT'}},
    {key: 'custom.payload', value: {stringValue: 'SECRET_UNKNOWN'}},
    {key: 'input_token_count', value: {intValue: '12'}},
  ]}]}]}]};
  const safe = JSON.stringify(omitContent(raw));
  expect(safe).not.toMatch(/SECRET_COMMAND|SECRET_RESULT|SECRET_UNKNOWN/);
  expect(safe).toContain('codex.tool_result');
  expect(safe).toContain('input_token_count');
});
