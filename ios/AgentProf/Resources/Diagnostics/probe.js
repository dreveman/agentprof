// SPDX-License-Identifier: Apache-2.0
// window.runProbe(options) checks what the AgentProf UI needs from the web view
// and resolves to {<check>: {ok, value} | {ok: false, error}}. Options:
//   memoryMB: WebAssembly memory to grow to (default 512).
//   findMemoryLimit: grow until WebAssembly refuses (up to 4 GB) instead.
//   traceURL, traceBytes: a recording on the app's origin to stream.
'use strict';

(() => {
  const TIMEOUT_MS = 15000;
  const MB = 1024 * 1024;
  const WASM_PAGE = 65536;

  // Perfetto's memory64 check (ui/src/trace_processor/wasm_modules.ts): the
  // compiled bytes of `(module (memory i64 0))`.
  const MEMORY64_PROGRAM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04,
    0x00, 0x00, 0x08, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x02, 0x01, 0x00,
  ]);

  function expect(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function check(fn, timeoutMs = TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(fn), timeout]);
      return {ok: true, value};
    } catch (e) {
      return {ok: false, error: String(e && e.message ? e.message : e)};
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBytes(url, init) {
    const response = await fetch(url, init);
    expect(response.ok, `HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  function ask(worker, message) {
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) =>
        e.data.ok ? resolve(e.data.value) : reject(new Error(e.data.error));
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
      worker.postMessage(message);
    });
  }

  // Grows a 32-bit WebAssembly memory 64 MB at a time, touching each step so
  // the pages are really committed, until it reaches |targetMB| or is refused.
  function growMemory(targetMB) {
    const STEP_MB = 64;
    const memory = new WebAssembly.Memory({initial: 1, maximum: 65536});
    let reached = 0;
    try {
      while (reached + STEP_MB <= targetMB) {
        memory.grow((STEP_MB * MB) / WASM_PAGE);
        reached += STEP_MB;
        new Uint8Array(memory.buffer)[reached * MB - 1] = 1;
      }
    } catch {
      // Refused: |reached| is the limit.
    }
    return reached;
  }

  async function runProbe(options = {}) {
    const results = {};
    results.environment = await check(() => ({
      locationOrigin: location.origin,
      windowOrigin: window.origin,
      isSecureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      serviceWorker: 'serviceWorker' in navigator,
      userAgent: navigator.userAgent,
    }));
    results.host = await check(() => {
      const host = window.agentprofHost;
      expect(
        host !== undefined && host.platform === 'ios',
        'window.agentprofHost is missing',
      );
      return {
        platform: host.platform,
        appVersion: host.appVersion,
        recentTraces: Array.isArray(host.recentTraces),
      };
    });
    results.localStorage = await check(() => {
      localStorage.setItem('agentprof-probe', '1');
      const value = localStorage.getItem('agentprof-probe');
      localStorage.removeItem('agentprof-probe');
      expect(value === '1', 'the value did not round-trip');
      return true;
    });
    results.indexedDB = await check(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('agentprof-probe', 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore('store');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('store', 'readwrite');
            tx.objectStore('store').put('value', 'key');
            tx.oncomplete = () => {
              db.close();
              indexedDB.deleteDatabase('agentprof-probe');
              resolve(true);
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    results.cacheStorage = await check(async () => {
      expect(typeof caches !== 'undefined', 'caches is undefined');
      const cache = await caches.open('agentprof-probe');
      await cache.put('/probe', new Response('1'));
      const hit = await cache.match('/probe');
      await caches.delete('agentprof-probe');
      expect(hit !== undefined, 'no cache hit');
      return true;
    });
    results.cryptoSubtle = await check(async () => {
      expect(
        window.crypto && crypto.subtle !== undefined,
        'crypto.subtle is undefined',
      );
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new Uint8Array([1, 2, 3]),
      );
      return digest.byteLength;
    });
    results.corsFetch = await check(
      async () => (await fetchBytes('add.wasm', {mode: 'cors'})).byteLength,
    );
    results.blobURL = await check(async () => {
      const url = URL.createObjectURL(new Blob(['blob']));
      try {
        return new TextDecoder().decode(await fetchBytes(url));
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    results.wasmStreaming = await check(async () => {
      const module = await WebAssembly.compileStreaming(fetch('add.wasm'));
      return new WebAssembly.Instance(module, {}).exports.add(2, 3);
    });
    let module;
    results.wasmCompile = await check(async () => {
      module = await WebAssembly.compile(await fetchBytes('add.wasm'));
      const value = new WebAssembly.Instance(module, {}).exports.add(2, 3);
      expect(value === 5, `add(2, 3) = ${value}`);
      return value;
    });
    results.worker = await check(async () => {
      const worker = new Worker('worker.js');
      try {
        return await ask(worker, {kind: 'echo'});
      } finally {
        worker.terminate();
      }
    });
    results.wasmModuleToWorker = await check(async () => {
      expect(module !== undefined, 'no compiled module');
      const worker = new Worker('worker.js');
      try {
        const value = await ask(worker, {kind: 'instantiate', module});
        expect(value === 42, `add(20, 22) = ${value}`);
        return value;
      } finally {
        worker.terminate();
      }
    });
    results.memory64 = await check(() => {
      try {
        new WebAssembly.Module(MEMORY64_PROGRAM);
        return true;
      } catch {
        return false;
      }
    });
    const findLimit = options.findMemoryLimit === true;
    const targetMB = findLimit ? 4096 : options.memoryMB ?? 512;
    results.wasmMemory = await check(() => {
      const reached = growMemory(targetMB);
      expect(
        findLimit || reached >= targetMB,
        `grew to ${reached} of ${targetMB} MB`,
      );
      return reached;
    }, findLimit ? 120000 : TIMEOUT_MS);
    if (options.traceURL) {
      results.traceStream = await check(async () => {
        const response = await fetch(options.traceURL);
        expect(response.ok, `HTTP ${response.status}`);
        const contentLength = Number(response.headers.get('Content-Length'));
        const reader = response.body.getReader();
        let bytes = 0;
        let chunks = 0;
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          chunks++;
        }
        expect(
          bytes === options.traceBytes,
          `read ${bytes} of ${options.traceBytes} bytes`,
        );
        expect(
          contentLength === options.traceBytes,
          `Content-Length ${contentLength}`,
        );
        return {bytes, chunks};
      }, 60000);
    }
    return results;
  }

  function render(results) {
    const table = document.getElementById('results');
    table.replaceChildren();
    for (const [name, result] of Object.entries(results)) {
      const row = table.insertRow();
      row.insertCell().textContent = name;
      const status = row.insertCell();
      status.textContent = result.ok ? 'OK' : 'Failed';
      status.className = result.ok ? 'ok' : 'fail';
      const detail = row.insertCell();
      detail.className = 'value';
      detail.textContent = result.ok
        ? JSON.stringify(result.value)
        : result.error;
    }
  }

  async function runAndRender() {
    const button = document.getElementById('run');
    button.disabled = true;
    try {
      const findMemoryLimit = document.getElementById('find-limit').checked;
      render(await runProbe({findMemoryLimit}));
    } finally {
      button.disabled = false;
    }
  }

  window.runProbe = runProbe;
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('run').addEventListener('click', runAndRender);
    if (new URLSearchParams(location.search).get('autorun') !== '0') {
      runAndRender();
    }
  });
})();
