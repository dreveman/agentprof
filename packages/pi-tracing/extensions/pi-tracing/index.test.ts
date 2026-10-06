import {decodeFields, tracePackets} from "./test-proto.ts";
import {childPromptFlowId} from "./workflow.ts";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Pi exit publishes the trace and reports its path without contaminating JSON stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tracing-exit-"));
  try {
    await writeFile(join(dir, 'pi-tracing.json'), '{"finalizeDeadlineMs":5000}\n');
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
    const renameExtension = join(dir, 'rename.ts');
    await writeFile(renameExtension, 'export default function () { process.title = "pi-name-test"; }\n');
    const result = spawnSync("node", [cli, "--no-extensions", "-e", renameExtension, "-e", extension,
      "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
      "--no-session", "--tracing", "--mode", "json", "-p", "/tracing status"], {
      cwd: dir, encoding: "utf8", timeout: 15000,
      env: {...process.env, PI_CODING_AGENT_DIR: dir, PI_TRACING: "0", PI_SUBAGENT_EXTENSIONS: ""},
    });
    expect(result.status, result.stderr).toBe(0);
    const files = await readdir(join(dir, "pi-tracing"));
    const traces = files.filter(name => name.endsWith(".pftrace"));
    expect(traces, result.stderr).toHaveLength(1);
    expect(files.some(name => name.endsWith(".part"))).toBe(false);
    const path = join(dir, "pi-tracing", traces[0]!);
    expect(result.stderr).toContain(`pi-tracing: finalized ${path} (`);
    expect(result.stderr.match(/pi-tracing: finalized /g)).toHaveLength(1);
    expect(result.stdout).not.toContain("pi-tracing:");
    for (const line of result.stdout.trim().split("\n").filter(Boolean)) JSON.parse(line);
    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from("pi-tracing/"))).toBe(false);
    expect(bytes.includes(Buffer.from("session:"))).toBe(true);
    expect(bytes.includes(Buffer.from("recorder_version"))).toBe(true);
    if (process.platform === 'linux') {
      // Both display names use the same constant, independent of OS naming.
      expect(bytes.includes(Buffer.from('pi-name-test'))).toBe(false);
      const processor = process.env.PERFETTO_TRACE_PROCESSOR;
      if (processor) {
        const imported = spawnSync(processor, [path, '-Q', `SELECT COUNT(*) AS matched
          FROM thread t JOIN process p USING (upid)
          WHERE t.tid = p.pid AND t.name = 'pi' AND p.name = 'pi'`], {encoding: 'utf8'});
        expect(imported.status, imported.stderr).toBe(0);
        expect(imported.stdout.trim()).toBe('"matched"\n1');
      }
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}, 20000);

test('agent tracing tools publish default and requested paths and report state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tracing-tools-'));
  try {
    await writeFile(join(dir, 'pi-tracing.json'), '{"finalizeDeadlineMs":5000}\n');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
    const extension = fileURLToPath(new URL('./index.ts', import.meta.url));
    const driver = join(dir, 'driver.ts');
    await writeFile(driver, `
      import tracing from ${JSON.stringify(extension)};
      import {writeFileSync} from 'node:fs';
      export default function(pi) {
        const tools = new Map();
        const hooks = new Map();
        tracing(new Proxy(pi, {get(target, key) {
          if (key === 'registerTool') return tool => {tools.set(tool.name, tool); pi.registerTool(tool);};
          if (key === 'on') return (name, handler) => {
            hooks.set(name, [...(hooks.get(name) ?? []), handler]); pi.on(name, handler);
          };
          return Reflect.get(target, key);
        }}));
        pi.registerCommand('trace-tools-test', {handler: async (_raw, ctx) => {
          const start = tools.get('tracing_start'); const stop = tools.get('tracing_stop');
          const run = (tool, id, args) => tool.execute(id, args, undefined, undefined, ctx);
          const first = await run(start, 'start-1', {name: 'default'});
          const duplicate = await run(start, 'start-2', {});
          const firstStop = await run(stop, 'stop-1', {});
          const secondStop = await run(stop, 'stop-2', {});
          const custom = await run(start, 'start-3', {name: 'custom', output_path: 'results/custom.pftrace'});
          for (const name of ['tool_execution_start', 'tool_call']) {
            for (const handler of hooks.get(name) ?? []) await handler({toolCallId: 'stop-3', toolName: 'tracing_stop', input: {}}, ctx);
          }
          const customStop = await run(stop, 'stop-3', {});
          for (const name of ['tool_execution_end', 'tool_result']) {
            for (const handler of hooks.get(name) ?? []) await handler({toolCallId: 'stop-3', toolName: 'tracing_stop', isError: false}, ctx);
          }
          const collision = await run(start, 'start-4', {output_path: 'results/custom.pftrace'});
          const invalid = await run(start, 'start-5', {output_path: 'results/bad.txt'});
          writeFileSync(${JSON.stringify(join(dir, 'tools.json'))}, JSON.stringify({
            first, duplicate, firstStop, secondStop, custom, customStop, collision, invalid,
          }));
        }});
      }
    `);
    const result = spawnSync('node', [cli, '--no-extensions', '-e', driver, '--no-skills',
      '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session',
      '--mode', 'json', '-p', '/trace-tools-test'], {cwd: dir, encoding: 'utf8', timeout: 20000,
      env: {...process.env, PI_CODING_AGENT_DIR: dir, PI_TRACING: '0', PI_SUBAGENT_EXTENSIONS: ''}});
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(await readFile(join(dir, 'tools.json'), 'utf8'));
    const defaultPath = output.first.details.path as string;
    const customPath = join(dir, 'results', 'custom.pftrace');
    expect(defaultPath.startsWith(join(dir, 'pi-tracing'))).toBe(true);
    expect(output.firstStop.details.path).toBe(defaultPath);
    expect(output.firstStop.details.published).toBe(true);
    expect(output.custom.details.path).toBe(customPath);
    expect(output.customStop.details.path).toBe(customPath);
    expect(output.duplicate.isError).toBe(true);
    expect(output.secondStop.isError).toBe(true);
    expect(output.collision.isError).toBe(true);
    expect(output.invalid.isError).toBe(true);
    expect((await readFile(defaultPath)).length).toBeGreaterThan(0);
    expect((await readFile(customPath)).length).toBeGreaterThan(0);
    if (processor) {
      const imported = spawnSync(processor, [customPath, '-Q', `SELECT COUNT(*) AS unexpected
        FROM slice WHERE name IN ('tracing_start', 'tracing_stop', 'tool-preflight', 'tool-result', 'tool-middleware')`],
      {encoding: 'utf8'});
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout.trim()).toBe('"unexpected"\n0');
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}, 25000);

