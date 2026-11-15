// SPDX-License-Identifier: Apache-2.0
// The Perfetto UI compiles trace_processor.wasm on the main thread and posts the
// WebAssembly.Module to its engine worker, which instantiates it synchronously
// (ui/src/engine/wasm_bridge.ts). This worker does the same with add.wasm.
self.onmessage = (event) => {
  const {kind, module} = event.data;
  try {
    switch (kind) {
      case 'echo':
        self.postMessage({ok: true, value: 'echo'});
        break;
      case 'instantiate': {
        const instance = new WebAssembly.Instance(module, {});
        self.postMessage({ok: true, value: instance.exports.add(20, 22)});
        break;
      }
      default:
        self.postMessage({ok: false, error: `Unknown request ${kind}`});
    }
  } catch (e) {
    self.postMessage({ok: false, error: String(e)});
  }
};
