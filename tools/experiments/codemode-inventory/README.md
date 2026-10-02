# Source inventory comparison

This is the earlier eleven-file workload used to explore Pi codemode. Direct
tools can combine the work into a few searches. The original pair took 27.91 s
with direct tools and 31.68 s with codemode; both answers were correct.

To record another pair with your Pi credentials:

```sh
python3 tools/experiments/codemode-inventory/run.py
```

The CI-audit comparison is now bundled in the UI. The original inventory traces,
prompt, expected answer, and provenance are archived locally under
`artifacts/experiments/pi-source-inventory-example/`.
