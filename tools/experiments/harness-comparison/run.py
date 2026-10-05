#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Record controlled Pi/Claude diagnostics; retain every outcome, including failures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
CASES = ['serial', 'parallel', 'coding', 'reviewer']
VARIANTS = ['pi', 'pi-codemode', 'claude-code']


def variant_order(variants, round_number, case_index):
    offset = (round_number - 1 + case_index) % len(variants)
    return variants[offset:] + variants[:offset]


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def events(path):
    result = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return result


def retain_spool(agent_dir, work, session):
    trace_dir = agent_dir / 'pi-tracing'
    for path in trace_dir.rglob('*'):
        if path.is_file() and session[:8] in str(path.relative_to(trace_dir)):
            target = work / 'capture-recovery' / path.relative_to(trace_dir)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def messages(work, harness):
    if harness == 'pi':
        return [dict(e['message'], child=child) for path, child in
                [(work / 'events.jsonl', False), (work / 'reviewer/events.jsonl', True)]
                for e in events(path) if e.get('type') == 'message_end'
                and e.get('message', {}).get('role') == 'assistant']
    grouped = {}
    for e in events(work / 'events.jsonl'):
        if e.get('type') != 'assistant':
            continue
        m = e['message']
        result = grouped.setdefault(m['id'], dict(m, content=[], child=bool(e.get('parent_tool_use_id'))))
        result['content'].extend(m['content'])
    return list(grouped.values())


def tool_calls(message):
    return [{'name': c['name'], 'args': c.get('arguments', c.get('input', {}))}
            for c in message['content'] if c['type'] in ['toolCall', 'tool_use']]


def execution_counts(work, harness, calls):
    if harness != 'pi':
        return {'primaryExecutedCalls': len(calls), 'scriptCalls': 0, 'nestedToolCalls': 0}
    # Nested codemode tools do not appear as assistant tool-call blocks. Count
    # executions once at start; do not double-count their completion events.
    started = [e for e in events(work / 'events.jsonl') if e.get('type') == 'tool_execution_start']
    return {'primaryExecutedCalls': len(started),
            'scriptCalls': sum(e.get('toolName') == 'codemode' for e in started),
            'nestedToolCalls': sum(bool(e.get('parentToolCallId')) for e in started)}


def answer(message):
    return '\n'.join(c['text'] for c in message['content'] if c['type'] == 'text').strip()


def parse_answer(text):
    match = re.fullmatch(r'```(?:json)?\s*\n(.*?)\n```', text, re.S)
    try:
        return json.loads(match.group(1) if match else text)
    except json.JSONDecodeError:
        return None


