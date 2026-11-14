# SPDX-License-Identifier: Apache-2.0
import importlib.machinery
import importlib.util
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("perfetto_manager", str(ROOT / "tools/perfetto"))
spec = importlib.util.spec_from_loader(loader.name, loader)
manager = importlib.util.module_from_spec(spec)
loader.exec_module(manager)


class OverlayTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.checkout = self.root / "checkout"
        self.overlays = self.root / "overlays"
        self.skills = self.root / "ai/skills/dev.agentprof/workflows"
        self.stdlib = self.root / "stdlib"
        self.workflow = self.skills / "agentprof/run.md"
        self.workflow.parent.mkdir(parents=True)
        self.workflow.write_text("# AgentProf\n")
        self.patcher = patch.multiple(manager, CHECKOUT=self.checkout,
                                      OVERLAYS=self.overlays, SKILL_WORKFLOWS=self.skills,
                                      STDLIB=self.stdlib, OUT=self.checkout / "out/agentprof")
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.destination = self.checkout / "ai/skills/perfetto/workflows/agentprof/run.md"

    def test_namespace_maps_into_single_skill(self):
        module = self.stdlib / "dev/agentprof/captures.sql"
        module.parent.mkdir(parents=True)
        module.write_text("SELECT 1;\n")
        manager.link_overlays()
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual(self.workflow.resolve(), self.destination.resolve())
        self.assertFalse(os.path.isabs(os.readlink(self.destination)))
        packaged_mod = self.checkout / "ai/skills/perfetto/workflows/agentprof/stdlib/dev/agentprof/captures.sql"
        self.assertTrue(packaged_mod.is_symlink())
        self.assertEqual(module.resolve(), packaged_mod.resolve())
        manager.link_overlays()
        self.assertEqual(self.workflow.read_text(), self.destination.read_text())

    def test_collision_preserves_existing_file_and_does_not_partially_link(self):
        first = self.skills / "agentprof/first.md"
        first.write_text("# First\n")
        self.destination.parent.mkdir(parents=True)
        self.destination.write_text("upstream\n")
        with self.assertRaisesRegex(SystemExit, "Overlay collision"):
            manager.link_overlays()
        self.assertEqual("upstream\n", self.destination.read_text())
        self.assertFalse((self.destination.parent / "first.md").exists())

    def test_broken_symlink_is_a_collision(self):
        self.destination.parent.mkdir(parents=True)
        self.destination.symlink_to("missing")
        with self.assertRaisesRegex(SystemExit, "Overlay collision"):
            manager.link_overlays()
        self.assertEqual("missing", os.readlink(self.destination))

    def test_two_overlay_roots_cannot_claim_same_destination(self):
        other = self.overlays / "ai/skills/perfetto/workflows/agentprof/run.md"
        other.parent.mkdir(parents=True)
        other.write_text("# Other\n")
        with self.assertRaisesRegex(SystemExit, "between source trees"):
            manager.link_overlays()
        self.assertFalse(self.checkout.exists())

    def prepare_sql_sources(self):
        pkg = self.stdlib / "dev/agentprof"
        pkg.mkdir(parents=True)
        (pkg / "captures.sql").write_text("SELECT 1;\n")
        return pkg

    def run_format_check(self):
        with patch.object(manager, "setup"), patch.object(manager, "run") as run, \
             patch.object(sys, "argv", ["perfetto", "check-skills-format", "--skip-deps"]), \
             patch.dict(os.environ):
            manager.main()
            return run.call_args_list

    def test_formatter_initializes_fresh_output(self):
        pkg = self.prepare_sql_sources()
        calls = self.run_format_check()
        self.assertEqual(2, len(calls))
        self.assertEqual("tools/gn", calls[0].args[1])
        self.assertEqual("--check-only", calls[1].args[2])
        self.assertEqual((pkg / "captures.sql",), calls[1].args[3:])

    def test_formatter_preserves_existing_output_configuration(self):
        self.prepare_sql_sources()
        (manager.OUT / "build.ninja").parent.mkdir(parents=True)
        (manager.OUT / "build.ninja").write_text("existing configuration\n")
        self.assertEqual(1, len(self.run_format_check()))

    def test_authored_sql_cannot_bypass_formatting(self):
        pkg = self.prepare_sql_sources()
        (pkg / "captures.sql").write_text("-- copied from an @generated query\nSELECT 1;\n")
        with self.assertRaisesRegex(SystemExit, "Authored SQL"):
            self.run_format_check()

    def test_missing_stdlib_modules_fail_format_check(self):
        with self.assertRaisesRegex(SystemExit, "Missing AgentProf PerfettoSQL"):
            self.run_format_check()

    def test_source_only_documentation_is_not_an_overlay(self):
        (self.skills.parent / "README.md").write_text("source documentation\n")
        self.assertEqual([(self.workflow, Path("ai/skills/perfetto/workflows/agentprof/run.md"))],
                         manager.overlay_files())


