#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Stages a verified AgentProf web UI bundle for the iOS app (`ios/build/AgentProfWeb`).

By default, stages the local UI build produced by:

    python3 tools/perfetto build-ui --no-source-maps

Or pass `--fetch` to download and SHA-256-verify the published UI from
`https://agentprof-ui.pages.dev` without compiling C++/WebAssembly locally.

iOS WebKit does not support WebAssembly memory64, so the staged UI must include
the 32-bit `trace_processor.wasm` binary (omitted by `--only-wasm-memory64`
developer builds). Source maps and service workers are excluded.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request

DEFAULT_SITE_URL = "https://agentprof-ui.pages.dev"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DIST = os.path.join(
    REPO_ROOT, "third_party", "src", "perfetto", "out", "agentprof", "ui", "dist"
)
DEFAULT_OUT = os.path.join(REPO_ROOT, "ios", "build", "AgentProfWeb")

REQUIRED_RESOURCES = [
    "frontend_bundle.js",
    "engine_bundle.js",
    "frontend.css",
    "trace_processor.wasm",
    "assets/MaterialSymbolsOutlined.woff2",
    "assets/agentprof-icon.svg",
]

VERSION_RE = re.compile(r"^v[0-9A-Za-z._-]+$")
SAFE_PATH_RE = re.compile(r"^(?!\.)[0-9A-Za-z._-]+(/(?!\.)[0-9A-Za-z._-]+)*$")
VERSION_ATTR_RE = re.compile(r"data-perfetto_version='([^']*)'")


class PrepareError(Exception):
    """Raised when a UI build is missing, incomplete, or fails integrity checks."""


def parse_stable_version(index_html: str) -> str:
    matches = VERSION_ATTR_RE.findall(index_html)
    if len(matches) != 1:
        raise PrepareError(
            f"index.html has {len(matches)} data-perfetto_version attributes, expected 1"
        )
    try:
        channels = json.loads(matches[0])
    except json.JSONDecodeError as exc:
        raise PrepareError(f"invalid data-perfetto_version JSON: {exc}") from exc
    stable = channels.get("stable", "") if isinstance(channels, dict) else ""
    if not isinstance(stable, str) or not VERSION_RE.match(stable):
        raise PrepareError(f"unexpected stable UI version: {stable!r}")
    return stable


def boot_index(index_html: str, version: str) -> str:
    channels = json.dumps({"stable": version}, separators=(",", ":"))
    filled, count = VERSION_ATTR_RE.subn(
        lambda _: f"data-perfetto_version='{channels}'", index_html
    )
    if count != 1:
        raise PrepareError(
            f"index.html has {count} data-perfetto_version attributes, expected 1"
        )
    return filled


