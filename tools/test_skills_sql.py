# SPDX-License-Identifier: Apache-2.0
import json
import os
from pathlib import Path
import re
import subprocess
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = (Path(os.environ["AGENTPROF_SKILL_ROOT"]) / "workflows/agentprof/scripts"
           if "AGENTPROF_SKILL_ROOT" in os.environ
           else ROOT / "ai/skills/dev.agentprof/workflows/agentprof/scripts")
BINARY = os.environ.get("PERFETTO_TRACE_PROCESSOR")
SETUP = (SCRIPTS / "agentprof_setup.sql").read_text()
TURNS = (SCRIPTS / "agentprof_turns.sql").read_text()
QUERIES = sorted(p for p in SCRIPTS.glob("*.sql") if not p.name.startswith("agentprof_"))

# Two captures reuse the session label but are separated by more than a day.
_FIXTURE = """
DROP TABLE agentprof_skill_capture_runs;
CREATE TABLE agentprof_skill_capture_runs(capture_id INTEGER, session TEXT, capture TEXT,
  harness TEXT, provider TEXT, model TEXT, effort TEXT, turns INTEGER, responses INTEGER,
  tools INTEGER, incomplete INTEGER, start_ts INTEGER, end_ts INTEGER, duration_ms DOUBLE,
  input_tokens INTEGER, output_tokens INTEGER, peak_context INTEGER,
  context_window_tokens INTEGER, context_share DOUBLE);
INSERT INTO agentprof_skill_capture_runs VALUES
  (1,'reused','one','Pi','provider','model','high',1,4,3,2,0,20000000,20,100,16,40,100,.4),
  (2,'reused','two','Codex','provider','model','high',0,1,0,0,100000000000000,100000020000000,20,NULL,NULL,NULL,NULL,NULL);
DROP TABLE agentprof_skill_slices;
CREATE TABLE agentprof_skill_slices(id INTEGER, parent_id INTEGER, capture_id INTEGER,
  session TEXT, capture TEXT, ts INTEGER, dur INTEGER, incomplete INTEGER, kind TEXT,
  name TEXT, arg_set_id INTEGER, track_id INTEGER);
INSERT INTO agentprof_skill_slices VALUES
  (1,NULL,1,'reused','one',0,20000000,0,'prompt','prompt',NULL,1),
  (2,1,1,'reused','one',1000000,5000000,0,'assistant-message','response',NULL,1),
  (3,1,1,'reused','one',6000000,4000000,0,'tool-execution','read',NULL,1),
  (4,1,1,'reused','one',8000000,7000000,0,'tool-execution','read',NULL,1),
  (5,1,1,'reused','one',9000000,3000000,0,'assistant-message','response',NULL,1),
  (6,1,1,'reused','one',18000000,2000000,1,'assistant-message','response',NULL,1),
  (7,1,1,'reused','one',17000000,0,0,'assistant-message','completion',NULL,1),
  (8,1,1,'reused','one',18000000,-1,1,'tool-execution','unfinished',NULL,1),
  (9,1,1,'reused','one',0,5000000,0,'turn','native-iteration',NULL,1),
  (10,NULL,2,'reused','two',100000010000000,0,0,'assistant-message','completion',NULL,2);
DROP TABLE agentprof_skill_messages;
CREATE TABLE agentprof_skill_messages(id INTEGER, capture_id INTEGER, arg_set_id INTEGER,
  provider TEXT, model TEXT, message_start_ts INTEGER, message_ns INTEGER,
  first_ns INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  incomplete INTEGER);
INSERT INTO agentprof_skill_messages VALUES
  (2,1,NULL,'provider','model',1000000,5000000,1000000,10,5,0,0),
  (5,1,NULL,'provider','model',9000000,3000000,NULL,10,0,NULL,0),
  (6,1,NULL,'provider','model',18000000,2000000,1000000,10,4,NULL,1),
  (7,1,NULL,'provider','model',17000000,NULL,NULL,10,7,NULL,0),
  (10,2,NULL,'provider','model',100000010000000,NULL,NULL,NULL,NULL,NULL,0);
"""


