# SPDX-License-Identifier: Apache-2.0
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if "AGENTPROF_SKILL_ROOT" in os.environ:
    SKILL_ROOT = Path(os.environ["AGENTPROF_SKILL_ROOT"])
    WORKFLOWS_DIR = SKILL_ROOT / "workflows/agentprof"
    STDLIB_PKG_DIR = WORKFLOWS_DIR / "stdlib/dev/agentprof"
else:
    WORKFLOWS_DIR = ROOT / "ai/skills/dev.agentprof/workflows/agentprof"
    STDLIB_PKG_DIR = ROOT / "stdlib/dev/agentprof"

BINARY = os.environ.get("PERFETTO_TRACE_PROCESSOR")
PACKAGE_ARG = f"{STDLIB_PKG_DIR}@dev.agentprof"

_QUERY_BLOCK_RE = re.compile(
    r'trace_processor\s+query\s+--remote\s+SESSION\s+"([^"]+)"',
    re.MULTILINE,
)


def extract_workflow_queries():
    queries = []
    for page in sorted(WORKFLOWS_DIR.glob("*.md")):
        blocks = _QUERY_BLOCK_RE.findall(page.read_text())
        for idx, sql in enumerate(blocks):
            queries.append((f"{page.name}#{idx + 1}", sql.strip()))
    return queries


WORKFLOW_QUERIES = extract_workflow_queries()

# Two captures reuse the session label but are separated by more than a day.
_FIXTURE = """
INCLUDE PERFETTO MODULE dev.agentprof.captures;
INCLUDE PERFETTO MODULE dev.agentprof.models;
INCLUDE PERFETTO MODULE dev.agentprof.sessions;
INCLUDE PERFETTO MODULE dev.agentprof.tools;
INCLUDE PERFETTO MODULE dev.agentprof.context;
INCLUDE PERFETTO MODULE dev.agentprof.activity;
DROP TABLE dev_agentprof_capture_runs;
CREATE TABLE dev_agentprof_capture_runs(capture_id INTEGER, session TEXT, capture TEXT,
  recorded_id TEXT, harness TEXT, provider TEXT, model TEXT, session_labels TEXT,
  effort TEXT, turns INTEGER, responses INTEGER,
  tools INTEGER, incomplete INTEGER, start_ts INTEGER, end_ts INTEGER, duration_ms DOUBLE,
  input_tokens INTEGER, output_tokens INTEGER, peak_context INTEGER,
  context_window_tokens INTEGER, context_share DOUBLE);
INSERT INTO dev_agentprof_capture_runs VALUES
  (1,'reused','one','rec1','Pi','provider','model',NULL,'high',1,4,3,2,0,20000000,20,100,16,40,100,.4),
  (2,'reused','two','rec2','Codex','provider','model',NULL,'high',0,1,0,0,100000000000000,100000020000000,20,NULL,NULL,NULL,NULL,NULL);
DROP TABLE dev_agentprof_slices;
CREATE TABLE dev_agentprof_slices(id INTEGER, parent_id INTEGER, capture_id INTEGER,
  session TEXT, capture TEXT, ts INTEGER, dur INTEGER, incomplete INTEGER, kind TEXT,
  name TEXT, category TEXT, arg_set_id INTEGER, track_id INTEGER, track_name TEXT, upid INTEGER, utid INTEGER);
INSERT INTO dev_agentprof_slices VALUES
  (1,NULL,1,'reused','one',0,20000000,0,'prompt','prompt','pi.agent',NULL,1,'Agent',1,1),
  (2,1,1,'reused','one',1000000,5000000,0,'assistant-message','response','pi.llm',NULL,1,'Responses',1,NULL),
  (3,1,1,'reused','one',6000000,4000000,0,'tool-execution','read','pi.tools',NULL,1,'Tools',1,NULL),
  (4,1,1,'reused','one',8000000,7000000,0,'tool-execution','read','pi.tools',NULL,1,'Tools',1,NULL),
  (5,1,1,'reused','one',9000000,3000000,0,'assistant-message','response','pi.llm',NULL,1,'Responses',1,NULL),
  (6,1,1,'reused','one',18000000,2000000,1,'assistant-message','response','pi.llm',NULL,1,'Responses',1,NULL),
  (7,1,1,'reused','one',17000000,0,0,'assistant-message','completion','pi.llm',NULL,1,'Responses',1,NULL),
  (8,1,1,'reused','one',18000000,-1,1,'tool-execution','unfinished','pi.tools',NULL,1,'Tools',1,NULL),
  (9,1,1,'reused','one',0,5000000,0,'turn','native-iteration','pi.agent',NULL,1,'Agent',1,1),
  (10,NULL,2,'reused','two',100000010000000,0,0,'assistant-message','completion','codex.llm',NULL,2,'Responses',2,NULL);
DROP TABLE dev_agentprof_messages;
CREATE TABLE dev_agentprof_messages(id INTEGER, capture_id INTEGER, arg_set_id INTEGER,
  provider TEXT, model TEXT, timing TEXT, message_start_ts INTEGER, message_ns INTEGER,
  first_ns INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  incomplete INTEGER);
INSERT INTO dev_agentprof_messages VALUES
  (2,1,NULL,'provider','model','recorded-span',1000000,5000000,1000000,10,5,0,0),
  (5,1,NULL,'provider','model','recorded-span',9000000,3000000,NULL,10,0,NULL,0),
  (6,1,NULL,'provider','model','recorded-span',18000000,2000000,1000000,10,4,NULL,1),
  (7,1,NULL,'provider','model','recorded-span',17000000,NULL,NULL,10,7,NULL,0),
  (10,2,NULL,'provider','model','recorded-span',100000010000000,NULL,NULL,NULL,NULL,NULL,0);
"""


