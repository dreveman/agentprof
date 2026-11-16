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

export interface HostOpenTraceRequest {
  readonly url: string;
  readonly name: string;
}

export interface HostTraceChunk {
  data: Uint8Array;
  eof: boolean;
  bytesRead: number;
  bytesTotal: number;
}

export interface HostTraceStream {
  readChunk(): Promise<HostTraceChunk>;
}

export interface OpenTraceHost {
  readonly platform?: unknown;
  onOpenTrace?: (request: HostOpenTraceRequest) => Promise<void> | void;
}

export function getAgentprofHost<T = OpenTraceHost>(): T | undefined {
  return (globalThis as {agentprofHost?: T}).agentprofHost;
}

export function inIOSApp(): boolean {
  return getAgentprofHost()?.platform === 'ios';
}

export function isIPhone(): boolean {
  const host = getAgentprofHost<{
    platform?: unknown;
    idiom?: unknown;
    nativeBar?: unknown;
  }>();
  if (host?.nativeBar === true) return true;
  if (host?.platform === 'ios' && typeof host.idiom === 'string') {
    return host.idiom === 'phone';
  }
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.userAgent === 'string' &&
    /\b(?:iPhone|iPod)\b/i.test(navigator.userAgent)
  ) {
    return true;
  }
  return host?.platform === 'ios';
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

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('Expected Uint8Array or ArrayBuffer trace stream chunk');
}

function createResponseTraceStream(response: Response): {
  stream: HostTraceStream;
  bytesTotal: number;
} {
  const rawLength = response.headers.get('Content-Length');
  const parsedLength =
    rawLength !== null ? Number.parseInt(rawLength, 10) : Number.NaN;
  const bytesTotal =
    Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;

  if (response.body !== null && typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    let bytesRead = 0;
    let released = false;
    return {
      bytesTotal,
      stream: {
        async readChunk(): Promise<HostTraceChunk> {
          const {done, value} = await reader.read();
          if (done) {
            if (!released) {
              released = true;
              reader.releaseLock();
            }
            return {
              data: new Uint8Array(),
              eof: true,
              bytesRead,
              bytesTotal,
            };
          }
          const data = toUint8Array(value);
          bytesRead += data.byteLength;
          return {
            data,
            eof: false,
            bytesRead,
            bytesTotal,
          };
        },
      },
    };
  }

  let consumed = false;
  return {
    bytesTotal,
    stream: {
      async readChunk(): Promise<HostTraceChunk> {
        if (consumed) {
          return {
            data: new Uint8Array(),
            eof: true,
            bytesRead: bytesTotal,
            bytesTotal,
          };
        }
        consumed = true;
        const data = new Uint8Array(await response.arrayBuffer());
        const total = bytesTotal > 0 ? bytesTotal : data.byteLength;
        return {
          data,
          eof: true,
          bytesRead: data.byteLength,
          bytesTotal: total,
        };
      },
    },
  };
}

export function registerHostOpenTrace(app: {
  openTraceFromStream(stream: HostTraceStream, title?: string): Promise<unknown>;
}): void {
  const host = getAgentprofHost<OpenTraceHost>();
  if (host?.platform !== 'ios') return;
  host.onOpenTrace = async ({url, name}: HostOpenTraceRequest) => {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('Missing trace URL');
    }
    const label = typeof name === 'string' && name.length > 0 ? name : 'recording';
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not read ${label} (HTTP ${response.status}).`);
    }
    const {stream, bytesTotal} = createResponseTraceStream(response);
    const title =
      bytesTotal > 0 ? `${label} (${Math.ceil(bytesTotal / 1e6)} MB)` : label;
    await app.openTraceFromStream(stream, title);
  };
}
