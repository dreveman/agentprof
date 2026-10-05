// SPDX-License-Identifier: Apache-2.0
process.argv.splice(2, 0, "hook");
await import("../runtime/muse-tracing.mjs");