def prepare(work, case, seed):
    task = work / 'task'
    task.mkdir(parents=True)
    expected = None
    config = None
    review = None
    if case in ['serial', 'parallel']:
        chain = ['START'] + [hashlib.sha256(f'{seed}:{i}'.encode()).hexdigest()[:12] for i in range(6)]
        config = {'chain': chain, 'jobs': {'alpha': 7, 'beta': 11, 'gamma': 17, 'delta': 23}, 'delayMs': 1000}
        save(task / 'probe-data.json', config)
        shutil.copyfile(HERE / 'probe.mjs', task / 'probe.mjs')
        if case == 'serial':
            prompt = '''Serial tool-loop diagnostic. Execute exactly six separate shell tool calls.
Start with `node probe.mjs step START`. Each result contains a next key; use it in the next command, `node probe.mjs step KEY`. The sixth result contains done instead.
Use one command per tool call and wait for its result before issuing the next. Do not inspect files, batch commands, use loops, delegate, or run anything else. Use each returned key exactly once. Do not narrate your progress.
After the sixth call, return only {"done":"VALUE"} using the returned done value.
'''
            expected = {'done': chain[-1]}
        else:
            prompt = '''Parallel tool scheduling diagnostic. Submit these four separate shell tool calls together, in ONE assistant response, so the harness can execute them concurrently:
`node probe.mjs job alpha`
`node probe.mjs job beta`
`node probe.mjs job gamma`
`node probe.mjs job delta`
Each command does one second of fixed waiting. Run each exactly once, with one command per tool call. Do not combine commands in a shell, inspect files, delegate, retry, or run anything else. Do not narrate your progress.
When all four finish, return only {"sum":NUMBER}, adding the four returned values.
'''
            expected = {'sum': sum(config['jobs'].values())}
    elif case == 'coding':
        for name in ['intervals.mjs', 'intervals.test.mjs']:
            shutil.copyfile(ROOT / 'examples/pi-opus-5/task' / name, task / name)
        prompt = '''Bounded coding diagnostic. Fix summarizeIntervals in intervals.mjs. It accepts finite half-open intervals [start, end), end >= start, and returns their union duration as activeMs and maximum simultaneous nonempty intervals as peakConcurrency. Do not mutate the input.
Read the source and existing tests. Run `node --test` once to see the baseline. Fix the implementation and create additional.test.mjs containing exactly FOUR regression tests: simultaneous starts/ends, duplicated intervals, zero-length intervals, and frozen input. Run the tests and correct failures if needed.
Only modify intervals.mjs and additional.test.mjs. Do not modify intervals.test.mjs, write documentation or temporary files, delegate, or inspect anything outside this directory. Once all tests pass, stop. Keep progress text brief and the final response to at most 80 words.
'''
    else:
        left = [{'id': f'd{i:02}', 'limit': 10 + i} for i in range(8)]
        right = [dict(r, limit=r['limit'] + (1 if i in [2, 5] else 0)) for i, r in enumerate(left)]
        save(task / 'left.json', left)
        save(task / 'right.json', right)
        expected = {'mismatches': ['d02', 'd05']}
        review = '''Read left.json and right.json using the read tool, exactly once each. Compare their limit values by id. Return only JSON {"mismatches":[...]} listing ids with different limits, sorted ascending. Do not read any other file, modify files, run commands, delegate, or add commentary.'''
        prompt = f'''Isolated delegation diagnostic. Launch exactly one comparison-reviewer subagent in the background, using the same model as you. Give it exactly the task between <task> tags below, with no additions. Use the native delegation tool (subagent or Agent); for Agent select subagent_type comparison-reviewer and run_in_background true.
<task>{review}</task>
Collect its result before finishing. The reviewer has only a read tool. Do not read or modify files yourself, run commands, launch another child, or narrate progress. Return the reviewer's JSON answer unchanged.
'''
    (work / 'prompt.txt').write_text(prompt)
    if review:
        (work / 'review-prompt.txt').write_text(review)
    original = {p.name: digest(p) for p in task.iterdir() if p.is_file()}
    save(work / 'inputs.json', {'sha256': original, 'expected': expected, 'config': config})
    return prompt, expected, config, review, original


def oracle(task, output):
    rng = random.Random(302610)
    cases = []
    for _ in range(500):
        intervals = [sorted([rng.randrange(-20, 41) / 2, rng.randrange(-20, 41) / 2]) for _ in range(rng.randrange(16))]
        points = sorted({p for interval in intervals for p in interval})
        coverage = [(b - a, sum(x <= (a + b) / 2 < y for x, y in intervals)) for a, b in zip(points, points[1:])]
        cases.append({'intervals': intervals, 'expected': {'activeMs': sum(d for d, n in coverage if n),
                                                         'peakConcurrency': max((n for _, n in coverage), default=0)}})
    script = '''import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';
let input=''; for await (const data of process.stdin) input+=data;
for(const {intervals,expected} of JSON.parse(input)) {
  assert.deepEqual(summarizeIntervals(Object.freeze(intervals.map(i=>Object.freeze(i)))),expected);
}
console.log('PASS 500 independent interval cases with frozen inputs');'''
    result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(cases),
                            cwd=task, text=True, capture_output=True, timeout=30)
    output.write_text(result.stdout + result.stderr)
    return result.returncode == 0


