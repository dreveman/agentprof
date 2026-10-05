// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ContextTracker, transcriptItems} from './context.ts';
import {attachContext} from '../../../agent-tracing/context.ts';
import {writeTrace, type Slice, type Counter} from '../../../agent-tracing/trace.ts';
import {SETUP_SQL} from '../../../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL, OVERVIEW_QUERIES} from '../../../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

test('context tracks retained results, replacements, removals and model changes without copying text', () => {
  const tracker = new ContextTracker();
  const first = transcriptItems([{role: 'user', timestamp: 1, content: 'abcd'}]);
  const options = {stage: 'request-input', model: 'one', window_tokens: 100};
  expect(tracker.snapshot(first, options).baseline).toBe(true);
  const second = tracker.snapshot([...first, ...transcriptItems([{role: 'toolResult', timestamp: 2,
    content: [{type: 'text', text: 'a'.repeat(40)}], toolCallId: 'read-1', toolName: 'read'}])], options);
  expect(second.categories).toEqual({prompts: 1, results: 10});
  expect(second.changes[0]).toMatchObject({source_id: 'read-1', delta_tokens: 10, change: 'added'});
  expect(JSON.stringify(second)).not.toContain('a'.repeat(40));
  expect(tracker.snapshot(first, options).changes[0]).toMatchObject({change: 'removed', delta_tokens: -10});
  expect(tracker.snapshot(first, {...options, model: 'two'}).baseline).toBe(true);
});

test('system section updates and deferred tool removals are counted only in their final state', () => {
  const items = transcriptItems([
    {role: 'system', content: 'abcd', sections: {rules: 'a'.repeat(40), skill: 'abcd'}, toolsAdded: [{name: 'read', description: 'first'}]},
    {role: 'system', sections: {rules: 'abcd', skill: null}, toolsAdded: [{name: 'read', description: 'second'}, {name: 'edit'}]},
    {role: 'system', toolsRemoved: [{name: 'read'}]},
  ]);
  expect(items.filter(i => i.category === 'rules').map(i => i.tokens)).toEqual([1]);
  expect(items.some(i => i.category === 'skills')).toBe(false);
  expect(items.filter(i => i.category === 'tools').map(i => i.label)).toEqual(['edit']);
});

test('snapshot annotations import with typed changes, scoped tool links, zeros and independent totals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentprof-context-'));
  try {
    const tracker = new ContextTracker(), counters: Counter[] = [];
    const epoch = 1_790_000_000_000_000_000n;
    const slices: Slice[] = [
      {session: 'one', id: 'tool', track: 'Tools', name: 'read', start: epoch + 5n, end: epoch + 9n,
        attrs: {kind: 'tool-execution', call_id: 'read'}, flows: []},
      ...[0, 10, 20].map(i => ({session: 'one', id: `request:${i}`, track: 'Requests', name: 'request',
        start: epoch + BigInt(i), end: epoch + BigInt(i + 1), attrs: {kind: 'provider-request'}, flows: []})),
    ];
    const prompt = {id: 'prompt', category: 'prompts' as const, tokens: 3};
    attachContext(slices[1]!, tracker.snapshot([prompt], {stage: 'request-input', reported_tokens: 20, window_tokens: 100}), counters);
    attachContext(slices[2]!, tracker.snapshot([prompt, {id: 'result', category: 'results', tokens: 40, source_id: 'read', label: 'Tool result'}],
      {stage: 'request-input', reported_tokens: 60, window_tokens: 100}), counters);
    attachContext(slices[3]!, tracker.snapshot([prompt], {stage: 'request-input', window_tokens: 100}), counters);
    const trace = writeTrace({capture: 'context-test', pid: 12000, machineId: 101, processName: 'claude', processLabel: 'Claude Code',
      category: 'claude', clocks: [{realtimeNs: epoch, boottimeNs: 1000000000n}],
      sessions: [{id: 'one', start: epoch, end: epoch + 100n, attrs: {harness: 'claude-code'}}], slices, counters});
    writeFileSync(join(directory, 'trace.pftrace'), trace);
    const sql = `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\nSELECT
      (SELECT COUNT(*) FROM agentprof_context_snapshots)=3,
      (SELECT MAX(estimated_tokens) FROM agentprof_context_snapshots)=43,
      (SELECT MAX(reported_tokens) FROM agentprof_context_snapshots)=60,
      (SELECT COUNT(*) FROM agentprof_context_changes WHERE delta_tokens=40 AND tool='read' AND NOT baseline)=1,
      (SELECT COUNT(*) FROM agentprof_context_changes WHERE delta_tokens=-40 AND change='removed')=1,
      (SELECT COUNT(*) FROM agentprof_counter_tracks WHERE group_name='Context')=2,
      (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0)=0;`;
    const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? fileURLToPath(new URL('../../../../third_party/src/perfetto/tools/trace_processor', import.meta.url)),
      [join(directory, 'trace.pftrace'), '-Q', sql], {encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n').at(-1)).toBe('1,1,1,1,1,1,1');
    for (const query of Object.values(OVERVIEW_QUERIES).filter(q => q.includes('agentprof_context_'))) {
      const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? fileURLToPath(new URL('../../../../third_party/src/perfetto/tools/trace_processor', import.meta.url)),
        [join(directory, 'trace.pftrace'), '-Q', `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\n${query}`], {encoding: 'utf8'});
      expect(result.status, result.stderr).toBe(0);
    }
  } finally {rmSync(directory, {recursive: true, force: true});}
});
