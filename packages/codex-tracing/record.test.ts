// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fixture, rootSession, childSession} from './fixture.ts';
import {sessionMetadata, capturedSessionIds, readKnownSession} from './metadata.ts';

test('launcher authenticates local telemetry, handles gzip, preserves stdout and exit code, and refuses overwrite', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'codex-recorder-'));
  try {
    const source = join(folder, 'fixture.json'); writeFileSync(source, JSON.stringify(fixture()));
    const executable = join(folder, 'codex');
    writeFileSync(executable, `#!${process.execPath}
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
const configs = process.argv.filter(a => a.startsWith('otel.'));
const endpoint = configs.find(a => a.startsWith('otel.exporter=')).match(/endpoint="([^"]+)"/)[1];
const token = configs[0].match(/Bearer ([^"]+)/)[1];
const headers = {authorization: 'Bearer ' + token, 'content-type': 'application/json'};
const rejected = await fetch(endpoint, {method:'POST', body:'{}'});
if (rejected.status !== 403) throw new Error('Unauthenticated telemetry accepted');
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(rootSession)}}));
for (const row of JSON.parse(readFileSync(${JSON.stringify(source)}, 'utf8'))) {
  if (!row.source.startsWith('/v1/')) continue;
  const url = new URL(row.source, endpoint);
  const response = await fetch(url, {method:'POST', headers:{...headers,'content-encoding':'gzip'}, body:gzipSync(JSON.stringify(row.data))});
  if (!response.ok) throw new Error('Export rejected');
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:220,output_tokens:10}}));
process.exit(7);
`, {mode: 0o700});
    const output = join(folder, 'recording.pftrace');
    const command = [process.execPath, resolve('tools/record-codex.ts'), output, '--', 'fixture'];
    const run = Bun.spawn(command, {env: {...process.env, PATH: `${folder}:${process.env.PATH}`}, stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect(code).toBe(7);
    expect(stdout.trim().split('\n').map(l => JSON.parse(l).type)).toEqual(['thread.started', 'turn.completed']);
    expect(stderr).toContain(`Agent Profiler trace: ${output}`);
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const summary = JSON.parse(readFileSync(`${output}.capture/summary.json`, 'utf8'));
    expect(summary).toMatchObject({processExitCode: 7, responses: 3, scripts: 1, nestedTools: 1, dropped: 0});
    const original = readFileSync(output);
    const again = Bun.spawn(command, {env: {...process.env, PATH: `${folder}:${process.env.PATH}`}, stdout: 'pipe', stderr: 'pipe'});
    const diagnostic = await new Response(again.stderr).text();
    expect(await again.exited).not.toBe(0);
    expect(diagnostic).toContain('Output already exists');
    expect(readFileSync(output)).toEqual(original);
  } finally {rmSync(folder, {recursive: true, force: true});}
}, 20000);

