# SPDX-License-Identifier: Apache-2.0
import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("build_ai_skill", Path(__file__).with_name("build-ai-skill.py"))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
REVISION = "0123456789abcdef" * 2 + "01234567"
EPOCH = 1700000000


@unittest.skipUnless((builder.CHECKOUT / "tools/release/build_ai_agents.py").is_file(),
                     "run python3 tools/perfetto setup first")
class ReleaseSkillTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = builder.build(self.root / "out", REVISION, EPOCH)

    def extract(self):
        return builder.extract_verified(self.archive, self.root / "extracted")

    def test_zip_is_one_skill_not_a_marketplace(self):
        with zipfile.ZipFile(self.archive) as bundle:
            names = bundle.namelist()
            self.assertTrue(all(name.startswith("perfetto/") for name in names))
            self.assertNotIn("perfetto/SKILL-template.md", names)
            self.assertIn("perfetto/SKILL.md", names)
            self.assertIn("perfetto/LICENSE", names)
            self.assertIn("perfetto/AGENTPROF_RELEASE.json", names)
            mode = bundle.getinfo("perfetto/bin/trace_processor").external_attr >> 16
            self.assertTrue(stat.S_ISREG(mode))
            self.assertEqual(0o755, stat.S_IMODE(mode))
        skill, metadata = self.extract()
        self.assertEqual(REVISION, metadata["agentprof_revision"])
        self.assertEqual(EPOCH, metadata["build_epoch"])
        for path in builder.OVERLAY.rglob("*"):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (skill / "workflows/agentprof" / path.relative_to(builder.OVERLAY)).read_bytes())

    def test_rebuild_is_byte_identical(self):
        second = builder.build(self.root / "second", REVISION, EPOCH)
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        self.assertEqual(self.archive.with_suffix(".zip.sha256").read_bytes(),
                         second.with_suffix(".zip.sha256").read_bytes())

    def test_checksum_mismatch_is_rejected(self):
        self.archive.with_suffix(".zip.sha256").write_text("invalid\n")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.extract()

    def test_wrapper_or_workflow_changes_are_rejected(self):
        skill, _ = self.extract()
        with patch.object(builder, "OVERLAY", self.root / "changed-overlay"):
            overlay = builder.OVERLAY
            overlay.mkdir()
            (overlay / "investigate_agent_run.md").write_text("changed source\n")
            with self.assertRaisesRegex(ValueError, "export mismatch"):
                builder.extract_verified(self.archive, self.root / "different")
        self.assertTrue((skill / "bin/trace_processor").is_file())

    def test_archive_traversal_is_rejected_before_writing(self):
        self.archive.unlink()
        with zipfile.ZipFile(self.archive, "w") as bundle:
            info = zipfile.ZipInfo("perfetto/../../escaped")
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            bundle.writestr(info, b"do not extract")
        self.archive.with_suffix(".zip.sha256").write_text(f"{builder.digest(self.archive.read_bytes())}  {self.archive.name}\n")
        with self.assertRaisesRegex(ValueError, "unsafe"):
            self.extract()
        self.assertFalse((self.root / "escaped").exists())

    def test_runtime_verification_uses_extracted_skill(self):
        calls = []
        def verify(skill, metadata):
            self.assertIn("agentprof-ai-check-", str(skill))
            self.assertEqual(REVISION, metadata["agentprof_revision"])
            self.assertTrue((skill / "workflows/agentprof/scripts/agentprof_setup.sql").is_file())
            calls.append(skill)
            return {"test": "verified"}
        with patch.object(builder, "verify_runtime", side_effect=verify):
            archive = builder.build(self.root / "verified", REVISION, EPOCH, verify=True)
        self.assertEqual(1, len(calls))
        report = json.loads((archive.parent / "agentprof-ai-skill.verification.json").read_text())
        self.assertEqual(builder.digest(archive.read_bytes()), report["archive_sha256"])

    def test_poisoned_native_cache_is_rejected_before_execution(self):
        skill, metadata = self.extract()
        native = self.root / "native"
        native.write_bytes(b"not the pinned binary")
        manifest = [{"platform": sys.platform, "machine": [builder.platform.machine().lower()],
                     "sha256": "0" * 64, "arch": "fake"}]
        module = {"TRACE_PROCESSOR_SHELL_MANIFEST": manifest,
                  "get_perfetto_prebuilt": lambda _: str(native)}
        with patch.object(builder.runpy, "run_path", return_value=module), \
             patch.object(builder.subprocess, "check_output") as execute:
            with self.assertRaisesRegex(ValueError, "cached Trace Processor"):
                builder.verify_runtime(skill, metadata)
            execute.assert_not_called()

    def test_wrong_native_version_is_rejected_before_sql_execution(self):
        skill, metadata = self.extract()
        native = self.root / "native"
        native.write_bytes(b"runtime fixture")
        manifest = [{"platform": sys.platform, "machine": [builder.platform.machine().lower()],
                     "sha256": builder.digest(native.read_bytes()), "arch": "fake"}]
        module = {"TRACE_PROCESSOR_SHELL_MANIFEST": manifest,
                  "get_perfetto_prebuilt": lambda _: str(native)}
        with patch.object(builder.runpy, "run_path", return_value=module), \
             patch.object(builder.subprocess, "check_output", return_value="Perfetto v57.1 (test)"), \
             patch.object(builder.subprocess, "run") as execute:
            with self.assertRaisesRegex(ValueError, "native Trace Processor version disagrees"):
                builder.verify_runtime(skill, metadata)
            execute.assert_not_called()

    def test_unverified_rebuild_does_not_keep_stale_runtime_report(self):
        report = self.archive.parent / "agentprof-ai-skill.verification.json"
        report.write_text("stale verification\n")
        builder.build(self.archive.parent, REVISION, EPOCH)
        self.assertFalse(report.exists())

    def test_manifest_version_mismatch_is_rejected(self):
        wrapper = builder.CHECKOUT / "tools/trace_processor"
        with self.assertRaisesRegex(ValueError, "version disagree"):
            builder.provenance(REVISION, EPOCH, wrapper, "not-the-shipped-runtime")

    def test_revision_and_epoch_are_validated(self):
        wrapper = builder.CHECKOUT / "tools/trace_processor"
        with self.assertRaisesRegex(ValueError, "full lowercase"):
            builder.provenance("HEAD", EPOCH, wrapper, "test")
        with self.assertRaisesRegex(ValueError, "nonnegative"):
            builder.provenance(REVISION, -1, wrapper, "test")


if __name__ == "__main__":
    unittest.main()