@unittest.skipUnless(BINARY, "set PERFETTO_TRACE_PROCESSOR to a local Trace Processor")
class SkillsSqlTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.empty = Path(temporary.name) / "empty.json"
        self.empty.write_text('{"traceEvents": []}')

    def query(self, sql, trace=None):
        result = subprocess.run([BINARY, "query", str(trace or self.empty)],
                                input=sql, text=True, capture_output=True, timeout=60)
        self.assertEqual(0, result.returncode, result.stderr[-4000:])
        return result.stdout

    def query_resource(self, resource, trace=None):
        return self.query(SETUP + TURNS + resource.read_text(), trace)

    def check(self, script, condition, setup=SETUP + _FIXTURE):
        query = (SCRIPTS / script).read_text().strip().removesuffix(";")
        out = self.query(setup + f"\nWITH result AS ({query})\n"
                         f"SELECT CASE WHEN {condition} THEN 'SKILLS_OK' ELSE 'FAILED' END AS result;")
        self.assertIn("SKILLS_OK", out, out)

    def test_all_resources_on_empty_trace_and_repeat_setup(self):
        out = self.query(SETUP + SETUP + TURNS + TURNS +
                         "SELECT CASE WHEN COUNT(*) = 0 THEN 'SKILLS_OK' ELSE 'FAILED' END AS result "
                         "FROM agentprof_skill_capture_runs;")
        self.assertIn("SKILLS_OK", out, out[-1000:])
        for resource in QUERIES:
            with self.subTest(resource=resource.name):
                self.query_resource(resource)

    def test_all_resources_on_four_reviewed_harness_recordings(self):
        for harness in ("pi", "claude", "codex", "muse"):
            source = ROOT / "examples" / ("pi-opus-5" if harness == "pi" else f"{harness}-coding")
            manifest = json.loads((source / "recording.json").read_text())
            files = manifest["bundledFiles"] if harness == "pi" else [manifest["bundledFile"]]
            for name in files:
                path = source / name
                self.assertTrue(path.is_file(), f"missing reviewed recording: {path}")
                for resource in QUERIES:
                    with self.subTest(harness=harness, recording=name, resource=resource.name):
                        self.query_resource(resource, path)

    def test_occupancy_is_capture_scoped_and_unions_overlapping_tools(self):
        self.check("run_summary.sql", """
          (SELECT COUNT(*) FROM result) = 2 AND
          (SELECT MAX(observed_extent_ms) FROM result) = 20 AND
          (SELECT model_only_ms FROM result WHERE capture_id=1) = 5 AND
          (SELECT tool_only_ms FROM result WHERE capture_id=1) = 6 AND
          (SELECT overlap_ms FROM result WHERE capture_id=1) = 3 AND
          (SELECT unattributed_ms FROM result WHERE capture_id=1) = 6 AND
          (SELECT parallel_tool_ms FROM result WHERE capture_id=1) = 2 AND
          (SELECT peak_tools FROM result WHERE capture_id=1) = 2
        """)

    def test_scope_does_not_merge_reused_session_ids(self):
        self.check("run_summary.sql", "(SELECT COUNT(*) FROM result)=1 AND (SELECT capture_id FROM result)=2",
                   SETUP + _FIXTURE + "INSERT INTO agentprof_skill_scope VALUES (2);")

    def test_missing_duration_is_not_zero_and_zero_tokens_are_known(self):
        self.check("model_summary.sql", """
          (SELECT duration_samples FROM result WHERE capture_id=1) = 2 AND
          (SELECT median_ms FROM result WHERE capture_id=1) = 4 AND
          (SELECT p95_ms FROM result WHERE capture_id=1) = 5 AND
          (SELECT first_content_samples FROM result WHERE capture_id=1) = 1 AND
          (SELECT output_samples FROM result WHERE capture_id=1) = 4 AND
          (SELECT throughput_samples FROM result WHERE capture_id=1) = 2 AND
          (SELECT output_tokens_per_s FROM result WHERE capture_id=1) = 625 AND
          (SELECT duration_samples FROM result WHERE capture_id=2) = 0 AND
          (SELECT throughput_samples FROM result WHERE capture_id=2) = 0 AND
          (SELECT output_tokens_per_s FROM result WHERE capture_id=2) IS NULL
        """)

    def test_turns_are_prompts_not_native_iterations(self):
        self.check("slow_turns.sql", """
          (SELECT COUNT(*) FROM result) = 1 AND
          (SELECT observed_extent_ms FROM result) = 20 AND
          (SELECT model_only_ms FROM result) = 5 AND
          (SELECT overlap_ms FROM result) = 3 AND
          (SELECT responses FROM result) = 4 AND
          (SELECT unknown_models FROM result) = 2 AND
          (SELECT unknown_tools FROM result) = 1
        """, SETUP + _FIXTURE + TURNS)

    def test_incomplete_prompt_does_not_extend_to_capture_end(self):
        additions = """
          UPDATE agentprof_skill_capture_runs SET end_ts=1000000000 WHERE capture_id=1;
          INSERT INTO agentprof_skill_slices VALUES
            (20,NULL,1,'reused','one',25000000,-1,1,'prompt','prompt',NULL,1),
            (21,20,1,'reused','one',26000000,-1,1,'tool-execution','unfinished',NULL,1);
        """
        self.check("slow_turns.sql", """
          (SELECT observed_extent_ms FROM result WHERE prompt_id=20)=1 AND
          (SELECT incomplete FROM result WHERE prompt_id=20)=1 AND
          (SELECT unknown_tools FROM result WHERE prompt_id=20)=1
        """, SETUP + _FIXTURE + additions + TURNS)

    def test_selecting_middle_parent_includes_descendants(self):
        additions = """
          INSERT INTO agentprof_skill_capture_runs
            SELECT 3,'child','three',harness,provider,model,effort,0,0,0,0,start_ts,end_ts,
              duration_ms,NULL,NULL,NULL,NULL,NULL FROM agentprof_skill_capture_runs WHERE capture_id=2;
          DROP TABLE agentprof_skill_capture_hierarchy;
          CREATE TABLE agentprof_skill_capture_hierarchy(capture_id INTEGER, root_capture_id INTEGER,
            parent_capture_id INTEGER, is_subagent INTEGER);
          INSERT INTO agentprof_skill_capture_hierarchy VALUES (1,1,NULL,0),(2,1,1,1),(3,1,2,1);
          INSERT INTO agentprof_skill_scope VALUES (2);
        """
        self.check("delegation.sql", """
          (SELECT COUNT(*) FROM result)=2 AND
          (SELECT COUNT(*) FROM result WHERE capture_id=1)=0 AND
          (SELECT COUNT(*) FROM result WHERE capture_id=3)=1
        """, SETUP + _FIXTURE + additions)

    def test_workflow_namespace_preserves_ui_objects(self):
        out = self.query("CREATE TABLE agentprof_slices(value INTEGER); INSERT INTO agentprof_slices VALUES (42);" +
                         SETUP + TURNS + "SELECT CASE WHEN (SELECT value FROM agentprof_slices)=42 "
                         "THEN 'SKILLS_OK' ELSE 'FAILED' END AS result;")
        self.assertIn("SKILLS_OK", out)

    def test_prompt_and_tool_payloads_are_not_materialized(self):
        for directory in ("pi-opus-5", "claude-coding", "muse-coding"):
            source = ROOT / "examples" / directory
            manifest = json.loads((source / "recording.json").read_text())
            name = manifest["bundledFiles"][0] if directory == "pi-opus-5" else manifest["bundledFile"]
            with self.subTest(harness=directory):
                out = self.query(SETUP + TURNS + """
                  SELECT CASE WHEN
                    (SELECT COUNT(*) FROM agentprof_skill_tool_calls)>0 AND
                    (SELECT COUNT(*) FROM agentprof_skill_turn_prompts WHERE prompt_text IS NOT NULL)=0 AND
                    (SELECT COUNT(*) FROM agentprof_skill_tool_calls WHERE intent IS NOT NULL)=0 AND
                    (SELECT COUNT(*) FROM agentprof_skill_tool_arguments)=0
                  THEN 'SKILLS_OK' ELSE 'FAILED' END AS result;
                """, source / name)
                self.assertIn("SKILLS_OK", out)