const processor = process.env.PERFETTO_TRACE_PROCESSOR;
const hookTest = processor ? test : test.skip;
hookTest('codemode hooks link parallel children, preserve errors, and record model-call lifecycle once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tracing-codemode-'));
  try {
    await writeFile(join(dir, 'pi-tracing.json'), '{"finalizeDeadlineMs":5000}\n');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
    const extension = fileURLToPath(new URL('./index.ts', import.meta.url));
    const driver = join(dir, 'driver.ts');
    await writeFile(driver, `
      import tracing from ${JSON.stringify(extension)};
      export default function(pi) {
        const hooks = new Map();
        tracing(new Proxy(pi, {get(target, key) {
          if (key === 'getActiveTools') return () => ['codemode', 'read'];
          if (key === 'on') return (name, handler) => {
            hooks.set(name, [...(hooks.get(name) ?? []), handler]); pi.on(name, handler);
          };
          return Reflect.get(target, key);
        }}));
        pi.registerCommand('codemode-test', {handler: async (_, ctx) => {
          const emit = async (type, data) => {
            for (const hook of hooks.get(type) ?? []) await hook({type, ...data}, ctx);
          };
          const script = {toolName: 'codemode', toolCallId: 'script', args: {code: 'fixture'}};
          const start = async tool => {
            await emit('tool_execution_start', tool);
            await emit('tool_call', {...tool, input: tool.args});
          };
          await start(script);
          const children = Array.from({length: 12}, (_, n) => ({
            toolName: 'read', toolCallId: 'script/' + n, parentToolCallId: 'script', args: {path: 'file-' + n},
          }));
          for (const child of children) await start(child);
          const modelCall = {id: 'script/models.classify/1', name: 'models.classify',
            args: 'fixture/classifier', status: 'running'};
          const snapshot = async calls => emit('tool_execution_update', {...script,
            partialResult: {content: [], details: {calls}}});
          await snapshot([modelCall]); await snapshot([modelCall]);
          for (const [n, child] of children.entries()) {
            await emit('tool_result', {...child, isError: n === 0,
              ...(n === 1 ? {usage: {input: 5, output: 2}} : {})});
            await emit('tool_execution_end', {...child, isError: n === 0});
          }
          await snapshot([{...modelCall, status: 'ok', durationMs: 1}]);
          await snapshot([{...modelCall, status: 'ok', durationMs: 1}]);
          await emit('tool_result', {...script, isError: false, usage: {input: 10, output: 3}});
          await emit('tool_execution_end', {...script, isError: false,
            result: {details: {calls: [{...modelCall, status: 'ok', durationMs: 1}]}}});
          const interrupted = {...script, toolCallId: 'interrupted'};
          await start(interrupted);
          await emit('tool_execution_update', {...interrupted, partialResult: {details: {
            calls: [{...modelCall, id: 'interrupted/models.classify/1'}]}}});
          await emit('tool_execution_end', {...interrupted, isError: true});
        }});
      }
    `);
    const result = spawnSync('node', [cli, '--no-extensions', '-e', driver, '--no-skills',
      '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session',
      '--tracing', '--mode', 'json', '-p', '/codemode-test'], {cwd: dir, encoding: 'utf8', timeout: 20000,
      env: {...process.env, PI_CODING_AGENT_DIR: dir, PI_TRACING: '0', PI_SUBAGENT_EXTENSIONS: '',
        PI_TRACING_CAPTURE_CONTENTS: '0'}});
    expect(result.status, result.stderr).toBe(0);
    const files = (await readdir(join(dir, 'pi-tracing'))).filter(name => name.endsWith('.pftrace'));
    expect(files, result.stderr).toHaveLength(1);
    const trace = join(dir, 'pi-tracing', files[0]!);
    const imported = spawnSync(processor!, [trace, '-Q', `
      WITH calls AS (SELECT *, EXTRACT_ARG(arg_set_id, 'debug.call_id') AS call_id,
        EXTRACT_ARG(arg_set_id, 'debug.parent_call_id') AS parent_call_id FROM slice),
      samples AS (SELECT t.name, c.value FROM counter c JOIN counter_track t ON c.track_id = t.id)
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM calls WHERE name = 'read' AND parent_call_id = 'script' AND dur > 0) = 12
        AND (SELECT COUNT(*) FROM calls WHERE name = 'codemode'
          AND EXTRACT_ARG(arg_set_id, 'debug.language') = 'JavaScript'
          AND EXTRACT_ARG(arg_set_id, 'debug.line_count') = 1) = 2
        AND NOT EXISTS (SELECT 1 FROM args WHERE key GLOB 'debug.args.*')
        AND (SELECT COUNT(*) FROM calls WHERE name = 'read' AND EXTRACT_ARG(arg_set_id, 'debug.is_error') = 1) = 1
        AND (SELECT COUNT(*) FROM calls WHERE name = 'models.classify' AND parent_call_id = 'script') = 1
        AND (SELECT COUNT(*) FROM calls WHERE name = 'models.classify' AND parent_call_id = 'interrupted'
          AND EXTRACT_ARG(arg_set_id, 'debug.incomplete') = 1) = 1
        AND (SELECT COUNT(*) FROM flow f JOIN calls a ON a.id = f.slice_out JOIN calls b ON b.id = f.slice_in
          WHERE a.call_id = 'script' AND b.name = 'tool-preflight' AND b.parent_call_id = 'script') = 12
        AND (SELECT COUNT(*) FROM flow f JOIN calls a ON a.id = f.slice_out JOIN calls b ON b.id = f.slice_in
          WHERE a.name = 'tool-preflight' AND b.name = 'read' AND b.parent_call_id = 'script') = 12
        AND (SELECT COUNT(*) FROM flow f JOIN calls a ON a.id = f.slice_out JOIN calls b ON b.id = f.slice_in
          WHERE a.call_id = 'script' AND b.name = 'models.classify') = 1
        AND (SELECT MAX(value) FROM samples WHERE name = 'Input tokens') = 15
        AND (SELECT MAX(value) FROM samples WHERE name = 'Output tokens') = 5
        AND (SELECT MAX(value) FROM samples WHERE name = 'Lane overflows') = 0
        AND EXISTS (SELECT 1 FROM slice WHERE name = 'profile (1)'
          AND EXTRACT_ARG(arg_set_id, 'debug.session_labels[0]') = 'codemode')
        AND NOT EXISTS (SELECT 1 FROM stats WHERE severity = 'error' AND value > 0)
      THEN 'CODEMODE_OK' ELSE 'FAILED' END AS result`], {encoding: 'utf8'});
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout.trim()).toBe('"result"\n"CODEMODE_OK"');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}, 25000);