@unittest.skipUnless(BINARY, "set PERFETTO_TRACE_PROCESSOR to a local Trace Processor")
class SkillsSqlTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.empty = Path(temporary.name) / "empty.json"
        self.empty.write_text('{"traceEvents": []}')

    def query(self, sql, trace=None):
        result = subprocess.run([BINARY, "query", "--add-sql-package", PACKAGE_ARG, str(trace or self.empty)],
                                input=sql, text=True, capture_output=True, timeout=60)
        self.assertEqual(0, result.returncode, result.stderr[-4000:])
        return result.stdout

    def check(self, select_sql, condition, setup=_FIXTURE):
        out = self.query(setup + f"\nWITH result AS ({select_sql})\n"
                         f"SELECT CASE WHEN {condition} THEN 'SKILLS_OK' ELSE 'FAILED' END AS result;")
        self.assertIn("SKILLS_OK", out, out)

    def test_all_workflow_queries_on_empty_trace_and_repeat_includes(self):
        self.assertGreaterEqual(len(WORKFLOW_QUERIES), 10)
        out = self.query(
            "INCLUDE PERFETTO MODULE dev.agentprof.captures;\n"
            "INCLUDE PERFETTO MODULE dev.agentprof.captures;\n"
            "INCLUDE PERFETTO MODULE dev.agentprof.turns;\n"
            "INCLUDE PERFETTO MODULE dev.agentprof.turns;\n"
            "SELECT CASE WHEN COUNT(*) = 0 THEN 'SKILLS_OK' ELSE 'FAILED' END AS result "
            "FROM dev_agentprof_capture_runs;"
        )
        self.assertIn("SKILLS_OK", out, out[-1000:])
        for name, sql in WORKFLOW_QUERIES:
            with self.subTest(query=name):
                self.query(sql)

    def test_all_workflow_queries_on_four_reviewed_harness_recordings(self):
        for harness in ("pi", "claude", "codex", "muse"):
            source = ROOT / "examples" / ("pi-opus-5" if harness == "pi" else f"{harness}-coding")
            manifest = json.loads((source / "recording.json").read_text())
            files = manifest["bundledFiles"] if harness == "pi" else [manifest["bundledFile"]]
            for name in files:
                path = source / name
                self.assertTrue(path.is_file(), f"missing reviewed recording: {path}")
                for qname, sql in WORKFLOW_QUERIES:
                    with self.subTest(harness=harness, recording=name, query=qname):
                        self.query(sql, path)

    def test_occupancy_is_capture_scoped_and_unions_overlapping_tools(self):
        self.check("SELECT * FROM dev_agentprof_capture_occupancy", """
          (SELECT COUNT(*) FROM result) = 2 AND
          (SELECT MAX(observed_extent_ms) FROM result) = 20 AND
          (SELECT model_only_ms FROM result WHERE capture_id=1) = 5 AND
          (SELECT tool_only_ms FROM result WHERE capture_id=1) = 6 AND
          (SELECT overlap_ms FROM result WHERE capture_id=1) = 3 AND
          (SELECT unattributed_ms FROM result WHERE capture_id=1) = 6 AND
          (SELECT parallel_tool_ms FROM result WHERE capture_id=1) = 2 AND
          (SELECT peak_tools FROM result WHERE capture_id=1) = 2
        """)

    def test_scope_filter_does_not_merge_reused_session_ids(self):
        self.check(
            "SELECT * FROM dev_agentprof_capture_occupancy WHERE capture_id = 2",
            "(SELECT COUNT(*) FROM result)=1 AND (SELECT capture_id FROM result)=2",
        )

    def test_missing_duration_is_not_zero_and_zero_tokens_are_known(self):
        self.check("SELECT * FROM dev_agentprof_model_cohorts", """
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
        turns_sql = "INCLUDE PERFETTO MODULE dev.agentprof.turns;\n"
        self.check("""
          SELECT
            prompt_id,
            (display_end_ts - start_ts) / 1e6 AS observed_extent_ms,
            models_only_ns / 1e6 AS model_only_ms,
            overlap_ns / 1e6 AS overlap_ms,
            model_calls AS responses,
            unknown_models,
            unknown_tools
          FROM dev_agentprof_turns
        """, """
          (SELECT COUNT(*) FROM result) = 1 AND
          (SELECT observed_extent_ms FROM result) = 20 AND
          (SELECT model_only_ms FROM result) = 5 AND
          (SELECT overlap_ms FROM result) = 3 AND
          (SELECT responses FROM result) = 4 AND
          (SELECT unknown_models FROM result) = 2 AND
          (SELECT unknown_tools FROM result) = 1
        """, _FIXTURE + turns_sql)

    def test_incomplete_prompt_does_not_extend_to_capture_end(self):
        additions = """
          UPDATE dev_agentprof_capture_runs SET end_ts=1000000000 WHERE capture_id=1;
          INSERT INTO dev_agentprof_slices VALUES
            (20,NULL,1,'reused','one',25000000,-1,1,'prompt','prompt','pi.agent',NULL,1,'Agent',1,1),
            (21,20,1,'reused','one',26000000,-1,1,'tool-execution','unfinished','pi.tools',NULL,1,'Tools',1,NULL);
          INCLUDE PERFETTO MODULE dev.agentprof.turns;
        """
        self.check("""
          SELECT
            prompt_id,
            incomplete,
            (display_end_ts - start_ts) / 1e6 AS observed_extent_ms,
            unknown_tools
          FROM dev_agentprof_turns
        """, """
          (SELECT observed_extent_ms FROM result WHERE prompt_id=20)=1 AND
          (SELECT incomplete FROM result WHERE prompt_id=20)=1 AND
          (SELECT unknown_tools FROM result WHERE prompt_id=20)=1
        """, _FIXTURE + additions)

    def test_delegation_hierarchy_resolves_descendants(self):
        additions = """
          INSERT INTO dev_agentprof_capture_runs
            SELECT 3,'child','three','rec3',harness,provider,model,session_labels,effort,0,0,0,0,start_ts,end_ts,
              duration_ms,NULL,NULL,NULL,NULL,NULL FROM dev_agentprof_capture_runs WHERE capture_id=2;
          DROP TABLE dev_agentprof_capture_hierarchy;
          CREATE TABLE dev_agentprof_capture_hierarchy(capture_id INTEGER, root_capture_id INTEGER,
            parent_capture_id INTEGER, is_subagent INTEGER);
          INSERT INTO dev_agentprof_capture_hierarchy VALUES (1,1,NULL,0),(2,1,1,1),(3,1,2,1);
        """
        self.check("""
          WITH RECURSIVE selected(capture_id) AS (
            SELECT 2
            UNION
            SELECT h.capture_id FROM dev_agentprof_capture_hierarchy AS h
            JOIN selected AS s ON h.parent_capture_id = s.capture_id
          )
          SELECT * FROM dev_agentprof_delegation WHERE capture_id IN (SELECT capture_id FROM selected)
        """, """
          (SELECT COUNT(*) FROM result)=2 AND
          (SELECT COUNT(*) FROM result WHERE capture_id=1)=0 AND
          (SELECT COUNT(*) FROM result WHERE capture_id=3)=1
        """, _FIXTURE + additions)

    def test_prompt_and_tool_payloads_are_not_materialized_on_base_tables(self):
        for directory in ("pi-opus-5", "claude-coding", "muse-coding"):
            source = ROOT / "examples" / directory
            manifest = json.loads((source / "recording.json").read_text())
            name = manifest["bundledFiles"][0] if directory == "pi-opus-5" else manifest["bundledFile"]
            with self.subTest(harness=directory):
                out = self.query("""
                  INCLUDE PERFETTO MODULE dev.agentprof.tools;
                  INCLUDE PERFETTO MODULE dev.agentprof.turns;
                  INCLUDE PERFETTO MODULE dev.agentprof.context;
                  SELECT CASE WHEN
                    (SELECT COUNT(*) FROM dev_agentprof_tool_calls) > 0 AND
                    (SELECT COUNT(*) FROM pragma_table_info('dev_agentprof_tool_calls') WHERE name IN ('arguments', 'intent')) = 0 AND
                    (SELECT COUNT(*) FROM pragma_table_info('dev_agentprof_turns') WHERE name = 'prompt_text') = 0 AND
                    (SELECT COUNT(*) FROM pragma_table_info('dev_agentprof_context_changes') WHERE name = 'label') = 0
                  THEN 'SKILLS_OK' ELSE 'FAILED' END AS result;
                """, source / name)
                self.assertIn("SKILLS_OK", out)


class ModuleStructureTest(unittest.TestCase):
    def test_turns_module_preserves_index_hints(self):
        turns_sql = (STDLIB_PKG_DIR / "turns.sql").read_text()
        hints = re.findall(r"\bINDEXED BY (\w+)", turns_sql)
        self.assertGreaterEqual(len(hints), 4)

    def test_recordings_execute_each_workflow_query_in_its_own_cli_call(self):
        case = SkillsSqlTest("test_all_workflow_queries_on_four_reviewed_harness_recordings")
        with patch.object(case, "query", return_value="") as query:
            case.test_all_workflow_queries_on_four_reviewed_harness_recordings()
        self.assertEqual(7 * len(WORKFLOW_QUERIES), query.call_count)
        for calls in (query.call_args_list[i:i + len(WORKFLOW_QUERIES)]
                      for i in range(0, query.call_count, len(WORKFLOW_QUERIES))):
            self.assertEqual([sql for _, sql in WORKFLOW_QUERIES],
                             [call.args[0] for call in calls])


class SqlViewSemanticsTest(unittest.TestCase):
    def test_muse_child_role_metadata_is_preserved(self):
        sessions_sql = (STDLIB_PKG_DIR / "sessions.sql").read_text()
        view_sql = sessions_sql[sessions_sql.index("CREATE PERFETTO VIEW dev_agentprof_child_launches"):]
        view_sql = view_sql[:view_sql.index(";") + 1].replace("CREATE PERFETTO VIEW", "CREATE VIEW")
        with sqlite3.connect(":memory:") as db:
            args = {"debug.child_session": "child", "debug.role": "subagent"}
            db.create_function("EXTRACT_ARG", 2, lambda _, key: args.get(key))
            db.executescript("""
              CREATE TABLE dev_agentprof_slices(id INTEGER, capture_id INTEGER, session TEXT, ts INTEGER,
                name TEXT, incomplete INTEGER, dur INTEGER, arg_set_id INTEGER, category TEXT);
              INSERT INTO dev_agentprof_slices VALUES (1,1,'root',0,'delegate',0,1000000,1,'muse.workflow');
            """ + view_sql)
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute("SELECT * FROM dev_agentprof_child_launches")]
            self.assertEqual(1, len(rows))
            self.assertEqual("subagent", rows[0]["child_role"])
            self.assertEqual("child", rows[0]["child_session"])

    def test_runtime_units_and_terminal_zero_gauges(self):
        runtime_sql = (STDLIB_PKG_DIR / "runtime.sql").read_text()
        view_sql = runtime_sql[runtime_sql.index("CREATE PERFETTO VIEW dev_agentprof_runtime_summary"):]
        view_sql = view_sql[:view_sql.index(";") + 1].replace("CREATE PERFETTO VIEW", "CREATE VIEW")
        with sqlite3.connect(":memory:") as db:
            db.executescript("""
              CREATE TABLE counter(track_id INTEGER, ts INTEGER, value DOUBLE);
              CREATE TABLE dev_agentprof_counter_tracks(id INTEGER, capture_id INTEGER,
                name TEXT, display_name TEXT);
              INSERT INTO dev_agentprof_counter_tracks VALUES
                (1,1,'runtime.rss','Resident memory'),
                (2,1,'runtime.cpu','CPU time (interval)'),
                (3,2,'runtime.rss','other capture');
              INSERT INTO counter VALUES (1,10,100),(1,20,200),(1,30,0),
                (2,10,1000),(2,20,2000),(2,30,0),(3,10,99999);
            """ + view_sql)
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute("SELECT * FROM dev_agentprof_runtime_summary WHERE capture_id = 1")]
            self.assertEqual(2, len(rows))
            self.assertEqual((100, 200), (rows[0]["minimum"], rows[0]["maximum"]))
            self.assertEqual("bytes", rows[0]["unit"])
            self.assertEqual(3000, rows[1]["sampled_cpu_us"])
            self.assertEqual("us consumed since previous sample", rows[1]["unit"])


if __name__ == "__main__":
    unittest.main()
