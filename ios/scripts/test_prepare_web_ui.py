#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import functools
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prepare_web_ui  # noqa: E402


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


class PrepareWebUITests(unittest.TestCase):
    VERSION = "v59.1-test123"

    def _make_dist(
        self,
        root: str,
        *,
        include_wasm32: bool = True,
        tamper_frontend: bool = False,
        extra_manifest_entry: tuple[str, str] | None = None,
    ) -> str:
        dist = os.path.join(root, "dist")
        version_dir = os.path.join(dist, self.VERSION)
        os.makedirs(os.path.join(version_dir, "assets"), exist_ok=True)

        files = {
            "frontend_bundle.js": b"console.log('frontend');",
            "engine_bundle.js": b"console.log('engine');",
            "frontend.css": b"body { margin: 0; }",
            "assets/MaterialSymbolsOutlined.woff2": b"wOF2fontbytes",
            "assets/agentprof-icon.svg": b"<svg></svg>",
        }
        if include_wasm32:
            files["trace_processor.wasm"] = b"\x00asm\x01\x00\x00\x00"

        resources: dict[str, str] = {}
        for rel_path, content in files.items():
            full_path = os.path.join(version_dir, *rel_path.split("/"))
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(b"tampered!" if tamper_frontend and rel_path == "frontend_bundle.js" else content)
            resources[rel_path] = prepare_web_ui.sha256_sri(content)

        if extra_manifest_entry is not None:
            resources[extra_manifest_entry[0]] = extra_manifest_entry[1]

        # Source maps and root service workers exist in raw builds and must not be staged.
        with open(os.path.join(version_dir, "frontend_bundle.js.map"), "wb") as handle:
            handle.write(b"{}")
        with open(os.path.join(dist, "service_worker.js"), "wb") as handle:
            handle.write(b"// sw")

        with open(os.path.join(version_dir, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump({"resources": resources}, handle)

        version_html = "<body data-perfetto_version='{\"stable\":\"filled_by_build_js\"}'></body>\n"
        root_html = f"<body data-perfetto_version='{{\"stable\":\"{self.VERSION}\"}}'></body>\n"
        with open(os.path.join(version_dir, "index.html"), "w", encoding="utf-8") as handle:
            handle.write(version_html)
        with open(os.path.join(dist, "index.html"), "w", encoding="utf-8") as handle:
            handle.write(root_html)

        return dist

    def test_stages_local_dist_without_maps_or_service_worker(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            dist = self._make_dist(root)
            out = os.path.join(root, "out", "AgentProfWeb")
            staged = prepare_web_ui.stage_from_dist(dist, out)
            self.assertEqual(staged, self.VERSION)
            self.assertTrue(os.path.isfile(os.path.join(out, "index.html")))
            self.assertFalse(os.path.exists(os.path.join(out, "service_worker.js")))
            self.assertFalse(
                os.path.exists(os.path.join(out, self.VERSION, "frontend_bundle.js.map"))
            )
            self.assertTrue(
                os.path.isfile(os.path.join(out, self.VERSION, "trace_processor.wasm"))
            )
            with open(os.path.join(out, "index.html"), encoding="utf-8") as handle:
                self.assertIn(f'{{"stable":"{self.VERSION}"}}', handle.read())

    def test_rejects_missing_32bit_trace_processor_wasm(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            dist = self._make_dist(root, include_wasm32=False)
            out = os.path.join(root, "out", "AgentProfWeb")
            with self.assertRaisesRegex(
                prepare_web_ui.PrepareError, "trace_processor.wasm"
            ):
                prepare_web_ui.stage_from_dist(dist, out)

    def test_rejects_tampered_resource(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            dist = self._make_dist(root, tamper_frontend=True)
            out = os.path.join(root, "out", "AgentProfWeb")
            with self.assertRaisesRegex(
                prepare_web_ui.PrepareError, "integrity mismatch"
            ):
                prepare_web_ui.stage_from_dist(dist, out)

    def test_rejects_unsafe_manifest_paths(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            dist = self._make_dist(
                root, extra_manifest_entry=("../escape.js", "sha256-AAAA")
            )
            out = os.path.join(root, "out", "AgentProfWeb")
            with self.assertRaisesRegex(
                prepare_web_ui.PrepareError, "unsafe resource path"
            ):
                prepare_web_ui.stage_from_dist(dist, out)

    def test_fetches_and_verifies_from_remote_server(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            dist = self._make_dist(root)
            out = os.path.join(root, "fetched", "AgentProfWeb")
            handler = functools.partial(_QuietHandler, directory=dist)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                staged = prepare_web_ui.stage_from_remote(
                    f"http://127.0.0.1:{port}", out
                )
                self.assertEqual(staged, self.VERSION)
                self.assertTrue(
                    os.path.isfile(os.path.join(out, self.VERSION, "frontend_bundle.js"))
                )
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