hookTest('Pi hooks consolidate metadata, retain unknown-start completions, and preserve capture boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tracing-hooks-'));
  try {
    await writeFile(join(dir, 'pi-tracing.json'), '{"finalizeDeadlineMs":5000}\n');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
    const extension = fileURLToPath(new URL('./index.ts', import.meta.url));
    const driver = join(dir, 'driver.ts');
    // Exercise the real extension with Pi's actual context and lifecycle, without
    // model calls. Only the model/tool hook inputs below are deterministic fixtures.
    await writeFile(driver, `
      import tracing from ${JSON.stringify(extension)};
      export default function(pi) {
        const hooks = new Map(); const commands = new Map(); const bus = new Map();
        tracing(new Proxy(pi, {get(target, key) {
          if (key === 'events') return {on: (name, handler) => bus.set(name, handler)};
          if (key === 'on') return (name, handler) => {
            hooks.set(name, [...(hooks.get(name) ?? []), handler]);
            return pi.on(name, handler);
          };
          if (key === 'registerCommand') return (name, command) => {
            commands.set(name, command); return pi.registerCommand(name, command);
          };
          return target[key];
        }}));
        pi.registerCommand('trace-test', {handler: async (_, ctx) => {
          const emit = async (type, data = {}, hookCtx = ctx) => {
            for (const hook of hooks.get(type) ?? []) await hook({type, ...data}, hookCtx);
          };
          const message = {id: 'response', role: 'assistant', provider: 'fixture', model: 'fixture-model',
            stopReason: 'toolUse', usage: {input: 100, output: 9}};
          await emit('input', {text: 'hello 🌍', source: 'interactive'});
          await emit('before_agent_start', {prompt: 'hello'});
          await emit('agent_start'); await emit('turn_start', {turnIndex: 0});
          await emit('context', {messages: [{}, {}, {}]});
          await emit('message_start', {message});
          await emit('before_provider_request');
          await emit('after_provider_response', {status: 200});
          await emit('message_update', {message, assistantMessageEvent: {delta: 'abc'}});
          await emit('message_end', {message});
          const tool = {toolCallId: 'tool-1', toolName: 'read', args: {path: 'fixture'}};
          await emit('tool_execution_start', tool);
          await emit('tool_call', {...tool, input: tool.args});
          await emit('tool_execution_update', {...tool, partialResult: {content: [{text: 'abc'}]}});
          await emit('tool_result', {...tool, isError: true});
          await emit('tool_execution_end', {...tool, isError: false});
          for (const mode of ['both', 'workflow-only']) {
            if (mode === 'workflow-only') await commands.get('tracing').handler('categories tools off', ctx);
            const a = {toolCallId: mode + '-child-a', toolName: 'subagent', args: {type: 'fixture', task: 'work'}};
            const b = {toolCallId: mode + '-child-b', toolName: 'rig_launch', args: {task_id: 'task-b'}};
            await emit('tool_execution_start', a); await emit('tool_execution_start', b);
            // Reverse completion order exercises per-call child correlation.
            await emit('tool_execution_end', {...b, isError: false,
              result: {content: [{text: '33333333-3333-4333-8333-333333333333'}]}});
            await emit('tool_execution_end', {...a, isError: false,
              result: {content: [{text: '22222222-2222-4222-8222-222222222222'}]}});
          }
          await commands.get('tracing').handler('categories tools on', ctx);
          for (const [name, args] of [['bash', {command: 'printf ' + 'x'.repeat(6000)}],
            ['edit', {path: 'file.ts', oldText: 'before', newText: 'after'}]]) {
            const call = {toolCallId: name + '-details', toolName: name, args};
            await emit('tool_execution_start', call); await emit('tool_call', {...call, input: args});
            await emit('tool_execution_end', {...call, isError: false});
          }
          await commands.get('tracing').handler('categories contents off', ctx);
          const hidden = {toolCallId: 'hidden-details', toolName: 'bash', args: {command: 'PRIVATE_COMMAND'}};
          await emit('tool_execution_start', hidden); await emit('tool_call', {...hidden, input: hidden.args});
          await emit('tool_execution_end', {...hidden, isError: false});
          await commands.get('tracing').handler('categories contents on', ctx);
          await emit('tool_call', {toolCallId: 'typed', toolName: 'typed-tool',
            input: {count: -2, ratio: 1.25, enabled: false, labels: ['a', 'b']}});
          await emit('user_bash', {command: 'echo hello'});
          bus.get('workflow-rig:worker-launched')({taskId: 'task-a', sessionId: 'child-a', attempt: 2, outcome: 'ok'});
          bus.get('workflow-rig:run-started')({rootId: 'root-a', workflowName: 'fixture'});
          bus.get('workflow-rig:run-terminal')({rootId: 'root-a', outcome: 'ok'});
          bus.get('workflow-rig:reconcile')({rootId: 'root-a', outcome: 'idle', actionCount: 3, durationMs: 0.125});
          bus.get('workflow-rig:spawn-confirm')({taskId: 'task-a', granted: false});
          bus.get('workflow-rig:run-terminal')({rootId: 'unrecorded', outcome: 'failed'});
          await emit('model_select', {model: {id: 'fixture-model', provider: 'fixture', contextWindow: 200000}});
          await emit('thinking_level_select', {level: 'low'});
          await emit('turn_end'); await emit('agent_end'); await emit('agent_settled');
          const unknownContext = new Proxy(ctx, {get(target, key) {
            if (key === 'getContextUsage') return () => ({tokens: null, contextWindow: 200000, percent: null});
            return Reflect.get(target, key);
          }});
          await emit('session_before_compact', {preparation: {tokensBefore: 250},
            reason: 'threshold', willRetry: false});
          await emit('session_compact', {compactionEntry: {tokensBefore: 260,
            usage: {input: 7, output: 3}}, fromExtension: false,
            reason: 'threshold', willRetry: false}, unknownContext);
          await emit('session_before_compact', {preparation: {tokensBefore: 120},
            reason: 'manual', willRetry: false});
          await emit('session_compact_failed', {reason: 'manual', aborted: true,
            willRetry: false, fromExtension: false});
          // An operation without new input must not reuse the previous flow.
          await commands.get('tracing').handler('categories prompt-data off', ctx);
          await emit('before_agent_start', {prompt: 'length only'});
          await emit('agent_start'); await emit('agent_end'); await emit('agent_settled');
          await emit('input', {text: 'not started', source: 'extension'});
          await commands.get('tracing').handler('stop', ctx);
          await commands.get('tracing').handler('start second', ctx);
          // Capture boundaries must clear pending input linkage.
          await emit('agent_start'); await emit('agent_end'); await emit('agent_settled');
          await emit('input', {text: 'later input', source: 'extension'});
          // No starts in this capture: completions stay instants with unknown duration.
          await emit('message_end', {message: {...message, usage: {input: 7, output: 2}}});
          await emit('after_provider_response', {status: 503});
          await emit('tool_execution_end', {...tool, isError: true});
          await emit('tool_result', {...tool, isError: true});
          // A started response with no completion is visibly incomplete.
          await emit('message_start', {message: {...message, id: 'interrupted'}});
          await emit('message_update', {message: {...message, id: 'interrupted'}, assistantMessageEvent: {delta: 'abc'}});
          // Let real Pi shutdown close this response with its partial metadata.
        }});
      }
    `);
    const result = spawnSync('node', [cli, '--no-extensions', '-e', driver, '--no-skills',
      '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session',
      '--tracing', '--mode', 'json', '-p', '/trace-test'], {
      cwd: dir, encoding: 'utf8', timeout: 15000,
      env: {...process.env, PI_CODING_AGENT_DIR: dir, PI_TRACING: '0', PI_SUBAGENT_EXTENSIONS: '',
        PI_SUBAGENT_TYPE: 'test-child', WORKFLOW_RIG_PROCESS: '', PI_TRACING_CAPTURE_CONTENTS: undefined,
        DEVMATE_PARENT_SESSION_ID: '11111111-1111-4111-8111-111111111111'},
    });
    expect(result.status, result.stderr).toBe(0);
    const traces = (await readdir(join(dir, 'pi-tracing'))).filter(name => name.endsWith('.pftrace')).sort();
    expect(traces).toHaveLength(2);
    const events = (await Promise.all(traces.map(file => readFile(join(dir, 'pi-tracing', file)))))
      .flatMap(bytes => tracePackets(bytes).flatMap(packet => {
        const event = decodeFields(packet).find(f => f.number === 11)?.bytes;
        return event ? [decodeFields(event)] : [];
      }));
    const text = (fields: ReturnType<typeof decodeFields>, number: number) =>
      new TextDecoder().decode(fields.find(f => f.number === number)?.bytes);
    const capture = events.find(e => text(e, 23) === 'profile (1)')!;
    const session = capture.filter(f => f.number === 4).map(f => decodeFields(f.bytes!))
      .find(a => text(a, 10) === 'session_id')!;
    const childId = childPromptFlowId(text(session, 6))!;
    expect(events.filter(e => e.some(f => f.number === 47 && f.value === childId))).toHaveLength(1);
    const firstInput = events.find(e => text(e, 23) === 'prompt-input')!;
    expect(firstInput.filter(f => f.number === 47).map(f => f.value)).toContain(childId);
    // Repeated calls returning the same child session must not relink its first prompt.
    for (const id of ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']) {
      const endpoints = events.filter(e => e.some(f => f.number === 47 && f.value === childPromptFlowId(id)));
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]!.find(f => f.number === 9)?.value).toBe(1n);
    }
    const query = (file: string, sql: string) => {
      const imported = spawnSync(processor!, [join(dir, 'pi-tracing', file), '-Q', sql], {encoding: 'utf8'});
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout).toContain('HOOKS_OK');
    };
    const common = `NOT EXISTS (SELECT 1 FROM args WHERE key GLOB 'debug.*[A-Z]*'
      AND key NOT GLOB 'debug.args.*') AND (SELECT COUNT(*) FROM slice WHERE name = 'profile (1)'
      AND EXTRACT_ARG(arg_set_id, 'debug.parent_session') = '11111111-1111-4111-8111-111111111111'
      AND EXTRACT_ARG(arg_set_id, 'debug.subagent_type') = 'test-child') = 1`;
    query(traces[0]!, `SELECT CASE WHEN ${common} AND
      (SELECT COUNT(*) FROM slice WHERE name = 'compact'
        AND EXTRACT_ARG(arg_set_id, 'debug.context.stage') = 'post-compaction'
        AND EXTRACT_ARG(arg_set_id, 'debug.context.sample_offset_ns') = dur) = 1 AND
      (SELECT MAX(EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens'))
        FROM slice WHERE name IN ('profile (1)', 'run-configuration')) = 200000 AND
      (SELECT EXTRACT_ARG(arg_set_id, 'debug.peak_context_tokens')
        FROM slice WHERE name = 'profile (1)') = 260 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'compact' AND dur > 0
        AND EXTRACT_ARG(arg_set_id, 'debug.status') = 'success'
        AND EXTRACT_ARG(arg_set_id, 'debug.tokens_before') = 250
        AND EXTRACT_ARG(arg_set_id, 'debug.tokens_before_final') = 260
        AND EXTRACT_ARG(arg_set_id, 'debug.input_tokens') = 7) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'compact' AND dur > 0
        AND EXTRACT_ARG(arg_set_id, 'debug.status') = 'aborted') = 1 AND
      (SELECT MAX(c.value) FROM counter c JOIN counter_track t ON t.id = c.track_id
        WHERE t.name = 'Input tokens') = 107 AND
      (SELECT MAX(c.value) FROM counter c JOIN counter_track t ON t.id = c.track_id
        WHERE t.name = 'Output tokens') = 12 AND
      (SELECT COUNT(*) FROM counter c JOIN counter_track t ON t.id = c.track_id
        WHERE t.name = 'Context size' AND c.value = 0 AND c.ts =
          (SELECT ts + dur FROM slice WHERE name = 'compact'
            AND EXTRACT_ARG(arg_set_id, 'debug.status') = 'success')) = 1 AND
      NOT EXISTS (SELECT 1 FROM slice WHERE name GLOB 'child-start*' OR name GLOB 'result *'
        OR name GLOB 'middleware *' OR name GLOB 'prompt (*' OR name GLOB 'context messages=*'
        OR name GLOB 'provider-response*' OR name GLOB 'model=*' OR name GLOB 'thinking=*') AND
      (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id = f.slice_out
        JOIN slice dst ON dst.id = f.slice_in
        WHERE src.name = 'prompt-input' AND dst.name = 'prompt'
          AND EXTRACT_ARG(src.arg_set_id, 'debug.source') = 'interactive'
          AND EXTRACT_ARG(src.arg_set_id, 'debug.length') IS NULL
          AND EXTRACT_ARG(dst.arg_set_id, 'debug.length') = 5
          AND EXTRACT_ARG(dst.arg_set_id, 'debug.text') = 'hello'
          AND dst.category = 'pi.agent,pi.prompt-data') = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'prompt'
        AND EXTRACT_ARG(arg_set_id, 'debug.length') = 11
        AND EXTRACT_ARG(arg_set_id, 'debug.text') IS NULL
        AND category = 'pi.agent') = 1 AND
      (SELECT COUNT(*) FROM flow f JOIN slice s ON s.id = f.slice_in WHERE s.name = 'prompt') = 1 AND
      NOT EXISTS (SELECT 1 FROM slice WHERE name GLOB 'input src=*') AND
      (SELECT COUNT(*) FROM slice s JOIN track t ON t.id = s.track_id WHERE s.name = 'response'
        AND t.name = 'Responses' AND s.dur > 0
        AND EXTRACT_ARG(s.arg_set_id, 'debug.input_tokens') = 100
        AND EXTRACT_ARG(s.arg_set_id, 'debug.updates') = 1
        AND EXTRACT_ARG(s.arg_set_id, 'debug.bytes') = 3) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'request'
        AND EXTRACT_ARG(arg_set_id, 'debug.context_messages') = 3
        AND EXTRACT_ARG(arg_set_id, 'debug.status_code') = 200) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'read'
        AND EXTRACT_ARG(arg_set_id, 'debug.is_error') = 0
        AND EXTRACT_ARG(arg_set_id, 'debug.middleware_is_error') = 1
        AND EXTRACT_ARG(arg_set_id, 'debug.updates') = 1
        AND EXTRACT_ARG(arg_set_id, 'debug.bytes') = 3) = 1 AND
      NOT EXISTS (SELECT 1 FROM slice WHERE dur < 0)
      THEN 'HOOKS_OK' ELSE 'HOOKS_FAILED' END`);
    query(traces[0]!, `SELECT CASE WHEN
      (SELECT length(EXTRACT_ARG(arg_set_id, 'debug.args.command')) FROM slice
        WHERE name = 'bash' AND EXTRACT_ARG(arg_set_id, 'debug.call_id') = 'bash-details') = 6007 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'edit'
        AND EXTRACT_ARG(arg_set_id, 'debug.args.path') = 'file.ts'
        AND EXTRACT_ARG(arg_set_id, 'debug.args.oldText') = 'before'
        AND EXTRACT_ARG(arg_set_id, 'debug.args.newText') = 'after') = 1 AND
      NOT EXISTS (SELECT 1 FROM args WHERE display_value LIKE '%PRIVATE_COMMAND%') AND
      (SELECT COUNT(*) FROM slice WHERE name = 'tool-preflight'
        AND EXTRACT_ARG(arg_set_id, 'debug.args.command') IS NOT NULL) = 0 AND
      (SELECT EXTRACT_ARG(arg_set_id, 'debug.args.path') FROM slice WHERE name = 'read') = 'fixture' AND
      (SELECT COUNT(*) FROM slice WHERE name = 'tool-preflight'
        AND EXTRACT_ARG(arg_set_id, 'debug.name') = 'read'
        AND EXTRACT_ARG(arg_set_id, 'debug.bytes') = 18
        AND EXTRACT_ARG(arg_set_id, 'debug.keys[0]') = 'path'
        AND EXTRACT_ARG(arg_set_id, 'debug.args.path') IS NULL) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'tool-preflight'
        AND EXTRACT_ARG(arg_set_id, 'debug.name') = 'typed-tool'
        AND EXTRACT_ARG(arg_set_id, 'debug.args.count') = -2
        AND EXTRACT_ARG(arg_set_id, 'debug.args.ratio') = 1.25
        AND EXTRACT_ARG(arg_set_id, 'debug.args.enabled') = 0
        AND EXTRACT_ARG(arg_set_id, 'debug.args.labels[1]') = 'b') = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'user_bash'
        AND EXTRACT_ARG(arg_set_id, 'debug.executable') = 'echo'
        AND EXTRACT_ARG(arg_set_id, 'debug.length') = 10) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'launch'
        AND EXTRACT_ARG(arg_set_id, 'debug.task_id') = 'task-a'
        AND EXTRACT_ARG(arg_set_id, 'debug.attempt') = 2) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'run'
        AND EXTRACT_ARG(arg_set_id, 'debug.root_id') = 'root-a'
        AND EXTRACT_ARG(arg_set_id, 'debug.outcome') = 'ok') = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'reconcile'
        AND EXTRACT_ARG(arg_set_id, 'debug.root_id') = 'root-a'
        AND EXTRACT_ARG(arg_set_id, 'debug.duration_ms') = 0.125
        AND EXTRACT_ARG(arg_set_id, 'debug.action_count') = 3) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'spawn-confirmation'
        AND EXTRACT_ARG(arg_set_id, 'debug.task_id') = 'task-a'
        AND EXTRACT_ARG(arg_set_id, 'debug.granted') = 0) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'run-terminal'
        AND EXTRACT_ARG(arg_set_id, 'debug.root_id') = 'unrecorded') = 1
      THEN 'HOOKS_OK' ELSE 'HOOKS_FAILED' END`);
    query(traces[0]!, `SELECT CASE WHEN
      (SELECT COUNT(*) FROM slice s JOIN track t ON t.id = s.track_id
        WHERE EXTRACT_ARG(s.arg_set_id, 'debug.delegation') = 1
          AND t.name = 'Tools' AND s.dur > 0
          AND EXTRACT_ARG(s.arg_set_id, 'debug.is_error') = 0
          AND EXTRACT_ARG(s.arg_set_id, 'debug.child_session') = CASE
            WHEN EXTRACT_ARG(s.arg_set_id, 'debug.call_id') GLOB '*child-a'
            THEN '22222222-2222-4222-8222-222222222222'
            ELSE '33333333-3333-4333-8333-333333333333' END) = 4 AND
      (SELECT COUNT(*) FROM slice WHERE EXTRACT_ARG(arg_set_id, 'debug.delegation') = 1
        AND category = 'pi.workflow') = 2 AND
      NOT EXISTS (SELECT 1 FROM slice s JOIN track t ON t.id = s.track_id
        WHERE s.name = 'delegate' OR t.name GLOB 'workflow.child.*')
      THEN 'HOOKS_OK' ELSE 'HOOKS_FAILED' END`);
    query(traces[1]!, `SELECT CASE WHEN ${common} AND
      NOT EXISTS (SELECT 1 FROM flow f JOIN slice s ON s.id = f.slice_in WHERE s.name = 'prompt') AND
      (SELECT COUNT(*) FROM slice WHERE dur = 0 AND EXTRACT_ARG(arg_set_id, 'debug.start_not_recorded') = 1) = 4 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'tool-middleware'
        AND EXTRACT_ARG(arg_set_id, 'debug.is_error') = 1
        AND EXTRACT_ARG(arg_set_id, 'debug.middleware_is_error') IS NULL) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'response'
        AND EXTRACT_ARG(arg_set_id, 'debug.duration_ns') IS NULL
        AND EXTRACT_ARG(arg_set_id, 'debug.first_content_ns') IS NULL
        AND EXTRACT_ARG(arg_set_id, 'debug.input_tokens') = 7) = 1 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'response'
        AND EXTRACT_ARG(arg_set_id, 'debug.incomplete') = 1 AND dur > 0
        AND EXTRACT_ARG(arg_set_id, 'debug.updates') = 1
        AND EXTRACT_ARG(arg_set_id, 'debug.bytes') = 3
        AND EXTRACT_ARG(arg_set_id, 'debug.first_content_ns') IS NOT NULL
        AND EXTRACT_ARG(arg_set_id, 'debug.input_tokens') IS NULL) = 1
      THEN 'HOOKS_OK' ELSE 'HOOKS_FAILED' END`);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}, 20000);

