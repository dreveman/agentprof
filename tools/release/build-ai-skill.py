#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Package Perfetto's assembled skill with the AgentProf workflow overlay."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import runpy
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CHECKOUT = ROOT / "third_party/src/perfetto"
OVERLAY = ROOT / "ai/skills/dev.agentprof/workflows/agentprof"
ARCHIVE = "agentprof-ai-skill.zip"
PROVENANCE = "AGENTPROF_RELEASE.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def wrapper_manifest(wrapper):
    return runpy.run_path(str(wrapper))["TRACE_PROCESSOR_SHELL_MANIFEST"]


def provenance(revision, epoch, wrapper, perfetto_version):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("revision must be a full lowercase 40-character commit SHA")
    if epoch < 0:
        raise ValueError("epoch must be nonnegative")
    manifest = wrapper_manifest(wrapper)
    expected_version = json.loads((CHECKOUT / "ai/extensions/claude-code/plugin.json").read_text())["version"]
    if perfetto_version != expected_version or any(f"/{perfetto_version}/" not in item["url"] for item in manifest):
        raise ValueError("Perfetto manifests and bundled runtime version disagree")
    return {
        "agentprof_revision": revision,
        "agentprof_version": json.loads((ROOT / "package.json").read_text())["version"],
        "perfetto_pin": tomllib.loads((ROOT / "third_party/perfetto.toml").read_text())["perfetto"]["pin"],
        "perfetto_version": perfetto_version,
        "build_epoch": epoch,
        "trace_processor_wrapper_sha256": digest(wrapper.read_bytes()),
        "trace_processor_prebuilts": manifest,
    }


def write_archive(skill, archive, metadata):
    timestamp = time.gmtime(max(315532800, metadata["build_epoch"]))[:6]
    if timestamp[0] > 2107:
        raise ValueError("epoch exceeds ZIP's timestamp range")
    (skill / "LICENSE").write_bytes((ROOT / "LICENSE").read_bytes())
    (skill / PROVENANCE).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path in sorted(skill.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"unexpected symlink in assembled skill: {path.name}")
            if not path.is_file():
                continue
            mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
            info = zipfile.ZipInfo("perfetto/" + path.relative_to(skill).as_posix(), timestamp)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(info, path.read_bytes(), compresslevel=9)
    checksum = digest(archive.read_bytes())
    archive.with_suffix(".zip.sha256").write_text(f"{checksum}  {archive.name}\n")
    return checksum


