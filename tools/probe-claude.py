#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Record tools, a subagent, an intentional failure and manual compaction."""
import argparse
import json
from pathlib import Path
import subprocess
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', default='haiku')
parser.add_argument('--skip-compaction', action='store_true')
args = parser.parse_args()
work = ROOT / 'artifacts/claude-probe' / uuid.uuid4().hex[:8]
task = work / 'task'
task.mkdir(parents=True)
(task / 'numbers.json').write_text('[3, 5, 8, 13, 21]\n')
(task / 'notes.txt').write_text('alpha\nbeta\ngamma\n')
prompt = '''Exercise this profiling fixture. Launch one Agent subagent to read numbers.json and independently report its sum. While it works, run two separate Bash tool calls in parallel: `sleep 0.2; wc -l notes.txt` and `sleep 0.3; python3 -c "print(sum([3,5,8,13,21]))"`.
Also run `sh -c "exit 7"` once as an intentional failed-tool fixture; do not retry or fix it. Read notes.txt using Read. Wait for the subagent and report the sum, line count, and expected failure. Do not modify files or investigate anything outside this directory.'''
(work / 'prompt.txt').write_text(prompt + '\n')
prompts = [prompt] if args.skip_compaction else [prompt, '/compact', 'Reply only: ready.']
command = [str(ROOT / 'node_modules/.bin/bun'), str(ROOT / 'tools/record-claude.ts'),
    str(work / 'trace.pftrace'), '--', '-p', '--input-format', 'stream-json',
    '--model', args.model, '--max-budget-usd', '2', '--forward-subagent-text',
    '--tools', 'Read,Bash,Agent', '--allowedTools', 'Read,Bash,Agent',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
print(f'Claude capture probe: {work}', flush=True)
with (work / 'stderr.log').open('w') as error, (work / 'events.jsonl').open('w') as output:
    process = subprocess.Popen(command, cwd=task, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=error, text=True, bufsize=1)
    timer = threading.Timer(300, process.terminate)
    timer.start()
    def send(text):
        process.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n')
        process.stdin.flush()
    send(prompts.pop(0))
    failures = []
    try:
        for line in process.stdout:
            output.write(line)
            output.flush()
            event = json.loads(line)
            if event.get('type') != 'result':
                continue
            if event.get('is_error'):
                failures.append(event.get('result', event.get('subtype')))
            if prompts and not failures:
                send(prompts.pop(0))
            else:
                process.stdin.close()
        code = process.wait()
    finally:
        timer.cancel()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
if code or failures:
    raise SystemExit(f'Claude probe failed: {failures or code}. Inspect {work}')
print(f'Completed: {work / "trace.pftrace"}', flush=True)
