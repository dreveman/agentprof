// SPDX-License-Identifier: Apache-2.0
import {Recorder} from './tracer.ts';
import {randomFlowId} from './tracks.ts';

// Pi's models.* calls bypass executeTool. Their lifecycle is published in
// codemode details.calls; ordinary tools are recorded exclusively by hooks.
export class CodemodeCalls {
  private readonly scripts = new Map<string, Map<string, number | null>>();

  observe(recorder: Recorder, parentId: string, parentSpan: number,
          result: unknown, final = false): void {
    const calls = (result as {details?: {calls?: unknown}} | undefined)?.details?.calls;
    let observed = this.scripts.get(parentId);
    if (Array.isArray(calls)) {
      if (!observed) this.scripts.set(parentId, observed = new Map());
      for (const call of calls) {
        if (!call || typeof call !== 'object' || typeof call.id !== 'string' ||
            !['models.classify', 'models.generateImages'].includes(call.name) ||
            !['running', 'ok', 'error', 'cancelled'].includes(call.status)) continue;
        if (!observed.has(call.id)) {
          // A completed snapshot alone cannot establish a start timestamp.
          if (call.status !== 'running' || final || observed.size >= 4096) continue;
          const tracks = recorder.trackSet();
          if (!tracks) continue;
          const flow = randomFlowId(tracks.used);
          recorder.addBeginFlow(parentSpan, flow);
          const identity = typeof call.args === 'string' && call.args.length <= 400 ? call.args.split('/') : [];
          observed.set(call.id, recorder.beginToolSlice(call.id, call.name, undefined, [flow], {
            kind: 'model-call', deferBegin: true,
            annotations: {parent_call_id: parentId, timing: 'codemode-lifecycle',
              ...(identity.length >= 2 ? {provider: identity[0]!, model: identity.slice(1).join('/')} : {})},
          }));
        }
        const span = observed.get(call.id);
        if (span !== null && span !== undefined && call.status !== 'running') {
          recorder.emitEnd(span, {status: String(call.status), is_error: call.status !== 'ok'});
          observed.set(call.id, null);
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
