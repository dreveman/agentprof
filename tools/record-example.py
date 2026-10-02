#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Record a real Pi session on the checked-in example task; requires Pi auth."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--name', required=True)
parser.add_argument('--workflow', action='store_true', help='Record a parent with parallel workers and a follow-up reviewer')
parser.add_argument('--provider', default='anthropic')
parser.add_argument('--model', default='claude-opus-5')
parser.add_argument('--thinking', default='high')
args = parser.parse_args()
session_id = str(uuid.uuid4())
work = ROOT / 'artifacts' / 'live-pi' / f'{args.name}-{session_id[:8]}'
shutil.copytree(ROOT / 'examples/pi-opus-5/task', work)
env = os.environ | {'PI_TRACING_CAPTURE_CONTENTS': '1', 'PI_TRACING_CATEGORIES': 'contents', 'PI_TRACING_CHILD_WAIT_MS': '0'}
command = ['pi', '--provider', args.provider, '--model', args.model, '--thinking', args.thinking,
           '--no-extensions', '-e', str(ROOT / 'packages/pi-tracing/extensions/pi-tracing/index.ts'),
           '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
           '--tools', 'read,bash,edit,write,subagent,wait_subagents' if args.workflow else 'read,bash,edit,write', '--session-dir', str(work / 'sessions'),
           '--session-id', session_id, '--name', args.name, '--tracing', '--mode', 'json', '-p',
           (ROOT / 'examples/pi-opus-5' / ('workflow-prompt.txt' if args.workflow else 'prompt.txt')).read_text()]
if args.workflow:
    command[1:1] = ['-e', str(ROOT / 'examples/pi-opus-5/subagents.ts')]
(work / 'recording.json').write_text(json.dumps({'sessionId': session_id, 'name': args.name,
    'model': args.model, 'provider': args.provider, 'effort': args.thinking, 'workflow': args.workflow}, indent=2) + '\n')
print(f'Recording {args.name}: {work}', flush=True)
with (work / 'events.jsonl').open('w') as output, (work / 'stderr.log').open('w') as error:
    result = subprocess.run(command, cwd=work, env=env, stdout=output, stderr=error)
if result.returncode:
    raise SystemExit(f'Pi exited {result.returncode}; inspect {work / "stderr.log"}')
agent_dir = Path(env.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')))
traces = sorted((agent_dir / 'pi-tracing').glob(f'{session_id[:8]}-*.pftrace'))
if len(traces) != 1:
    raise SystemExit(f'Expected one finalized trace for {session_id}, found {len(traces)}')
shutil.copyfile(traces[0], work / 'trace.pftrace')
if args.workflow:
    if not (work / 'additional.test.mjs').exists():
        raise SystemExit('The test worker did not produce additional.test.mjs')
    children = json.loads((work / 'subagents.json').read_text())
    if {c['role'] for c in children} != {'implementation', 'tests', 'reviewer'}:
        raise SystemExit('Workflow did not launch all three workers')
    for child in children:
        child_dir = work / 'children' / child['role']
        messages = [event['message'] for line in (child_dir / 'events.jsonl').read_text().splitlines()
                    if (event := json.loads(line)).get('type') == 'message_end'
                    and event.get('message', {}).get('role') == 'assistant']
        if not messages or messages[-1].get('stopReason') != 'stop':
            raise SystemExit(f'Child {child["role"]} did not finish successfully')
subprocess.run(['node', '--test'], cwd=work, check=True,
               stdout=(work / 'verification.log').open('w'), stderr=subprocess.STDOUT)
print(f'Completed: {work / "trace.pftrace"}', flush=True)
