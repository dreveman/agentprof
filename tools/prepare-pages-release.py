#!/usr/bin/env python3
"""Keep the previous UI version available during a Pages deployment."""

import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import urlopen


VERSION_MAP = re.compile(r"data-perfetto_version='([^']+)'")


def version_from_html(html):
    match = VERSION_MAP.search(html)
    if match is None:
        raise ValueError("UI index has no version map")
    version = json.loads(match.group(1))["stable"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+-[0-9a-f]{9}", version):
        raise ValueError(f"Unexpected UI version: {version}")
    return version


def fetch(url):
    with urlopen(url, timeout=30) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dist", type=Path)
    parser.add_argument("--previous-site", required=True)
    args = parser.parse_args()

    current = version_from_html((args.dist / "index.html").read_text())
    site = args.previous_site.rstrip("/") + "/"
    try:
        old_index = fetch(site).decode()
    except HTTPError as error:
        if error.code != 404:
            raise
        print("No previous deployment; publishing first release")
        return
    except URLError as error:
        # The production hostname may not exist before the first deployment.
        if getattr(error.reason, "errno", None) not in (-2, -3):
            raise
        print("No previous deployment; publishing first release")
        return

    previous = version_from_html(old_index)
    if previous == current:
        print(f"Previous deployment already uses {current}")
        return

    base = urljoin(site, previous + "/")
    raw_manifest = fetch(urljoin(base, "manifest.json"))
    resources = json.loads(raw_manifest)["resources"]
    if not isinstance(resources, dict):
        raise ValueError("Previous UI manifest has no resources")
    target = args.dist / previous
    target.mkdir(exist_ok=False)
    (target / "index.html").write_text(old_index)
    (target / "manifest.json").write_bytes(raw_manifest)
    for name, integrity in resources.items():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError(f"Unsafe resource path: {name}")
        data = fetch(urljoin(base, name))
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode()
        if integrity != f"sha256-{digest}":
            raise ValueError(f"Integrity mismatch: {name}")
        output = target.joinpath(*path.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    print(f"Kept {len(resources)} runtime assets from {previous}")


if __name__ == "__main__":
    main()