hookTest('real Pi processes inherit one recording through parallel children and a grandchild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tracing-family-'));
  try {
    await writeFile(join(dir, 'pi-tracing.json'), '{"finalizeDeadlineMs":5000}\n');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
    const extension = fileURLToPath(new URL('./index.ts', import.meta.url));
    const driver = join(dir, 'family.ts');
    await writeFile(driver, `
      import tracing from ${JSON.stringify(extension)};
      import {spawn} from 'node:child_process';
      import {readFile, writeFile} from 'node:fs/promises';
      import {join} from 'node:path';
      export default function(pi) {
        const hooks = new Map();
        tracing(new Proxy(pi, {get(target, key) {
          if (key === 'on') return (name, handler) => {
            hooks.set(name, [...(hooks.get(name) ?? []), handler]); return pi.on(name, handler);
          };
          return target[key];
        }}));
        pi.registerCommand('family', {handler: async (_, ctx) => {
          const role = process.env.FAMILY_ROLE ?? 'root';
          const emit = async (type, data = {}) => {
            for (const hook of hooks.get(type) ?? []) await hook({type, ...data}, ctx);
          };
          await emit('input', {text: role, source: 'interactive'});
          await emit('before_agent_start', {prompt: role}); await emit('agent_start');
          async function launch(name) {
            const tool = {toolCallId: name, toolName: 'subagent', args: {type: name, task: name}};
            await emit('tool_execution_start', tool); await emit('tool_call', {...tool, input: tool.args});
            const child = spawn(process.execPath, [${JSON.stringify(cli)}, '--no-extensions', '-e', ${JSON.stringify(driver)},
              '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session',
              '--mode', 'json', '-p', '/family'], {
              cwd: ctx.cwd, env: {...process.env, FAMILY_ROLE: name, PI_SUBAGENT_TYPE: name,
                DEVMATE_PARENT_SESSION_ID: ctx.sessionManager.getSessionId()}, stdio: ['ignore', 'ignore', 'pipe']});
            let stderr = ''; child.stderr.on('data', data => stderr += data);
            await new Promise((resolve, reject) => {
              child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
            });
            const sessionId = (await readFile(join(ctx.cwd, name + '.session'), 'utf8')).trim();
            await emit('tool_execution_end', {...tool, isError: false, result: {content: [{text: sessionId}]}});
          }
          if (role === 'root') await Promise.all([launch('branch'), launch('leaf')]);
          if (role === 'branch') await launch('grandchild');
          await emit('agent_end'); await emit('agent_settled');
          await writeFile(join(ctx.cwd, role + '.session'), ctx.sessionManager.getSessionId());
        }});
      }
    `);
    const env: NodeJS.ProcessEnv = {...process.env, PI_CODING_AGENT_DIR: dir, PI_TRACING: '1', PI_SUBAGENT_EXTENSIONS: '',
      FAMILY_ROLE: 'root', WORKFLOW_RIG_PROCESS: '', PI_SUBAGENT_TYPE: ''};
    delete env.PI_TRACING_RECORDING_DIR;
    const result = spawnSync('node', [cli, '--no-extensions', '-e', driver, '--no-skills',
      '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session',
      '--mode', 'json', '-p', '/family'], {cwd: dir, encoding: 'utf8', timeout: 25000, env});
    expect(result.status, result.stderr).toBe(0);
    const files = (await readdir(join(dir, 'pi-tracing'))).filter(f => f.endsWith('.pftrace'));
    expect(files).toHaveLength(1);
    const path = join(dir, 'pi-tracing', files[0]!);
    expect(result.stderr).toContain(`finalized ${path}`);
    const imported = spawnSync(processor!, [path, '-Q', `SELECT CASE WHEN
      (SELECT COUNT(*) FROM slice WHERE name='profile (1)')=4 AND
      (SELECT COUNT(*) FROM process WHERE name='pi')=4 AND
      (SELECT COUNT(*) FROM slice WHERE name='subagent')=3 AND
      (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id=f.slice_out JOIN slice dst ON dst.id=f.slice_in
        WHERE src.name='subagent' AND dst.name='prompt-input')=3 AND
      (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id=f.slice_out JOIN slice dst ON dst.id=f.slice_in
        WHERE src.name='tool-preflight' AND dst.name='subagent')=3 AND
      (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id=f.slice_out JOIN slice dst ON dst.id=f.slice_in
        WHERE src.name='prompt-input' AND dst.name='prompt')=4 AND
      NOT EXISTS (SELECT 1 FROM slice WHERE dur<0) AND
      NOT EXISTS (SELECT 1 FROM stats WHERE severity='error' AND value>0)
      THEN 'FAMILY_OK' ELSE 'FAILED' END AS result`], {encoding: 'utf8'});
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('FAMILY_OK');
    const groups = await readdir(join(dir, 'pi-tracing', '.recordings'));
    expect(groups, JSON.stringify(await Promise.all(groups.map(g => readdir(join(dir, 'pi-tracing', '.recordings', g)))))).toHaveLength(0);
  } finally {await rm(dir, {recursive: true, force: true});}
}, 30000);