def validate(work, harness, case, expected, config, review, original, variant=None):
    msgs = messages(work, harness)
    primary = [m for m in msgs if not m['child']]
    children = [m for m in msgs if m['child']]
    calls = [c for m in primary for c in tool_calls(m)]
    executions = execution_counts(work, harness, calls)
    issues = []
    if variant == 'pi-codemode':
        if not executions['scriptCalls'] or not executions['nestedToolCalls']:
            issues.append('Codemode did not execute nested tools')
        if any(c['name'] != 'codemode' for c in calls):
            issues.append('Codemode-only variant used a direct tool')
    text = answer(primary[-1]) if primary else ''
    (work / 'answer.txt').write_text(text + '\n')
    correct = parse_answer(text) == expected if expected is not None else False
    task = work / 'task'
    changed = [name for name, sha in original.items() if not (task / name).exists() or digest(task / name) != sha]
    created = [str(p.relative_to(task)) for p in task.rglob('*') if p.is_file() and p.name not in original]
    if case != 'coding' and (changed or created):
        issues.append(f'Fixture changed: {changed + created}')
    audit = events(work / 'probe-audit.jsonl')
    starts = [e for e in audit if e['phase'] == 'start']
    ends = [e for e in audit if e['phase'] == 'end']
    if case in ['serial', 'parallel']:
        keys = config['chain'][:-1] if case == 'serial' else list(config['jobs'])
        mode = 'step' if case == 'serial' else 'job'
        expected_commands = [f'node probe.mjs {mode} {key}' for key in keys]
        actual_commands = [c['args'].get('command', '').strip() if c['name'].lower() == 'bash' else c['name'] for c in calls]
        if (actual_commands != expected_commands if case == 'serial' else sorted(actual_commands) != sorted(expected_commands)):
            issues.append('Tool calls do not match the prescribed commands exactly once')
        if sorted(e['key'] for e in starts) != sorted(keys) or sorted(e['key'] for e in ends) != sorted(keys):
            issues.append('Workload audit does not contain exactly the required completed jobs')
        if case == 'serial' and [e['key'] for e in starts] != keys:
            issues.append('Serial chain executed out of order')
        if case == 'parallel' and max((len(tool_calls(m)) for m in primary), default=0) != 4:
            issues.append('Four tool calls were not submitted in one assistant response')
    if case == 'reviewer':
        launches = [c for c in calls if c['name'] in ['subagent', 'Agent']]
        if len(launches) != 1 or not children:
            issues.append('Expected exactly one observed reviewer')
        for c in launches:
            if c['args'].get('task', c['args'].get('prompt', '')).strip() != review:
                issues.append('Delegated task differed from the fixed review prompt')
            if c['name'] == 'Agent' and (c['args'].get('subagent_type') != 'comparison-reviewer' or c['args'].get('run_in_background') is not True):
                issues.append('Expected the configured reviewer launched in the background')
        if any(c['name'] not in ['subagent', 'Agent', 'wait_subagents', 'TaskOutput'] for c in calls):
            issues.append('Primary performed work outside delegation/collection')
        reads = [c for m in children for c in tool_calls(m)]
        if any(c['name'].lower() != 'read' for c in reads) or sorted(Path(c['args'].get('path', c['args'].get('file_path', ''))).name for c in reads) != ['left.json', 'right.json']:
            issues.append('Reviewer did not read exactly the two fixtures with read tools')
        if not children or parse_answer(answer(children[-1])) != expected:
            issues.append('Reviewer answer was incorrect')
    test_count = None
    if case == 'coding':
        checked = subprocess.run(['node', '--test'], cwd=task, capture_output=True, text=True, timeout=30)
        (work / 'verification.log').write_text(checked.stdout + checked.stderr)
        match = re.search(r'^# tests (\d+)$', checked.stdout, re.M)
        test_count = int(match.group(1)) if match else None
        correct = checked.returncode == 0 and oracle(task, work / 'oracle.log')
        if (task / 'intervals.test.mjs').exists() and digest(task / 'intervals.test.mjs') != original['intervals.test.mjs']:
            issues.append('Original tests were modified')
        if set(changed) - {'intervals.mjs'} or set(created) - {'additional.test.mjs'}:
            issues.append('Files outside the allowed deliverables were changed')
        if not (task / 'additional.test.mjs').exists() or test_count != 12:
            issues.append(f'Expected four added regression tests (12 total); found {test_count}')
        if children:
            issues.append('Coding task unexpectedly delegated')
        if len(text.split()) > 80:
            issues.append('Final answer exceeds the 80-word bound')
    # Independent process timestamps reveal actual execution overlap, regardless
    # of whether the model grouped its calls or how the UI maps tool spans.
    points = sorted([(int(e['ns']), 1 if e['phase'] == 'start' else -1) for e in audit])
    current = peak = 0
    for _, delta in points:
        current += delta
        peak = max(peak, current)
    result = {'correct': correct, 'protocolIssues': issues, 'primaryResponses': len(primary),
              'reviewerResponses': len(children), 'primaryToolCalls': len(calls),
              **executions,
              'reviewerToolCalls': sum(len(tool_calls(m)) for m in children),
              'testCount': test_count, 'workloadPeakConcurrency': peak or None,
              'workloadWindowSeconds': (points[-1][0] - points[0][0]) / 1e9 if points else None}
    save(work / 'validation.json', result)
    return result