class ResourceInvocationTest(unittest.TestCase):
    def test_generated_turn_setup_preserves_reader_index_hints(self):
        reader = (ROOT / "third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/turns_queries.ts").read_text()
        expected = [name.replace("agentprof_", "agentprof_skill_", 1)
                    for name in re.findall(r"\bINDEXED BY (\w+)", reader)]
        self.assertTrue(expected)
        self.assertEqual(expected, re.findall(r"\bINDEXED BY (\w+)", TURNS))
        self.assertIn("@generated by tools/generate-skills-sql.ts", TURNS)
        self.assertIn("@generated by tools/generate-skills-sql.ts", SETUP)

    def test_recordings_execute_each_resource_in_its_own_cli_call(self):
        case = SkillsSqlTest("test_all_resources_on_four_reviewed_harness_recordings")
        with patch.object(case, "query", return_value="") as query:
            case.test_all_resources_on_four_reviewed_harness_recordings()
        self.assertEqual(7 * len(QUERIES), query.call_count)
        for calls in (query.call_args_list[i:i + len(QUERIES)]
                      for i in range(0, query.call_count, len(QUERIES))):
            self.assertEqual([SETUP + TURNS + resource.read_text() for resource in QUERIES],
                             [call.args[0] for call in calls])

    def test_empty_results_do_not_hide_batched_output(self):
        case = SkillsSqlTest("test_all_resources_on_empty_trace_and_repeat_setup")
        with patch.object(case, "query", return_value="| result |\n|---|\n| SKILLS_OK |\n") as query:
            case.test_all_resources_on_empty_trace_and_repeat_setup()
        self.assertEqual(1 + len(QUERIES), query.call_count)
        self.assertEqual(SETUP + SETUP + TURNS + TURNS +
                         "SELECT CASE WHEN COUNT(*) = 0 THEN 'SKILLS_OK' ELSE 'FAILED' END AS result "
                         "FROM agentprof_skill_capture_runs;",
                         query.call_args_list[0].args[0])
        self.assertEqual([SETUP + TURNS + resource.read_text() for resource in QUERIES],
                         [call.args[0] for call in query.call_args_list[1:]])


