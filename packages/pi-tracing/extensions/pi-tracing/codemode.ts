// SPDX-License-Identifier: Apache-2.0
import {Recorder} from './tracer.ts';
import {randomFlowId} from './tracks.ts';

// Pi's models.* calls bypass executeTool. Their lifecycle is published in
// codemode details.calls; ordinary tools are recorded exclusively by hooks.
const MAX_OBSERVED_CALLS = 4096;
function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}
}

export class CodemodeCalls {
  private readonly scripts = new Map<string, Map<string, number | null>>();

  observe(recorder: Recorder, parentId: string, parentSpan: number,
          result: unknown, final = false, captureContents = true): void {
    const details = captureContents ? (result as {details?: unknown} | undefined)?.details : ownValue(result, 'details');
    const calls = captureContents ? (details as {calls?: unknown} | undefined)?.calls : ownValue(details, 'calls');
    let observed = this.scripts.get(parentId);
    if (Array.isArray(calls)) {
      if (!observed) this.scripts.set(parentId, observed = new Map());
      for (let i = 0, limit = captureContents ? calls.length : Math.min(calls.length, MAX_OBSERVED_CALLS); i < limit; i++) {
        const call = captureContents ? calls[i] : ownValue(calls, String(i));
        if (!call || typeof call !== 'object') continue;
        const id = captureContents ? call.id : ownValue(call, 'id');
        const name = captureContents ? call.name : ownValue(call, 'name');
        const status = captureContents ? call.status : ownValue(call, 'status');
        if (typeof id !== 'string' || !['models.classify', 'models.generateImages'].includes(name as string) ||
            !['running', 'ok', 'error', 'cancelled'].includes(status as string)) continue;
        if (!observed.has(id)) {
          // A completed snapshot alone cannot establish a start timestamp.
          if (status !== 'running' || final || observed.size >= MAX_OBSERVED_CALLS) continue;
          const tracks = recorder.trackSet();
          if (!tracks) continue;
          const flow = randomFlowId(tracks.used);
          recorder.addBeginFlow(parentSpan, flow);
          const args = captureContents ? call.args : undefined;
          const identity = typeof args === 'string' && args.length <= 400 ? args.split('/') : [];
          observed.set(id, recorder.beginToolSlice(id, name as string, undefined, [flow], {
            kind: 'model-call', deferBegin: true,
            annotations: {parent_call_id: parentId, timing: 'codemode-lifecycle',
              ...(identity.length >= 2 ? {provider: identity[0]!, model: identity.slice(1).join('/')} : {})},
          }));
        }
        const span = observed.get(id);
        if (span !== null && span !== undefined && status !== 'running') {
          recorder.emitEnd(span, {status: String(status), is_error: status !== 'ok'});
          observed.set(id, null);
        }
      }
    }
    if (final && observed) {
      for (const span of observed.values()) {
        if (span !== null) recorder.emitEnd(span, {incomplete: true, status: 'interrupted'});
      }
      this.scripts.delete(parentId);
    }
  }

  clear(): void { this.scripts.clear(); }
}
