// SPDX-License-Identifier: Apache-2.0
// Experiment-only adapter: one child, fixed prompt, read tool only, no shared edits.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync, openSync, closeSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Type} from '@earendil-works/pi-ai';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  let child: ReturnType<typeof spawn> | undefined;
  let completed: Promise<number> | undefined;
  let sessionId: string | undefined;
  const directory = process.env.AGENTPROF_REVIEW_OUTPUT!;
  const prompt = readFileSync(process.env.AGENTPROF_REVIEW_PROMPT!, 'utf8');
  pi.registerTool({
    name: 'subagent', label: 'Launch reviewer',
    description: 'Launch the comparison-reviewer in the background. It has only a read tool and receives the fixed review task. Call wait_subagents to collect its result. Exactly one reviewer may be launched.',
    parameters: Type.Object({task: Type.String({description: 'The exact review task supplied in the user prompt'})}),
    async execute(_id, params, _signal, _update, ctx) {
      if (child) throw new Error('Only one reviewer is allowed');
      if (params.task.trim() !== prompt.trim()) throw new Error('Pass the exact review task without additions');
      mkdirSync(directory, {recursive: true});
      sessionId = randomUUID();
      const extensions = (process.env.PI_SUBAGENT_EXTENSIONS ?? '').split(',').filter(Boolean);
      if (!extensions.length) throw new Error('Tracing extension was not inherited');
      const args = ['--provider', 'anthropic', '--model', process.env.AGENTPROF_COMPARISON_MODEL!,
        '--thinking', 'off', '--no-extensions', ...extensions.flatMap(p => ['-e', p]),
        '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
        '--tools', 'read', '--session-id', sessionId, '--session-dir', join(directory, 'sessions'),
        '--name', 'comparison-reviewer', '--mode', 'json', '-p', '--', prompt];
      const output = openSync(join(directory, 'events.jsonl'), 'wx', 0o600);
      const error = openSync(join(directory, 'stderr.log'), 'wx', 0o600);
      try {
        child = spawn('pi', args, {cwd: ctx.cwd, env: {...process.env,
          PI_SUBAGENT_TYPE: 'comparison-reviewer', PI_TRACING_PARENT_SESSION_ID: ctx.sessionManager.getSessionId()},
          stdio: ['ignore', output, error]});
      } finally {closeSync(output); closeSync(error);}
      const childProcess = child;
      completed = new Promise(resolve => {
        childProcess.once('error', () => resolve(-1));
        childProcess.once('close', code => resolve(code ?? -1));
      });
      return {content: [{type: 'text', text: `Started reviewer ${sessionId}. Collect with wait_subagents.`}],
        details: {sessionId, role: 'reviewer'}};
    },
  });
  pi.registerTool({
    name: 'wait_subagents', label: 'Collect reviewer',
    description: 'Wait for the single reviewer and return its final answer.',
    parameters: Type.Object({}),
    async execute() {
      if (!completed) throw new Error('Launch the reviewer first');
      const code = await completed;
      const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const message = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
      const report = message?.content.filter((c: {type: string}) => c.type === 'text').map((c: {text: string}) => c.text).join('\n');
      return {content: [{type: 'text', text: JSON.stringify({sessionId, code, report})}], details: {sessionId, code}};
    },
  });
  pi.on('session_shutdown', async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 3000);
    try {await completed;} finally {clearTimeout(timer);}
  });
}
