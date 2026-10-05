// SPDX-License-Identifier: Apache-2.0
declare module 'claude-code' {
  interface PluginState {
    agentprof: {
      // Private recorder checkpoint. JSON only; disk journals survive process exit.
      recorder: Record<string, unknown>;
    };
  }
}
