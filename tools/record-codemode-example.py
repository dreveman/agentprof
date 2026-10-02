#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Record and verify a CI-audit comparison using the installed Pi and its auth."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parent / 'experiments/codemode-ci/run.py'), run_name='__main__')
