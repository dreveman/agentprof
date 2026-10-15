#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Upload verified AI skill assets to an existing published GitHub release."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

ASSETS = ("agentprof-ai-skill.zip", "agentprof-ai-skill.zip.sha256",
          "agentprof-ai-skill.provenance.json", "agentprof-ai-skill.verification.json")


def gh(*args):
    return subprocess.check_output(["gh", *map(str, args)], text=True)


def upload(repo, tag, directory, publish=False):
    files = {name: directory / name for name in ASSETS}
    if any(not path.is_file() for path in files.values()):
        raise ValueError("all four verified release assets are required")
    checksum = hashlib.sha256(files[ASSETS[0]].read_bytes()).hexdigest()
    if files[ASSETS[1]].read_text().strip() != f"{checksum}  {ASSETS[0]}":
        raise ValueError("local archive checksum mismatch")
    provenance_bytes = files[ASSETS[2]].read_bytes()
    with zipfile.ZipFile(files[ASSETS[0]]) as archive:
        if provenance_bytes != archive.read("perfetto/AGENTPROF_RELEASE.json"):
            raise ValueError("provenance differs from the checksum-bound archive")
    provenance = json.loads(provenance_bytes)
    report = json.loads(files[ASSETS[3]].read_text())
    runtime = report["runtime"]
    matching_prebuilt = any(item["arch"] == runtime.get("platform")
                            and item["sha256"] == runtime.get("native_sha256")
                            for item in provenance["trace_processor_prebuilts"])
    if (report["archive_sha256"] != checksum or runtime.get("warm_session") is not True
            or runtime.get("packaged_sql_tests") is not True or not matching_prebuilt
            or re.findall(r"\bv\d+(?:\.\d+)+\b", runtime.get("native_version", ""))
                != [provenance["perfetto_version"]]):
        raise ValueError("artifact has no matching runtime verification")
    release = json.loads(gh("release", "view", tag, "--repo", repo,
                            "--json", "isDraft,tagName,assets"))
    if release["isDraft"] or release["tagName"] != tag:
        raise ValueError("target must be the existing published release")
    existing = {asset["name"] for asset in release["assets"]} & files.keys()
    if existing:
        with tempfile.TemporaryDirectory(prefix="agentprof-ai-existing-") as temporary:
            arguments = ["release", "download", tag, "--repo", repo, "--dir", temporary]
            for name in sorted(existing):
                arguments.extend(("--pattern", name))
            gh(*arguments)
            for name in existing:
                if files[name].read_bytes() != (Path(temporary) / name).read_bytes():
                    raise ValueError(f"existing release asset differs: {name}; refusing overwrite")
    missing = [files[name] for name in ASSETS if name not in existing]
    if publish and missing:
        gh("release", "upload", tag, *missing, "--repo", repo)
    print(f"{len(existing)} matching assets; {len(missing)} {'uploaded' if publish else 'would upload'}")
    return [path.name for path in missing]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--publish", action="store_true", help="upload missing assets after checking existing ones")
    args = parser.parse_args()
    upload(args.repo, args.tag, args.dir, args.publish)


if __name__ == "__main__":
    main()
