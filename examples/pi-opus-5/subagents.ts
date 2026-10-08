// SPDX-License-Identifier: Apache-2.0
// Example-only launcher: real Pi children with isolated context and a shared
// scratch workspace. The tracing extension supplies the inherited trace flags.
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync, openSync, closeSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Type} from '@earendil-works/pi-ai';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

interface Child {
  sessionId: string;
  role: string;
  parentSessionId: string;
  directory: string;
  process: ChildProcess;
  done: Promise<number>;
  exited: boolean;
}

export default function (pi: ExtensionAPI) {
  const children = new Map<string, Child>();
  pi.registerTool({
    name: 'subagent', label: 'Launch subagent',
    description: 'Start an Opus 5 worker in the background and return its sessionId immediately. Launch independent workers before calling wait_subagents. Workers share this scratch directory; assign non-overlapping files. Maximum three workers per task.',
    parameters: Type.Object({
      type: Type.Union([Type.Literal('implementation'), Type.Literal('tests'), Type.Literal('reviewer')]),
      task: Type.String(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (children.size >= 3 || [...children.values()].some(c => c.role === params.type)) {
        throw new Error('Each of implementation, tests, and reviewer can be launched once.');
      }
      const sessionId = randomUUID();
      const parentSessionId = ctx.sessionManager.getSessionId();
      const directory = join(ctx.cwd, 'children', params.type);
      mkdirSync(directory, {recursive: true});
      const extensions = (process.env.PI_SUBAGENT_EXTENSIONS ?? '').split(',').map(x => x.trim()).filter(Boolean);
      if (extensions.length === 0 || process.env.PI_TRACING !== '1') {
        throw new Error('Run this workflow with the tracing extension enabled.');
      }
      const args = ['--provider', 'anthropic', '--model', 'claude-opus-5', '--thinking', 'high',
        '--no-extensions', ...extensions.flatMap(path => ['-e', path]),
        '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
        '--tools', params.type === 'reviewer' ? 'read,bash' : 'read,bash,edit,write',
        '--session-id', sessionId, '--session-dir', join(directory, 'sessions'),
        '--name', params.type, '--mode', 'json', '-p',
        `${params.task}\nWork only in the current scratch directory. Keep your final report concise.`];
      const output = openSync(join(directory, 'events.jsonl'), 'w', 0o600);
      const error = openSync(join(directory, 'stderr.log'), 'w', 0o600);
      let proc: ChildProcess;
      try {
        proc = spawn('pi', args, {cwd: ctx.cwd, env: {...process.env,
          PI_SUBAGENT_TYPE: params.type, PI_TRACING_PARENT_SESSION_ID: parentSessionId,
          PI_TRACING_CAPTURE_CONTENTS: '0', PI_TRACING_CHILD_WAIT_MS: '0'},
          stdio: ['ignore', output, error]});
      } finally {
        closeSync(output);
        closeSync(error);
      }
      const child: Child = {sessionId, role: params.type, parentSessionId, directory,
        process: proc, done: Promise.resolve(-1), exited: false};
      child.done = new Promise(resolve => {
        proc.once('error', () => {child.exited = true; resolve(-1);});
        proc.once('close', code => {child.exited = true; resolve(code ?? -1);});
      });
      children.set(sessionId, child);
      writeFileSync(join(ctx.cwd, 'subagents.json'), JSON.stringify([...children.values()].map(c => ({
        sessionId: c.sessionId, role: c.role, parentSessionId: c.parentSessionId,
      })), null, 2) + '\n');
      return {content: [{type: 'text', text: `Started ${params.type} Pi session ${sessionId}. Use wait_subagents to collect its result.`}],
        details: {sessionId, role: params.type}};
    },
  });
  pi.registerTool({
    name: 'wait_subagents', label: 'Wait for subagents',
    description: 'Wait for the specified child sessions to finish and return their reports. This also waits for their traces to finalize.',
    parameters: Type.Object({sessionIds: Type.Array(Type.String(), {minItems: 1})}),
    async execute(_id, params, signal) {
      const selected = params.sessionIds.map(id => {
        const child = children.get(id);
        if (!child) throw new Error(`Unknown session ${id}`);
        return child;
      });
      const cancel = () => {for (const child of selected) if (!child.exited) child.process.kill('SIGINT');};
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) cancel();
      try {
        const results = await Promise.all(selected.map(async child => {
          const exitCode = await child.done;
          const events = readFileSync(join(child.directory, 'events.jsonl'), 'utf8').split('\n').flatMap(line => {
            try {return [JSON.parse(line)];} catch {return [];}
          });
          const message = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').at(-1)?.message;
          const report = message?.content?.filter((c: {type: string}) => c.type === 'text').map((c: {text: string}) => c.text).join('\n') ?? 'No assistant report.';
          return {sessionId: child.sessionId, role: child.role, exitCode,
            stopReason: message?.stopReason, report: report.slice(0, 8000)};
        }));
        return {content: [{type: 'text', text: JSON.stringify(results)}], details: {results}};
      } finally {signal?.removeEventListener('abort', cancel);}
    },
  });
  pi.on('session_shutdown', async () => {
    const active = [...children.values()].filter(c => !c.exited);
    for (const child of active) child.process.kill('SIGINT');
    const kill = setTimeout(() => {
      for (const child of active) if (!child.exited) child.process.kill('SIGKILL');
    }, 3000);
    try {await Promise.all(active.map(c => c.done));} finally {clearTimeout(kill);}
  });
}
