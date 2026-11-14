// SPDX-License-Identifier: Apache-2.0
// Opens trace files from the home page and top bar, adapting the hidden file
// input for native iOS WebKit hosting when `window.agentprofHost` is present.
//
// In an iOS WKWebView app, WebKit offers Photo Library and Camera for a file
// input unless its `accept` attribute excludes image/video types. Recordings
// are data files, so setting `application/octet-stream` (mapped to
// `public.data` on iOS) opens the Files picker directly with all files
// selectable.

export const OPEN_TRACE_COMMAND = 'dev.perfetto.OpenTrace';
const TRACE_FILE_INPUT_SELECTOR = 'input.trace_file';
export const IOS_TRACE_FILE_ACCEPT = 'application/octet-stream';

export interface OpenTraceHost {
  readonly platform?: unknown;
}

export function getAgentprofHost<T = OpenTraceHost>(): T | undefined {
  return (globalThis as {agentprofHost?: T}).agentprofHost;
}

export function inIOSApp(): boolean {
  return getAgentprofHost()?.platform === 'ios';
}

export function isTouchDevice(): boolean {
  if (inIOSApp()) return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  }
  return false;
}

export function shouldInstallServiceWorker(): boolean {
  if (inIOSApp()) return false;
  if (
    typeof location !== 'undefined' &&
    location.protocol !== 'http:' &&
    location.protocol !== 'https:'
  ) {
    return false;
  }
  return true;
}

export function openTraceFiles(app: {
  commands: {runCommand(id: string): unknown};
}): unknown {
  if (inIOSApp() && typeof document !== 'undefined') {
    document
      .querySelector<HTMLInputElement>(TRACE_FILE_INPUT_SELECTOR)
      ?.setAttribute('accept', IOS_TRACE_FILE_ACCEPT);
  }
  return app.commands.runCommand(OPEN_TRACE_COMMAND);
}
