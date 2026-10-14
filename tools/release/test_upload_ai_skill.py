# SPDX-License-Identifier: Apache-2.0
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("upload_ai_skill", Path(__file__).with_name("upload-ai-skill.py"))
uploader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(uploader)


class UploadSkillTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        provenance = json.dumps({"perfetto_version": "v57.2",
            "trace_processor_prebuilts": [{"arch": "linux-amd64", "sha256": "a" * 64}]})
        with zipfile.ZipFile(self.root / uploader.ASSETS[0], "w") as archive:
            archive.writestr("perfetto/AGENTPROF_RELEASE.json", provenance)
        checksum = uploader.hashlib.sha256((self.root / uploader.ASSETS[0]).read_bytes()).hexdigest()
        (self.root / uploader.ASSETS[1]).write_text(f"{checksum}  {uploader.ASSETS[0]}\n")
        (self.root / uploader.ASSETS[2]).write_text(provenance)
        (self.root / uploader.ASSETS[3]).write_text(json.dumps({"archive_sha256": checksum,
            "runtime": {"warm_session": True, "packaged_sql_tests": True,
                        "native_version": "Perfetto v57.2 (test)", "native_sha256": "a" * 64,
                        "platform": "linux-amd64"}}))
        self.existing = set()
        self.mismatch = False
        self.draft = False
        self.calls = []

    def gh(self, *args):
        self.calls.append(args)
        if args[:2] == ("release", "view"):
            return json.dumps({"isDraft": self.draft, "tagName": "v1.0",
                               "assets": [{"name": name} for name in self.existing]})
        if args[:2] == ("release", "download"):
            destination = Path(args[args.index("--dir") + 1])
            for name in self.existing:
                (destination / name).write_bytes(b"different" if self.mismatch
                                                else (self.root / name).read_bytes())
        return ""

    def upload(self, publish=False):
        with patch.object(uploader, "gh", side_effect=self.gh):
            return uploader.upload("owner/repo", "v1.0", self.root, publish)

    def test_default_is_dry_run(self):
        self.assertEqual(list(uploader.ASSETS), self.upload())
        self.assertFalse(any(call[:2] == ("release", "upload") for call in self.calls))

    def test_first_publication_uploads_all_assets(self):
        self.assertEqual(list(uploader.ASSETS), self.upload(publish=True))
        call = next(call for call in self.calls if call[:2] == ("release", "upload"))
        self.assertNotIn("--clobber", call)

    def test_matching_complete_rerun_does_not_upload(self):
        self.existing = set(uploader.ASSETS)
        self.assertEqual([], self.upload(publish=True))
        self.assertFalse(any(call[:2] == ("release", "upload") for call in self.calls))

    def test_partial_upload_recovers_only_missing_assets(self):
        self.existing = {uploader.ASSETS[0], uploader.ASSETS[1]}
        self.assertEqual(list(uploader.ASSETS[2:]), self.upload(publish=True))
        call = next(call for call in self.calls if call[:2] == ("release", "upload"))
        self.assertNotIn(self.root / uploader.ASSETS[0], call)
        self.assertIn(self.root / uploader.ASSETS[2], call)

    def test_mismatch_refuses_every_upload(self):
        self.existing = {uploader.ASSETS[0]}
        self.mismatch = True
        with self.assertRaisesRegex(ValueError, "refusing overwrite"):
            self.upload(publish=True)
        self.assertFalse(any(call[:2] == ("release", "upload") for call in self.calls))

    def test_draft_release_is_not_published(self):
        self.draft = True
        with self.assertRaisesRegex(ValueError, "published release"):
            self.upload(publish=True)
        self.assertFalse(any(call[:2] == ("release", "upload") for call in self.calls))

    def test_changed_provenance_prevents_any_remote_call(self):
        (self.root / uploader.ASSETS[2]).write_text("stale provenance")
        with self.assertRaisesRegex(ValueError, "checksum-bound archive"):
            self.upload(publish=True)
        self.assertEqual([], self.calls)

    def test_truthy_nonboolean_verification_is_rejected(self):
        path = self.root / uploader.ASSETS[3]
        report = json.loads(path.read_text())
        report["runtime"]["warm_session"] = "false"
        report["runtime"]["packaged_sql_tests"] = "false"
        path.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, "matching runtime verification"):
            self.upload(publish=True)
        self.assertEqual([], self.calls)

    def test_wrong_native_identity_is_rejected(self):
        path = self.root / uploader.ASSETS[3]
        report = json.loads(path.read_text())
        report["runtime"]["native_version"] = "Perfetto v57.1 (test)"
        path.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, "matching runtime verification"):
            self.upload(publish=True)
        self.assertEqual([], self.calls)

    def test_missing_provenance_prevents_any_remote_call(self):
        (self.root / uploader.ASSETS[2]).unlink()
        with self.assertRaisesRegex(ValueError, "all four"):
            self.upload(publish=True)
        self.assertEqual([], self.calls)

    def test_missing_runtime_verification_is_not_published(self):
        (self.root / uploader.ASSETS[3]).write_text(json.dumps({"archive_sha256": "wrong",
            "runtime": {"warm_session": True, "packaged_sql_tests": True}}))
        with self.assertRaisesRegex(ValueError, "matching runtime verification"):
            self.upload(publish=True)
        self.assertEqual([], self.calls)


if __name__ == "__main__":
    unittest.main()
