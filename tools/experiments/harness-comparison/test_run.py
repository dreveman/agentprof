# SPDX-License-Identifier: Apache-2.0
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).with_name('run.py'))
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class ValidationTest(unittest.TestCase):
    def test_three_variants_rotate_through_every_position(self):
        orders = [comparison.variant_order(comparison.VARIANTS, n, 0) for n in range(1, 4)]
        for position in range(3):
            self.assertEqual({order[position] for order in orders}, set(comparison.VARIANTS))

    def test_script_wrappers_and_nested_executions_count_once(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            calls = [{'toolCallId': 'script', 'toolName': 'codemode'},
                     {'toolCallId': 'read', 'toolName': 'read', 'parentToolCallId': 'script'},
                     {'toolCallId': 'bash', 'toolName': 'bash', 'parentToolCallId': 'script'}]
            (work / 'events.jsonl').write_text(''.join(json.dumps(dict(call, type=kind)) + '\n'
                for kind in ['tool_execution_start', 'tool_execution_end'] for call in calls))
            self.assertEqual(comparison.execution_counts(work, 'pi', [{'name': 'codemode'}]),
                {'primaryExecutedCalls': 3, 'scriptCalls': 1, 'nestedToolCalls': 2})

    def test_failed_publication_spool_is_preserved_without_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / 'agent'
            source = agent / 'pi-tracing/.recordings/12345678-capture/process.pftrace.part'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'partial trace')
            (agent / 'auth.json').write_text('not a trace')
            comparison.retain_spool(agent, root / 'run', '12345678-session')
            output = root / 'run/capture-recovery'
            self.assertEqual([p.read_bytes() for p in output.rglob('*') if p.is_file()], [b'partial trace'])
            self.assertTrue(source.exists())

    def test_correct_answer_without_tool_work_is_not_conformant(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            _, expected, config, review, original = comparison.prepare(work, 'serial', 1)
            event = {'type': 'message_end', 'message': {'role': 'assistant', 'content': [
                {'type': 'text', 'text': json.dumps(expected)}]}}
            (work / 'events.jsonl').write_text(json.dumps(event) + '\n')
            result = comparison.validate(work, 'pi', 'serial', expected, config, review, original)
            self.assertTrue(result['correct'])
            self.assertTrue(result['protocolIssues'])

    def test_serial_probe_returns_six_measured_dependent_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            _, expected, config, _, _ = comparison.prepare(work, 'serial', 1)
            import os
            key = 'START'
            for _ in range(6):
                result = subprocess.check_output(['node', 'probe.mjs', 'step', key], cwd=work / 'task',
                    env=os.environ | {'AGENTPROF_PROBE_AUDIT': str(work / 'probe-audit.jsonl')}, text=True)
                value = json.loads(result)
                key = value.get('next', value.get('done'))
            self.assertEqual(value, expected)
            audit = comparison.events(work / 'probe-audit.jsonl')
            self.assertEqual([e['key'] for e in audit if e['phase'] == 'end'], config['chain'][:-1])
            self.assertEqual(len(audit), 12)

    def test_parallel_transcript_fragments_are_one_response(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            event = lambda block: {'type': 'assistant', 'message': {'id': 'same-response', 'content': [block]}}
            lines = [event({'type': 'text', 'text': 'running'}), *[event({'type': 'tool_use',
                'name': 'Bash', 'input': {'command': f'job {i}'}}) for i in range(4)]]
            (work / 'events.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in lines))
            result = comparison.messages(work, 'claude-code')
            self.assertEqual(len(result), 1)
            self.assertEqual(len(comparison.tool_calls(result[0])), 4)

    def test_oracle_rejects_original_broken_implementation(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            comparison.prepare(work, 'coding', 1)
            self.assertFalse(comparison.oracle(work / 'task', work / 'oracle.log'))


if __name__ == '__main__':
    unittest.main()