def record(batch, round_number, case, variant, args, agent_dir):
    harness = 'pi' if variant.startswith('pi') else 'claude-code'
    work = batch / case / f'round-{round_number}' / variant
    work.mkdir(parents=True)
    prompt, expected, config, review, original = prepare(work, case, args.seed)
    session = str(uuid.uuid4())
    env = os.environ | {'MAX_THINKING_TOKENS': '0', 'CLAUDE_CODE_SUBAGENT_MODEL': args.model,
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY': '1', 'PI_CODING_AGENT_DIR': str(agent_dir),
        'PI_TRACING_CAPTURE_CONTENTS': '1', 'PI_TRACING_CATEGORIES': 'all,-node.perf,-node.gc,-stream.verbose,-system',
        'PI_TRACING_CHILD_WAIT_MS': '0', 'AGENTPROF_PROBE_AUDIT': str(work / 'probe-audit.jsonl'),
        'AGENTPROF_REVIEW_OUTPUT': str(work / 'reviewer'), 'AGENTPROF_REVIEW_PROMPT': str(work / 'review-prompt.txt'),
        'AGENTPROF_COMPARISON_MODEL': args.model}
    if harness == 'pi':
        # Scope the setting to this private agent directory, outside the task's
        # allowed deliverables. Persist the exact setting with the run artifacts.
        settings = {'codemode': {'mode': 'only' if variant == 'pi-codemode' else 'on'}}
        save(agent_dir / 'settings.json', settings)
        save(work / 'pi-settings.json', settings)
        allowed = 'bash' if case in ['serial', 'parallel'] else 'read,bash,edit,write' if case == 'coding' else 'subagent,wait_subagents'
        if variant == 'pi-codemode':
            allowed += ',codemode'
        command = ['pi', '--provider', 'anthropic', '--model', args.model, '--thinking', 'off',
            '--no-extensions', '-e', str(ROOT / 'packages/pi-tracing/extensions/pi-tracing/index.ts'),
            '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--approve',
            '--tools', allowed, '--session-dir', str(work / 'sessions'), '--session-id', session,
            '--name', f'{case} round {round_number}', '--tracing', '--mode', 'json', '-p', '--', prompt]
        if case == 'reviewer':
            command[1:1] = ['-e', str(HERE / 'reviewer.ts')]
        if variant == 'pi-codemode':
            command[1:1] = ['-e', 'builtin:codemode']
    else:
        allowed = 'Bash' if case in ['serial', 'parallel'] else 'Read,Bash,Edit,Write' if case == 'coding' else 'Read,Agent,TaskOutput'
        command = [str(ROOT / 'node_modules/.bin/bun'), str(ROOT / 'tools/record-claude.ts'), str(work / 'trace.pftrace'),
            '--', '-p', '--model', args.model, '--session-id', session, '--max-budget-usd', '2',
            '--forward-subagent-text', '--tools', allowed, '--allowedTools', allowed,
            '--disable-slash-commands', '--setting-sources', '', '--settings', '{"alwaysThinkingEnabled":false}',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
        if case == 'reviewer':
            command += ['--agents', json.dumps({'comparison-reviewer': {
                'description': 'Read-only fixture reviewer. Use for the isolated delegation diagnostic.',
                'prompt': 'Perform the supplied read-only review task exactly. Use only your read tool.',
                'tools': ['Read'], 'model': args.model}})]
        command += ['--', prompt]
    save(work / 'command.json', command)
    print(f'Starting {case} round {round_number}: {variant}', flush=True)
    started = time.monotonic()
    with (work / 'events.jsonl').open('w') as output, (work / 'stderr.log').open('w') as error:
        process = subprocess.Popen(command, cwd=work / 'task', env=env, stdout=output, stderr=error, start_new_session=True)
        timed_out = False
        try:
            code = process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            code = 124
    elapsed = time.monotonic() - started
    if harness == 'pi':
        traces = list((agent_dir / 'pi-tracing').glob(f'{session[:8]}-*.pftrace'))
        if len(traces) == 1:
            shutil.copyfile(traces[0], work / 'trace.pftrace')
        else:
            # Preserve a failed publication's spool before the temporary agent
            # directory closes. A successful CLI exit does not imply a trace.
            retain_spool(agent_dir, work, session)
    validation = validate(work, harness, case, expected, config, review, original, variant)
    trace = work / 'trace.pftrace'
    result = {'case': case, 'round': round_number, 'harness': harness, 'variant': variant, 'sessionId': session,
              'path': str(work.relative_to(batch)), 'exitCode': code, 'timedOut': timed_out,
              'processWallSeconds': elapsed, 'promptSha256': digest(work / 'prompt.txt'),
              'traceSha256': digest(trace) if trace.exists() else None, **validation}
    save(work / 'recording.json', result)
    print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--cases', nargs='+', choices=CASES, default=CASES)
    parser.add_argument('--variants', nargs='+', choices=VARIANTS, default=['pi', 'claude-code'])
    parser.add_argument('--model', default='claude-haiku-4-5-20251001')
    parser.add_argument('--seed', type=int, default=302610)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--resume', type=Path, help='Run only absent attempts from an interrupted batch')
    args = parser.parse_args()
    if args.rounds < 1 or args.timeout < 1:
        parser.error('rounds and timeout must be positive')
    batch = (args.resume or args.output or ROOT / 'artifacts/experiments' / f'harness-comparison-{uuid.uuid4().hex[:8]}').resolve()
    if args.resume:
        manifest = json.loads((batch / 'recording.json').read_text())
        args.model, args.rounds, args.cases, args.seed = (manifest[k] for k in ['model', 'rounds', 'cases', 'seed'])
        args.variants = manifest.get('variants', ['pi', 'claude-code'])
        shutil.copytree(HERE, batch / f'source-resume-{uuid.uuid4().hex[:8]}', ignore=shutil.ignore_patterns('__pycache__'))
    else:
        batch.mkdir(parents=True, exist_ok=False)
        os.chmod(batch, 0o700)
        shutil.copytree(HERE, batch / 'source', ignore=shutil.ignore_patterns('__pycache__'))
        manifest = {'model': args.model, 'thinking': 'off', 'rounds': args.rounds, 'cases': args.cases, 'variants': args.variants,
                'seed': args.seed, 'piVersion': subprocess.check_output(['pi', '--version'], text=True).strip(),
                'claudeVersion': subprocess.check_output(['claude', '--version'], text=True).strip(),
                'recordings': [], 'notes': ['All outcomes retained; no retries to replace failed runs.',
                    'Fresh sessions; rotating sequential order; natural provider cache state and latency.',
                    'Native system prompts and tool definitions intentionally retained.',
                    'Pi codemode uses only mode with the same four coding tools; the user prompt is unchanged.',
                    'Parallel workload has an explicit one-second delay in each of four commands.',
                    'Both harnesses run with tracing enabled; this is not an instrumentation overhead measurement.']}
    if len(set(args.variants)) != len(args.variants):
        parser.error('variants must not repeat')
    if 'pi-codemode' in args.variants and args.cases != ['coding']:
        parser.error('pi-codemode is supported only with --cases coding; other probes prescribe direct calls')
    print(f'Comparison batch: {batch}', flush=True)
    save(batch / 'recording.json', manifest)
    # Reuse installed authentication without copying credentials into artifacts or
    # pruning the user's recordings. The private agent directory lives only here.
    original_agent_dir = Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')))
    with tempfile.TemporaryDirectory(prefix='agentprof-compare-') as temporary:
        agent_dir = Path(temporary)
        for name in ['auth.json', 'models.json']:
            source = original_agent_dir / name
            if source.exists():
                (agent_dir / name).symlink_to(source.resolve())
        for round_number in range(1, args.rounds + 1):
            for index, case in enumerate(args.cases):
                for variant in variant_order(args.variants, round_number, index):
                    if any(r['round'] == round_number and r['case'] == case and r.get('variant', r['harness']) == variant for r in manifest['recordings']):
                        continue
                    result = record(batch, round_number, case, variant, args, agent_dir)
                    manifest['recordings'].append(result)
                    save(batch / 'recording.json', manifest)
                    if result['exitCode']:
                        raise SystemExit(f'Infrastructure failure; retained artifacts at {batch}')
    print(f'Analyse with: node_modules/.bin/bun {HERE / "analyse.ts"} {batch}', flush=True)


if __name__ == '__main__':
    main()