class PackagedSkillTest(unittest.TestCase):
    def test_upstream_packager_includes_overlay_and_stdlib_without_new_skill(self):
        checkout = ROOT / "third_party/src/perfetto"
        builder = checkout / "tools/release/build_ai_agents.py"
        if not builder.is_file():
            self.skipTest("run python3 tools/perfetto setup first")
        manager.link_overlays()
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / "assembled"
            subprocess.run([sys.executable, str(builder), "--output", str(out)],
                           cwd=checkout, check=True, capture_output=True)
            skill = out / "plugins/perfetto/skills/perfetto"
            self.assertTrue((skill / "SKILL.md").is_file())
            self.assertFalse((skill / "SKILL-template.md").exists())
            self.assertTrue(os.access(skill / "bin/trace_processor", os.X_OK))
            self.assertEqual(["perfetto"], sorted(p.name for p in skill.parent.iterdir() if p.is_dir()))
            source = ROOT / "ai/skills/dev.agentprof/workflows/agentprof"
            for path in sorted(source.rglob("*")):
                if path.is_file():
                    relative = path.relative_to(source)
                    self.assertEqual(path.read_bytes(),
                                     (skill / "workflows/agentprof" / relative).read_bytes())
            stdlib = ROOT / "stdlib"
            sql_files = sorted(stdlib.rglob("*.sql"))
            self.assertGreaterEqual(len(sql_files), 8)
            for path in sql_files:
                relative = path.relative_to(stdlib)
                self.assertEqual(path.read_bytes(),
                                 (skill / "workflows/agentprof/stdlib" / relative).read_bytes())
            pages = sorted(source.glob("*.md"))
            self.assertEqual(7, len(pages))
            router = (skill / "SKILL.md").read_text()
            for page in pages:
                self.assertIn(f"$SKILL_ROOT/workflows/agentprof/{page.name}", router)
                text = page.read_text()
                self.assertNotIn("\x00", text)
                self.assertTrue(text.startswith("# "))
                self.assertNotIn("---\nname:", text)
                for target in re.findall(r"\$SKILL_ROOT/([\w./-]+)", text):
                    self.assertTrue((skill / target).exists(), target)


class CaptureWorkflowTest(unittest.TestCase):
    def test_capture_workflow_covers_install_record_and_verify(self):
        page = (ROOT / "ai/skills/dev.agentprof/workflows/agentprof"
                / "capture_an_agent_run.md").read_text()
        # One install block per harness, with its prerequisite or trust step.
        for marker in ("pi install git:github.com/dreveman/agentprof",
                       "claude plugin install agentprof@agentprof", "2.1.289",
                       "codex plugin add agentprof@agentprof", "/hooks",
                       "muse plugins install agentprof@agentprof",
                       "muse plugins approve agentprof"):
            self.assertIn(marker, page)
        # Consent and content gates precede any install or launch.
        self.assertIn("AGENTPROF_CAPTURE_CONTENTS=0", page)
        self.assertIn("do not proceed silently", page)
        self.assertLess(page.index("AGENTPROF_CAPTURE_CONTENTS=0"),
                        page.index("pi install"))
        # Verification hands off to the investigation inventory via
        # dev.agentprof.captures, and an unfinished publication is never
        # analyzed as a finished trace.
        self.assertIn("workflows/agentprof/investigate_agent_run.md", page)
        self.assertIn("INCLUDE PERFETTO MODULE dev.agentprof.captures;", page)
        self.assertIn("dev_agentprof_inventory", page)
        self.assertIn(".pftrace.capture/", page)


if __name__ == "__main__":
    unittest.main()
