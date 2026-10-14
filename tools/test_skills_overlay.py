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
        self.workflow = self.skills / "agentprof/run.md"
        self.workflow.parent.mkdir(parents=True)
        self.workflow.write_text("# AgentProf\n")
        self.patcher = patch.multiple(manager, CHECKOUT=self.checkout,
                                      OVERLAYS=self.overlays, SKILL_WORKFLOWS=self.skills)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.destination = self.checkout / "ai/skills/perfetto/workflows/agentprof/run.md"

    def test_namespace_maps_into_single_skill(self):
        manager.link_overlays()
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual(self.workflow.resolve(), self.destination.resolve())
        self.assertFalse(os.path.isabs(os.readlink(self.destination)))
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

    def test_source_only_documentation_is_not_an_overlay(self):
        (self.skills.parent / "README.md").write_text("source documentation\n")
        self.assertEqual([(self.workflow, Path("ai/skills/perfetto/workflows/agentprof/run.md"))],
                         manager.overlay_files())


class PackagedSkillTest(unittest.TestCase):
    def test_upstream_packager_includes_overlay_without_new_skill(self):
        checkout = ROOT / "third_party/src/perfetto"
        builder = checkout / "tools/release/build_ai_agents.py"
        if not builder.is_file():
            self.skipTest("run python3 tools/perfetto setup first")
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
            pages = sorted(source.glob("*.md"))
            self.assertEqual(6, len(pages))
            router = (skill / "SKILL.md").read_text()
            for page in pages:
                self.assertIn(f"$SKILL_ROOT/workflows/agentprof/{page.name}", router)
                text = page.read_text()
                self.assertNotIn("\x00", text)
                self.assertTrue(text.startswith("# "))
                self.assertNotIn("---\nname:", text)
                for target in re.findall(r"\$SKILL_ROOT/([\w./-]+)", text):
                    self.assertTrue((skill / target).exists(), target)


if __name__ == "__main__":
    unittest.main()