def extract_verified(archive, destination):
    expected = archive.with_suffix(".zip.sha256").read_text().strip()
    if expected != f"{digest(archive.read_bytes())}  {archive.name}":
        raise ValueError("archive checksum mismatch")
    with zipfile.ZipFile(archive) as bundle:
        seen = set()
        for info in bundle.infolist():
            path = PurePosixPath(info.filename)
            mode = info.external_attr >> 16
            if (path.is_absolute() or ".." in path.parts or "\\" in info.filename
                    or not path.parts or path.parts[0] != "perfetto"
                    or path.as_posix() != info.filename or info.filename in seen
                    or not stat.S_ISREG(mode) or stat.S_IMODE(mode) not in (0o644, 0o755)):
                raise ValueError(f"unsafe or duplicate ZIP entry: {info.filename}")
            seen.add(info.filename)
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(info))
            target.chmod(mode & 0o777)
    skill = destination / "perfetto"
    metadata = json.loads((skill / PROVENANCE).read_text())
    if (skill / "SKILL-template.md").exists() or not (skill / "SKILL.md").is_file():
        raise ValueError("expected one assembled perfetto skill, not a source template")
    router = (skill / "SKILL.md").read_text()
    if not router.startswith("---\nname: perfetto\n"):
        raise ValueError("invalid skill identity")
    if (skill / "LICENSE").read_bytes() != (ROOT / "LICENSE").read_bytes():
        raise ValueError("license mismatch")
    wrapper = skill / "bin/trace_processor"
    if (wrapper.read_bytes() != (CHECKOUT / "tools/trace_processor").read_bytes()
            or not wrapper.stat().st_mode & stat.S_IXUSR):
        raise ValueError("bundled wrapper must be upstream-identical and executable")
    expected_metadata = provenance(metadata["agentprof_revision"], metadata["build_epoch"],
                                   wrapper, metadata["perfetto_version"])
    if metadata != expected_metadata:
        raise ValueError("release provenance mismatch")
    for source in sorted(OVERLAY.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(OVERLAY)
        packaged = skill / "workflows/agentprof" / relative
        if packaged.read_bytes() != source.read_bytes():
            raise ValueError(f"workflow export mismatch: {relative}")
        if source.suffix == ".md":
            if f"$SKILL_ROOT/workflows/agentprof/{relative.as_posix()}" not in router:
                raise ValueError(f"missing workflow route: {relative}")
            for target in re.findall(r"\$SKILL_ROOT/([\w./-]+)", source.read_text()):
                if not (skill / target).is_file():
                    raise ValueError(f"missing workflow resource: {target}")
    return skill, metadata


def verify_runtime(skill, metadata):
    wrapper = skill / "bin/trace_processor"
    module = runpy.run_path(str(wrapper))
    manifest = module["TRACE_PROCESSOR_SHELL_MANIFEST"]
    entry = next(item for item in manifest if item.get("platform") == sys.platform.lower()
                 and platform.machine().lower() in item.get("machine", []))
    # Independently hash the cache entry before executing it; the upstream
    # launcher trusts SHA-named files already present in its cache.
    native = Path(module["get_perfetto_prebuilt"](manifest))
    if digest(native.read_bytes()) != entry["sha256"]:
        raise ValueError("cached Trace Processor does not match the bundled manifest")
    version = subprocess.check_output([str(wrapper), "--version"], text=True, timeout=60).strip()
    if re.findall(r"\bv\d+(?:\.\d+)+\b", version) != [metadata["perfetto_version"]]:
        raise ValueError(f"native Trace Processor version disagrees with {metadata['perfetto_version']}: {version}")
    subprocess.run([str(wrapper), "query", "--help"], check=True, capture_output=True, timeout=60)
    env = {**os.environ, "PERFETTO_TRACE_PROCESSOR": str(wrapper), "AGENTPROF_SKILL_ROOT": str(skill)}
    subprocess.run([sys.executable, str(ROOT / "tools/test_skills_sql.py")], env=env, check=True, timeout=300)
    with tempfile.TemporaryDirectory(prefix="ap-ai-") as temporary:
        root = Path(temporary)
        trace = root / "empty.json"
        trace.write_text('{"traceEvents": []}')
        socket = root / "trace.sock"
        log = root / "server.log"
        with log.open("w") as output:
            server = subprocess.Popen([str(wrapper), "server", "unix", "--path", str(socket),
                                       "--idle-timeout", "60s", str(trace)],
                                      stdout=output, stderr=output)
            try:
                deadline = time.monotonic() + 30
                while not socket.exists():
                    if server.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError(f"packaged warm session failed: {log.read_text()}")
                    time.sleep(.05)
                for script in ("agentprof_setup.sql", "agentprof_turns.sql", "inventory.sql"):
                    subprocess.run([str(wrapper), "query", "--remote", str(socket), "--query-file",
                                    str(skill / "workflows/agentprof/scripts" / script)],
                                   check=True, capture_output=True, timeout=60)
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=10)
    return {"native_version": version, "native_sha256": entry["sha256"],
            "platform": entry["arch"], "packaged_sql_tests": True, "warm_session": True}


def build(out, revision, epoch, verify=False):
    out.mkdir(parents=True, exist_ok=True)
    (out / "agentprof-ai-skill.verification.json").unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="agentprof-ai-build-") as temporary:
        assembled = Path(temporary) / "assembled"
        subprocess.run([sys.executable, str(CHECKOUT / "tools/release/build_ai_agents.py"),
                        "--output", str(assembled)], check=True, cwd=CHECKOUT)
        skill = assembled / "plugins/perfetto/skills/perfetto"
        metadata = provenance(revision, epoch, skill / "bin/trace_processor",
                              json.loads((assembled / "BRANCH_METADATA.json").read_text())["tag"])
        archive = out / ARCHIVE
        checksum = write_archive(skill, archive, metadata)
        (out / "agentprof-ai-skill.provenance.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    with tempfile.TemporaryDirectory(prefix="agentprof-ai-check-") as temporary:
        skill, metadata = extract_verified(archive, Path(temporary))
        if verify:
            runtime = verify_runtime(skill, metadata)
            report = {"archive_sha256": checksum, "runtime": runtime}
            (out / "agentprof-ai-skill.verification.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"Built {archive} ({checksum})")
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/ai-release")
    parser.add_argument("--revision", required=True, help="full AgentProf source commit SHA")
    parser.add_argument("--epoch", required=True, type=int, help="source commit Unix timestamp (SOURCE_DATE_EPOCH)")
    parser.add_argument("--verify", action="store_true", help="verify the exact packaged runtime (may download its pinned prebuilt)")
    args = parser.parse_args()
    build(args.out, args.revision, args.epoch, args.verify)


if __name__ == "__main__":
    main()