test('transcript supplement reads only captured sessions and whitelists metadata', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'codex-metadata-'));
  try {
    mkdirSync(join(folder, '2026'), {recursive: true});
    const rows = [
      {type:'session_meta', timestamp:'2026-10-04T00:00:00Z', payload:{id:rootSession, model_provider:'openai', cwd:'private-path'}},
      {type:'event_msg', timestamp:'2026-10-04T00:00:01Z', payload:{type:'token_count', info:{model_context_window:258400, last_token_usage:{input_tokens:25, output_tokens:4}}, rate_limits:{private:'unused'}}},
      {type:'response_item', payload:{type:'reasoning', encrypted_content:'not-recorded'}},
    ];
    writeFileSync(join(folder, '2026', `rollout-${rootSession}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n'));
    const result: Record<string, unknown>[] = [];
    expect(await sessionMetadata(folder, [rootSession], r => result.push(r))).toBe(1);
    expect(result.length).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/private-path|not-recorded|rate_limits/);
    expect(capturedSessionIds(fixture())).toContain(rootSession);
  } finally {rmSync(folder, {recursive: true, force: true});}
});

test('forked transcript metadata excludes inherited usage and retains the child context limit', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'codex-fork-metadata-'));
  try {
    const path = join(folder, 'child.jsonl');
    const rows = [
      {type: 'session_meta', payload: {id: childSession, session_id: rootSession}},
      {type: 'session_meta', payload: {id: rootSession}},
      {type: 'turn_context', payload: {turn_id: 'parent-turn', model: 'parent-model', effort: 'high'}},
      {type: 'token_usage_record', payload: {thread_id: rootSession, turn_id: 'parent-turn'}},
      {type: 'event_msg', payload: {type: 'token_count', info: {model_context_window: 999999}}},
      {type: 'turn_context', payload: {turn_id: 'child-turn', model: 'child-model', effort: 'low', developer_instructions: 'private'}},
      {type: 'token_usage_record', payload: {thread_id: childSession, turn_id: 'child-turn'}},
      {type: 'event_msg', payload: {type: 'token_count', info: {model_context_window: 258400, last_token_usage: {input_tokens: 25}}}},
    ];
    writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n'));
    const result: Record<string, unknown>[] = [];
    expect(await readKnownSession(path, childSession, r => result.push(r))).toBe(true);
    expect(result.length).toBe(3);
    expect(result[1]).toMatchObject({session_id: childSession, record: {type: 'turn_context', payload: {model: 'child-model', effort: 'low'}}});
    expect(result[2]).toMatchObject({record: {payload: {info: {model_context_window: 258400}}}});
    expect(JSON.stringify(result)).not.toMatch(/parent-model|999999|private/);
    expect(await readKnownSession(path, rootSession, () => {throw new Error('Mismatched transcript was read');})).toBe(false);
  } finally {rmSync(folder, {recursive: true, force: true});}
});

test('transcript context counts retained content and compaction changes without copying raw data', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'codex-context-'));
  try {
    const path = join(folder, 'session.jsonl');
    const rows = [
      {type: 'session_meta', payload: {id: rootSession}},
      {type: 'turn_context', payload: {model: 'one'}},
      {type: 'response_item', payload: {type: 'message', role: 'user', id: 'user', content: [{type: 'input_text', text: 'PRIVATE_PROMPT'}]}},
      {type: 'event_msg', payload: {type: 'token_count', info: {model_context_window: 1000}}},
      {type: 'response_item', payload: {type: 'function_call_output', call_id: 'read1', output: 'x'.repeat(400)}},
      {type: 'event_msg', payload: {type: 'token_count', info: {model_context_window: 1000}}},
      {type: 'compacted', payload: {replacement_history: [], message: 'SUMMARY'}},
      {type: 'event_msg', payload: {type: 'token_count', info: {model_context_window: 1000}}},
      {type: 'turn_context', payload: {model: 'two'}},
      {type: 'event_msg', payload: {type: 'token_count', info: {model_context_window: 2000}}},
    ];
    writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n'));
    const result: any[] = [];
    await readKnownSession(path, rootSession, r => result.push(r));
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROMPT|SUMMARY|x{400}/);
    const snapshots = result.filter(r => r.record.type === 'context_snapshot').map(r => r.record.payload);
    expect(snapshots.length).toBe(4);
    expect(snapshots[0]).toMatchObject({baseline: true, stage: 'transcript-observed', categories: {prompts: 4}});
    expect(snapshots[1].changes[0]).toMatchObject({source_id: 'read1', delta_tokens: 100, change: 'added'});
    expect(snapshots[2].changes.some((c: any) => c.source_id === 'read1' && c.change === 'removed')).toBe(true);
    expect(snapshots[2].categories).toEqual({summaries: 2});
    expect(snapshots[3]).toMatchObject({baseline: true, model: 'two', window_tokens: 2000});
  } finally {rmSync(folder, {recursive: true, force: true});}
});