def sha256_sri(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256-" + base64.b64encode(digest).decode("ascii")


def validate_manifest(manifest_bytes: bytes) -> dict[str, str]:
    try:
        parsed = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PrepareError(f"invalid manifest.json: {exc}") from exc
    resources = parsed.get("resources") if isinstance(parsed, dict) else None
    if not isinstance(resources, dict) or not resources:
        raise PrepareError("manifest.json has no resources map")
    validated: dict[str, str] = {}
    for rel_path, expected in resources.items():
        if not isinstance(rel_path, str) or not SAFE_PATH_RE.match(rel_path):
            raise PrepareError(f"unsafe resource path in manifest.json: {rel_path!r}")
        if not isinstance(expected, str) or not expected.startswith("sha256-"):
            raise PrepareError(f"missing sha256 integrity for {rel_path}")
        validated[rel_path] = expected
    missing = [req for req in REQUIRED_RESOURCES if req not in validated]
    if missing:
        hint = (
            " (iOS requires 32-bit trace_processor.wasm; build without --only-wasm-memory64)"
            if "trace_processor.wasm" in missing
            else ""
        )
        raise PrepareError(f"UI build is missing {', '.join(missing)}{hint}")
    return dict(sorted(validated.items()))


def stage_from_dist(dist_dir: str, out_dir: str, version_override: str | None = None) -> str:
    root_index_path = os.path.join(dist_dir, "index.html")
    if not os.path.isfile(root_index_path):
        raise PrepareError(
            f"{root_index_path} not found; run `python3 tools/perfetto build-ui --no-source-maps` "
            "or pass `--fetch`"
        )
    with open(root_index_path, encoding="utf-8") as handle:
        root_index_html = handle.read()

    version = version_override or parse_stable_version(root_index_html)
    if not VERSION_RE.match(version):
        raise PrepareError(f"invalid version {version!r}")

    version_dir = os.path.join(dist_dir, version)
    manifest_path = os.path.join(version_dir, "manifest.json")
    version_index_path = os.path.join(version_dir, "index.html")
    if not os.path.isfile(manifest_path):
        raise PrepareError(f"missing {manifest_path}")
    if not os.path.isfile(version_index_path):
        raise PrepareError(f"missing {version_index_path}")

    with open(manifest_path, "rb") as handle:
        manifest_bytes = handle.read()
    resources = validate_manifest(manifest_bytes)

    with open(version_index_path, encoding="utf-8") as handle:
        version_index_html = handle.read()
    booted_html = boot_index(version_index_html, version)

    # Verify every file in the version directory before modifying out_dir.
    for root, _dirs, names in os.walk(version_dir):
        for name in names:
            if name.endswith(".map") or name in ("index.html", "manifest.json"):
                continue
            full_path = os.path.join(root, name)
            rel_path = os.path.relpath(full_path, version_dir).replace(os.sep, "/")
            if not SAFE_PATH_RE.match(rel_path):
                raise PrepareError(f"unexpected file path in {version}: {rel_path!r}")
            if rel_path not in resources:
                raise PrepareError(f"unlisted file in {version}: {rel_path}")

    parent_dir = os.path.dirname(os.path.abspath(out_dir))
    os.makedirs(parent_dir, exist_ok=True)
    staging_parent = tempfile.mkdtemp(prefix=".agentprof-web-", dir=parent_dir)
    staging_out = os.path.join(staging_parent, "AgentProfWeb")
    try:
        out_version_dir = os.path.join(staging_out, version)
        os.makedirs(out_version_dir, exist_ok=True)

        for rel_path, expected_sri in resources.items():
            src_path = os.path.join(version_dir, *rel_path.split("/"))
            if not os.path.isfile(src_path):
                raise PrepareError(f"manifest resource missing on disk: {rel_path}")
            with open(src_path, "rb") as handle:
                payload = handle.read()
            actual_sri = sha256_sri(payload)
            if actual_sri != expected_sri:
                raise PrepareError(
                    f"{rel_path} integrity mismatch: expected {expected_sri}, got {actual_sri}"
                )
            dst_path = os.path.join(out_version_dir, *rel_path.split("/"))
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            with open(dst_path, "wb") as handle:
                handle.write(payload)

        with open(os.path.join(out_version_dir, "manifest.json"), "wb") as handle:
            handle.write(manifest_bytes)
        with open(
            os.path.join(out_version_dir, "index.html"), "w", encoding="utf-8"
        ) as handle:
            handle.write(version_index_html)
        with open(
            os.path.join(staging_out, "index.html"), "w", encoding="utf-8"
        ) as handle:
            handle.write(booted_html)

        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)
        shutil.move(staging_out, out_dir)
    finally:
        shutil.rmtree(staging_parent, ignore_errors=True)

    return version


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "AgentProf-iOS-Build/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 200:
                raise PrepareError(f"HTTP {response.status} fetching {url}")
            return response.read()
    except urllib.error.URLError as exc:
        raise PrepareError(f"failed to fetch {url}: {exc}") from exc


def stage_from_remote(site_url: str, out_dir: str, version_override: str | None = None) -> str:
    base = site_url.rstrip("/")
    with tempfile.TemporaryDirectory(prefix="agentprof-ui-fetch-") as work_dir:
        root_html = fetch_bytes(f"{base}/index.html").decode("utf-8")
        with open(os.path.join(work_dir, "index.html"), "w", encoding="utf-8") as handle:
            handle.write(root_html)

        version = version_override or parse_stable_version(root_html)
        if not VERSION_RE.match(version):
            raise PrepareError(f"invalid version {version!r}")

        version_dir = os.path.join(work_dir, version)
        os.makedirs(version_dir, exist_ok=True)

        manifest_bytes = fetch_bytes(f"{base}/{version}/manifest.json")
        resources = validate_manifest(manifest_bytes)
        with open(os.path.join(version_dir, "manifest.json"), "wb") as handle:
            handle.write(manifest_bytes)

        version_index_bytes = fetch_bytes(f"{base}/{version}/index.html")
        with open(os.path.join(version_dir, "index.html"), "wb") as handle:
            handle.write(version_index_bytes)

        for rel_path in resources:
            dst_path = os.path.join(version_dir, *rel_path.split("/"))
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            with open(dst_path, "wb") as handle:
                handle.write(fetch_bytes(f"{base}/{version}/{rel_path}"))

        return stage_from_dist(work_dir, out_dir, version_override=version)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--dist",
        default=DEFAULT_DIST,
        help="local UI dist directory (default: %(default)s)",
    )
    parser.add_argument(
        "--fetch",
        nargs="?",
        const=DEFAULT_SITE_URL,
        metavar="URL",
        help=f"download and verify from a published UI origin (default: {DEFAULT_SITE_URL})",
    )
    parser.add_argument(
        "--version",
        default=None,
        help="explicit v<version> directory to stage instead of index.html's stable channel",
    )
    parser.add_argument(
        "--out",
        default=DEFAULT_OUT,
        help="destination directory for AgentProfWeb (default: %(default)s)",
    )
    args = parser.parse_args(argv)
    try:
        if args.fetch:
            version = stage_from_remote(args.fetch, args.out, version_override=args.version)
            source = args.fetch
        else:
            version = stage_from_dist(args.dist, args.out, version_override=args.version)
            source = args.dist
    except PrepareError as exc:
        print(f"prepare_web_ui.py: {exc}", file=sys.stderr)
        return 1
    print(f"Staged AgentProfWeb ({version}) from {source} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