class ResourceQueryTest(unittest.TestCase):
    def test_muse_child_role_metadata_is_preserved(self):
        with sqlite3.connect(":memory:") as db:
            args = {"debug.child_session": "child", "debug.role": "subagent"}
            db.create_function("EXTRACT_ARG", 2, lambda _, key: args.get(key))
            db.executescript("""
              CREATE TABLE agentprof_skill_slices(id INTEGER, capture_id INTEGER, ts INTEGER,
                name TEXT, incomplete INTEGER, dur INTEGER, arg_set_id INTEGER, category TEXT);
              CREATE TABLE agentprof_skill_selected_captures(capture_id INTEGER);
              INSERT INTO agentprof_skill_selected_captures VALUES (1);
              INSERT INTO agentprof_skill_slices VALUES (1,1,0,'delegate',0,1000000,1,'muse.workflow');
            """)
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute((SCRIPTS / "child_launches.sql").read_text())]
            self.assertEqual(1, len(rows))
            self.assertEqual("subagent", rows[0]["child_role"])
            self.assertEqual("child", rows[0]["child_session"])

    def test_runtime_units_and_terminal_zero_gauges(self):
        with sqlite3.connect(":memory:") as db:
            db.executescript("""
              CREATE TABLE counter(track_id INTEGER, ts INTEGER, value DOUBLE);
              CREATE TABLE agentprof_skill_counter_tracks(id INTEGER, capture_id INTEGER,
                name TEXT, display_name TEXT);
              CREATE TABLE agentprof_skill_selected_captures(capture_id INTEGER);
              INSERT INTO agentprof_skill_selected_captures VALUES (1);
              INSERT INTO agentprof_skill_counter_tracks VALUES
                (1,1,'runtime.rss','Resident memory'),
                (2,1,'runtime.cpu','CPU time (interval)'),
                (3,2,'runtime.rss','other capture');
              INSERT INTO counter VALUES (1,10,100),(1,20,200),(1,30,0),
                (2,10,1000),(2,20,2000),(2,30,0),(3,10,99999);
            """)
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute((SCRIPTS / "runtime_summary.sql").read_text())]
            self.assertEqual(2, len(rows))
            self.assertEqual((100, 200), (rows[0]["minimum"], rows[0]["maximum"]))
            self.assertEqual("bytes", rows[0]["unit"])
            self.assertEqual(3000, rows[1]["sampled_cpu_us"])
            self.assertEqual("us consumed since previous sample", rows[1]["unit"])


if __name__ == "__main__":
    unittest.main()
