// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {resolve} from 'node:path';

test('packaged legacy hook sends authenticated observations and honors content opt-out', async () => {
  const observations: {authorization?: string; path?: string; body: any}[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observations.push({authorization: request.headers.authorization, path: request.url, body: JSON.parse(body)});
    response.writeHead(503).end(); // A rejected observation must not fail the harness hook.
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing hook receiver port');
    for (const contents of ['1', '0']) {
      const child = spawn('node', [resolve(import.meta.dir, 'legacy/hooks/capture.mjs')], {
        env: {...process.env, AGENTPROF_CAPTURE_ENDPOINT: `http://127.0.0.1:${address.port}`,
          AGENTPROF_CAPTURE_TOKEN: 'test-token', AGENTPROF_CAPTURE_CONTENTS: contents},
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => {stdout += chunk;});
      child.stderr.on('data', chunk => {stderr += chunk;});
      child.stdin.end(JSON.stringify({session_id: 'session', hook_event_name: 'PreToolUse',
        tool_name: 'Bash', prompt: 'Private prompt', tool_input: {command: 'echo private'}, unknown: 'ignored'}));
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject); child.once('exit', done);
      });
      expect(code, stderr).toBe(0);
      expect(stdout).toBe('');
      expect(observations.length).toBe(contents === '1' ? 1 : 2);
    }
    for (const observation of observations) {
      expect(observation.authorization).toBe('Bearer test-token');
      expect(observation.path).toBe('/hook');
      expect(observation.body.timestamp).toMatch(/^\d+$/);
      expect(observation.body.event).toMatchObject({session_id: 'session', hook_event_name: 'PreToolUse',
        tool_name: 'Bash', prompt_length: 14});
      expect(observation.body.event.unknown).toBeUndefined();
    }
    expect(observations[0]!.body.event).toMatchObject({prompt: 'Private prompt', tool_input: {command: 'echo private'}});
    expect(observations[1]!.body.event.prompt).toBeUndefined();
    expect(observations[1]!.body.event.tool_input).toBeUndefined();
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});
