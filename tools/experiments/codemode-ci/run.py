#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Explore direct vs scripted tools using a deterministic, local CI API replay."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cases', type=int, default=192)
parser.add_argument('--rounds', type=int, default=1)
parser.add_argument('--seed', type=int, default=62813)
parser.add_argument('--model', default='claude-opus-5')
parser.add_argument('--provider', default='anthropic')
parser.add_argument('--thinking', default='high')
parser.add_argument('--no-calculations', action='store_true', help='Omit bash (the initial API-only screening variant)')
args = parser.parse_args()
if args.cases < 1 or args.rounds < 1:
    parser.error('cases and rounds must be positive')
batch = ROOT / 'artifacts/experiments' / f'codemode-ci-{uuid.uuid4().hex[:8]}'
batch.mkdir(parents=True)
(batch / 'source').mkdir()
for source_file in [Path(__file__), HERE / 'extension.ts']:
    shutil.copyfile(source_file, batch / 'source' / source_file.name)
rng = random.Random(args.seed)
owners = ['compiler', 'editor', 'platform', 'runtime']
failures = []
counts = {owner: {'owner': owner, 'new': 0, 'persistent': 0, 'intermittent': 0} for owner in owners}
new_failures = []
for index in range(args.cases):
    identifier = hashlib.sha256(f'{args.seed}:{index}'.encode()).hexdigest()[:12]
    owner = rng.choice(owners)
    pattern = rng.randrange(16)
    # Every possible four-result history is sampled, including all-pass/all-fail.
    history = [{'run_id': f'nightly-{97 - n}',
                'commit': hashlib.sha256(f'commit:{97 - n}'.encode()).hexdigest()[:12],
                'conclusion': 'failed' if pattern & (1 << n) else 'passed',
                'started_at': (datetime(2026, 9, 29, tzinfo=timezone.utc) - timedelta(days=n)).isoformat(),
                'duration_ms': rng.randrange(800, 120001)} for n in range(4)]
    failure = {'id': identifier, 'owner': owner, 'test': f'{owner}/integration/case-{index:04d}',
               'duration_ms': rng.randrange(800, 120001), 'history': history}
    failures.append(failure)
    # Oracle uses the generator's bit mask, independently of an agent's history reduction.
    category = 'new' if pattern == 0 else 'persistent' if pattern == 15 else 'intermittent'
    counts[owner][category] += 1
    if category == 'new':
        new_failures.append(failure)
rng.shuffle(failures)
snapshot = {'run_id': 'nightly-98', 'failures': failures}
expected = {'total': args.cases, 'owners': [counts[owner] for owner in sorted({f['owner'] for f in failures})],
            'slowest_new': [{'id': failure['id'], 'duration_ms': failure['duration_ms']}
                            for failure in sorted(new_failures, key=lambda f: (-f['duration_ms'], f['id']))[:5]]}
