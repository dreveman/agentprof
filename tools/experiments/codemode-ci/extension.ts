// SPDX-License-Identifier: Apache-2.0
// Read-only CI API replay. Both variants use identical data and tool results.
import {readFileSync, appendFileSync} from 'node:fs';
import {Type} from 'typebox';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function(pi: ExtensionAPI) {
  const snapshot = JSON.parse(readFileSync(process.env.AGENTPROF_CI_SNAPSHOT!, 'utf8'));
  const failures = new Map(snapshot.failures.map((failure: any) => [failure.id, failure]));
  function result(name: string, args: unknown, value: unknown) {
    appendFileSync(process.env.AGENTPROF_CI_AUDIT!, JSON.stringify({name, args}) + '\n');
    return {content: [{type: 'text' as const, text: JSON.stringify(value)}], structuredContent: value};
  }
  pi.registerTool({
    name: 'ci_list_failures', label: 'List CI failures',
    description: 'List failed test cases from the immutable CI snapshot. Follow next_cursor until null. History is available through ci_get_failure_history. No batch-history endpoint is available.',
    parameters: Type.Object({run_id: Type.String(), cursor: Type.Optional(Type.Integer({minimum: 0}))}),
    outputSchema: Type.Object({run_id: Type.String(), failures: Type.Array(Type.Object({
      id: Type.String(), owner: Type.String(), test: Type.String(), duration_ms: Type.Integer(),
    })), next_cursor: Type.Union([Type.Integer(), Type.Null()])}),
    async execute(_id, args) {
      if (args.run_id !== snapshot.run_id) throw new Error('Unknown run');
      const start = args.cursor ?? 0;
      const end = Math.min(start + 48, snapshot.failures.length);
      return result('ci_list_failures', args, {run_id: snapshot.run_id,
        failures: snapshot.failures.slice(start, end).map(({history, ...failure}: any) => failure),
        next_cursor: end < snapshot.failures.length ? end : null});
    },
  });
  pi.registerTool({
    name: 'ci_get_failure_history', label: 'Get CI failure history',
    description: 'Get the four preceding completed default-branch executions for one failed test case. History is newest first. Each conclusion is passed or failed. Read-only; use at most 16 concurrent requests.',
    parameters: Type.Object({failure_id: Type.String()}),
    outputSchema: Type.Object({failure_id: Type.String(), history: Type.Array(Type.Object({
      run_id: Type.String(), commit: Type.String(), conclusion: Type.String(),
      started_at: Type.String(), duration_ms: Type.Integer(),
    }))}),
    async execute(_id, args) {
      const failure: any = failures.get(args.failure_id);
      if (!failure) throw new Error('Unknown failure ID');
      return result('ci_get_failure_history', args, {failure_id: failure.id, history: failure.history});
    },
  });
}
