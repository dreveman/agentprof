#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Record and verify classic/codemode runs on one source snapshot; requires Pi auth."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[3]
SOURCE = 'packages/pi-tracing/extensions/pi-tracing'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', default='claude-opus-5')
parser.add_argument('--provider', default='anthropic')
parser.add_argument('--thinking', default='high')
parser.add_argument('--source-revision', default='9d62264828c28e8f0df2155cc87a6b956b6d79bd')
args = parser.parse_args()
batch = ROOT / 'artifacts/live-pi' / f'codemode-{uuid.uuid4().hex[:8]}'
batch.mkdir(parents=True)
files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', args.source_revision,
                                 SOURCE], cwd=ROOT, text=True).splitlines()
sources = {Path(path).name: subprocess.check_output(['git', 'show', f'{args.source_revision}:{path}'], cwd=ROOT)
           for path in files if path.endswith('.ts') and not path.endswith('.test.ts')
           and not path.endswith('/test-proto.ts')}
expected = {'files': [{'file': name,
    'exports': len(re.findall(r'^export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+', data.decode(), re.M)),
    'hooks': len(re.findall(r'\bpi\.on\(\s*["\']', data.decode()))}
    for name, data in sorted(sources.items())]}
expected['totals'] = {key: sum(row[key] for row in expected['files']) for key in ['exports', 'hooks']}
(batch / 'expected.json').write_text(json.dumps(expected, indent=2) + '\n')
prompt = (Path(__file__).resolve().parent / 'prompt.txt').read_text()
version = subprocess.check_output(['pi', '--version'], text=True).strip()

def record(mode):
    work = batch / mode
    (work / 'src').mkdir(parents=True)
    for name, data in sources.items():
        (work / 'src' / name).write_bytes(data)
    (work / '.pi').mkdir()
    (work / '.pi/settings.json').write_text(json.dumps({'codemode': {'mode': 'only'}}))
    (work / '.pi/pi-tracing.json').write_text('{"finalizeDeadlineMs":5000}\n')
    session = str(uuid.uuid4())
    command = ['pi', '--provider', args.provider, '--model', args.model, '--thinking', args.thinking,
        '--no-extensions', '-e', str(ROOT / 'packages/pi-tracing/extensions/pi-tracing/index.ts'),
        '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
        '--tools', 'read,grep,find,ls' + (',codemode' if mode == 'codemode' else ''),
        '--session-dir', str(work / 'sessions'), '--session-id', session,
        '--name', f'{mode} inventory', '--tracing', '--mode', 'json', '-p', prompt]
    if mode == 'codemode':
        # --no-extensions also disables Pi's built-in codemode extension.
        command[1:1] = ['-e', 'builtin:codemode']
    env = os.environ | {'PI_TRACING_CAPTURE_CONTENTS': '1', 'PI_TRACING_CATEGORIES': 'contents', 'PI_TRACING_CHILD_WAIT_MS': '0'}
    with (work / 'events.jsonl').open('w') as output, (work / 'stderr.log').open('w') as error:
        result = subprocess.run(command, cwd=work, env=env, stdout=output, stderr=error, timeout=1200)
    if result.returncode:
        raise RuntimeError(f'{mode}: Pi exited {result.returncode}; see {work / "stderr.log"}')
    events = [json.loads(line) for line in (work / 'events.jsonl').read_text().splitlines() if line.strip()]
    if mode == 'codemode' and not any(event.get('toolName') == 'codemode' for event in events):
        raise RuntimeError('Codemode was not exercised; this is not a valid comparison')
    messages = [event['message'] for event in events if event.get('type') == 'message_end'
                and event.get('message', {}).get('role') == 'assistant']
    if not messages or messages[-1].get('stopReason') != 'stop':
        raise RuntimeError(f'{mode}: model did not finish successfully')
    answer = '\n'.join(block.get('text', '') for block in messages[-1]['content'] if block['type'] == 'text').strip()
    fenced = re.search(r'```(?:json)?\s*\n(.*?)\n```', answer, re.S)
    if fenced:
        answer = fenced.group(1)
    actual = json.loads(answer)
    (work / 'answer.json').write_text(json.dumps(actual, indent=2) + '\n')
    if actual != expected:
        raise RuntimeError(f'{mode}: answer differs from independent counts; see {work}')
    agent_dir = Path(env.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')))
    traces = list((agent_dir / 'pi-tracing').glob(f'{session[:8]}-*.pftrace'))
    if len(traces) != 1:
        raise RuntimeError(f'{mode}: expected one finalized trace, found {len(traces)}')
    shutil.copyfile(traces[0], work / 'trace.pftrace')
    usage = [message.get('usage', {}) for message in messages]
    metadata = {'mode': mode, 'sessionId': session, 'provider': args.provider, 'model': args.model,
        'effort': args.thinking, 'responses': len(messages),
        'toolCalls': sum(event.get('type') == 'tool_execution_end' and event.get('toolName') != 'codemode' for event in events),
        'scripts': sum(event.get('type') == 'tool_execution_end' and event.get('toolName') == 'codemode' for event in events),
        'nestedCalls': sum(event.get('type') == 'tool_execution_end' and 'parentToolCallId' in event for event in events),
        'inputTokens': sum(u.get('input', 0) for u in usage),
        'outputTokens': sum(u.get('output', 0) for u in usage),
        'cacheReadTokens': sum(u.get('cacheRead', 0) for u in usage),
        'cacheWriteTokens': sum(u.get('cacheWrite', 0) for u in usage),
        'sha256': hashlib.sha256((work / 'trace.pftrace').read_bytes()).hexdigest()}
    (work / 'recording.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Verified {mode}: {work / "trace.pftrace"}', flush=True)
    return metadata

print(f'Recording paired runs with Pi {version}: {batch}', flush=True)
with ThreadPoolExecutor(max_workers=2) as pool:
    recordings = list(pool.map(record, ['classic', 'codemode']))
(batch / 'recording.json').write_text(json.dumps({'piVersion': version,
    'sourceRevision': args.source_revision, 'promptFile': 'prompt.txt',
    'sourceSha256': {name: hashlib.sha256(data).hexdigest() for name, data in sources.items()},
    'recordings': recordings}, indent=2) + '\n')
print(f'Both answers matched the independent inventory: {batch}', flush=True)