snapshot_path = batch / 'snapshot.json'
snapshot_path.write_text(json.dumps(snapshot, indent=2) + '\n')
(batch / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
prompt = '''Audit the failed tests in CI run nightly-98. Retrieve every page of failures and the four preceding completed executions for every failure. Classify each current failure as new (all four preceding executions passed), persistent (all four failed), or intermittent (a mixture).

Return only JSON with this exact shape:
{"total": <number of current failures>, "owners": [{"owner": <name>, "new": <count>, "persistent": <count>, "intermittent": <count>}], "slowest_new": [{"id": <failure ID>, "duration_ms": <current duration>}]}

Sort owners by name. Include the five slowest NEW failures by current duration, descending, with ties broken by ID ascending; include all if fewer than five. Include all owners, with zero counts where appropriate. Be exact; do not estimate or sample.

Use the CI tools for all CI data access. Use whatever available tools and parallelism are efficient, with at most 16 tool requests in flight. No changes to CI are needed.
'''
if not args.no_calculations:
    prompt += '\nYou may use bash for local calculations or scratch files to help aggregate the returned tool data.\n'
(batch / 'prompt.txt').write_text(prompt)

def record(round_number, mode):
    work = batch / f'round-{round_number}' / mode
    (work / '.pi').mkdir(parents=True)
    (work / '.pi/settings.json').write_text(json.dumps({'codemode': {'mode': 'only'}}))
    session = str(uuid.uuid4())
    command = ['pi', '--provider', args.provider, '--model', args.model, '--thinking', args.thinking,
        '--no-extensions', '-e', str(ROOT / 'packages/pi-tracing/extensions/pi-tracing/index.ts'),
        '-e', str(HERE / 'extension.ts'),
        '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
        '--tools', ('bash,' if not args.no_calculations else '') + 'ci_list_failures,ci_get_failure_history' + (',codemode' if mode == 'codemode' else ''),
        '--session-dir', str(work / 'sessions'), '--session-id', session,
        '--name', f'CI failure audit ({mode})', '--tracing', '--mode', 'json', '-p', prompt]
    if mode == 'codemode':
        command[1:1] = ['-e', 'builtin:codemode']
    env = os.environ | {'PI_TRACING_CAPTURE_CONTENTS': '1', 'PI_TRACING_CATEGORIES': 'contents',
        'PI_TRACING_CHILD_WAIT_MS': '0', 'AGENTPROF_CI_SNAPSHOT': str(snapshot_path),
        'AGENTPROF_CI_AUDIT': str(work / 'api-calls.jsonl')}
    start = time.monotonic()
    problem = None
    with (work / 'events.jsonl').open('w') as output, (work / 'stderr.log').open('w') as error:
        try:
            result = subprocess.run(command, cwd=work, env=env, stdout=output, stderr=error, timeout=1200)
            if result.returncode:
                problem = f'Pi exit {result.returncode}'
        except subprocess.TimeoutExpired:
            problem = 'Pi timed out after 1200 seconds'
    elapsed = time.monotonic() - start
    events = []
    for line in (work / 'events.jsonl').read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    messages = [event['message'] for event in events if event.get('type') == 'message_end'
                and event.get('message', {}).get('role') == 'assistant']
    actual = None
    if messages:
        answer = '\n'.join(block.get('text', '') for block in messages[-1]['content'] if block['type'] == 'text').strip()
        (work / 'answer.txt').write_text(answer + '\n')
        fenced = re.search(r'```(?:json)?\s*\n(.*?)\n```', answer, re.S)
        try:
            actual = json.loads(fenced.group(1) if fenced else answer)
            (work / 'answer.json').write_text(json.dumps(actual, indent=2) + '\n')
        except json.JSONDecodeError:
            problem = problem or 'Final answer was not JSON'
        if messages[-1].get('stopReason') != 'stop':
            problem = problem or f'Model stopped with {messages[-1].get("stopReason")}'
    else:
        problem = problem or 'No assistant messages'
    if actual != expected:
        problem = problem or 'Answer differs from independent oracle'
    calls_path = work / 'api-calls.jsonl'
    calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
    fetched = {call['args']['failure_id'] for call in calls if call['name'] == 'ci_get_failure_history'}
    if fetched != {failure['id'] for failure in failures}:
        problem = problem or 'Not every failure history was retrieved'
    usage = [message.get('usage', {}) for message in messages]
    tool_events = [e for e in events if e.get('type') == 'tool_execution_end']
    scripts = sum(e.get('toolName') == 'codemode' for e in tool_events)
    if mode == 'codemode' and not scripts:
        problem = problem or 'Codemode was not exercised'
    agent_dir = Path(env.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')))
    traces = list((agent_dir / 'pi-tracing').glob(f'{session[:8]}-*.pftrace'))
    trace_hash = None
    if len(traces) == 1:
        shutil.copyfile(traces[0], work / 'trace.pftrace')
        trace_hash = hashlib.sha256((work / 'trace.pftrace').read_bytes()).hexdigest()
    else:
        problem = problem or f'Expected one finalized trace, found {len(traces)}'
    metadata = {'round': round_number, 'mode': mode, 'sessionId': session,
        'correct': actual == expected, 'error': problem, 'wallSeconds': elapsed,
        'responses': len(messages), 'toolCalls': len(tool_events) - scripts,
        'apiCalls': len(calls), 'uniqueHistories': len(fetched), 'scripts': scripts,
        'nestedCalls': sum('parentToolCallId' in e for e in tool_events),
        'outputTokens': sum(u.get('output', 0) for u in usage),
        'inputTokens': sum(u.get('input', 0) for u in usage),
        'cacheReadTokens': sum(u.get('cacheRead', 0) for u in usage),
        'cacheWriteTokens': sum(u.get('cacheWrite', 0) for u in usage),
        'totalInputTokens': sum(sum(u.get(key, 0) for key in ['input', 'cacheRead', 'cacheWrite']) for u in usage),
        'peakRequestTokens': max((sum(u.get(key, 0) for key in ['input', 'cacheRead', 'cacheWrite']) for u in usage), default=0),
        'reportedCostUsd': sum(u.get('cost', {}).get('total', 0) for u in usage),
        'traceSha256': trace_hash}
    (work / 'recording.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata), flush=True)
    return metadata

manifest = {'piVersion': subprocess.check_output(['pi', '--version'], text=True).strip(),
    'pythonVersion': sys.version.split()[0],
    **vars(args), 'snapshotSha256': hashlib.sha256(snapshot_path.read_bytes()).hexdigest(),
    'promptSha256': hashlib.sha256(prompt.encode()).hexdigest(),
    'extensionSha256': hashlib.sha256((batch / 'source/extension.ts').read_bytes()).hexdigest(),
    'runnerSha256': hashlib.sha256((batch / 'source/run.py').read_bytes()).hexdigest(), 'recordings': []}
print(f'CI replay experiment: {batch}', flush=True)
for round_number in range(1, args.rounds + 1):
    with ThreadPoolExecutor(max_workers=2) as pool:
        # Alternate launch order; both processes in each pair run concurrently.
        modes = ['classic', 'codemode'] if round_number % 2 else ['codemode', 'classic']
        runs = list(pool.map(lambda mode: record(round_number, mode), modes))
    manifest['recordings'].extend(runs)
    (batch / 'recording.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if any(run['error'] for run in runs):
        print('Stopping after a failed pair; all outputs are retained.', flush=True)
        break
print(batch, flush=True)
sys.exit(1 if any(run['error'] for run in manifest['recordings']) else 0)
