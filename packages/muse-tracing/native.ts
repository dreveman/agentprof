// SPDX-License-Identifier: Apache-2.0
// Read the documented export envelope, retaining only profiling measurements.
import {estimateContextTokens} from '../pi-tracing/extensions/pi-tracing/context.ts';
export const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const string = (v: unknown): string => typeof v === 'string' ? v : '';
export const integer = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
export const validSession = (id: string): boolean => /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
export interface NativeRecord {id: string; at: string; family: string; run: string; task: string; kind: string; data: Record<string, any>}
export interface NativeSession {id: string; parent?: string; role?: string; records: NativeRecord[]; diagnostics: Record<string, number>; missingChildren: string[]}

const fields: Record<string, readonly string[]> = {
  metadata: ['model_id', 'provider_id', 'build'],
  run_model: ['model_id', 'provider_id', 'profile_id'],
  session_end: ['exit_reason'],
  started: ['prompt', 'task_id'],
  terminal: ['terminal', 'reason', 'duration_ms'],
  model_input_trace_recorded: ['schema_version', 'model_step', 'scope'],
  assistant_message_committed: ['message_id'],
  model_completed: ['duration_ms', 'model', 'usage', 'finish_reason'],
  model_response_created: ['response_id'],
  assistant_tool_calls_committed: ['tool_calls'],
  tool_result_batch_committed: ['results'],
  tool_batch_effect: ['call_id', 'task_id', 'tool_name', 'kind', 'outcome'],
  proposed: ['task_kind'],
  side_effect_intent: ['operation', 'idempotency_key', 'parent_task_id'],
  failed: ['reason', 'error'],
  cancelled: ['reason'],
  completed: [],
  task_stream_linked: ['task_id', 'display'],
};

export function readExport(raw: unknown, id: string): NativeSession {
  const doc = object(raw);
  if (doc.export_schema_version !== 1 || !Array.isArray(doc.events)) throw new Error('Unsupported Muse session export. Expected export_schema_version 1.');
  if (!doc.sessions?.some((s: any) => s.session_id === id && !s.is_copied_context)) throw new Error(`Export does not contain session ${id}`);
  const records: NativeRecord[] = [], seen = new Set<string>();
  const diagnostics: Record<string, number> = {gaps: 0, omitted_live_only: 0,
    unparseable_lines: integer(doc.diagnostics?.unparseable_lines) ?? 0,
    unknown_payload_kinds: integer(doc.diagnostics?.unknown_payload_kinds) ?? 0};
  const consume = (envelope: any) => {
    if (envelope.stream?.id !== id || seen.has(envelope.id)) return;
    seen.add(envelope.id);
    const us = integer(envelope.recorded_at); if (us === undefined) return;
    const p = object(envelope.payload), family = string(p.kind) || string(envelope.payload_type);
    const inner = object(p.event ?? p.record ?? p), kind = family === 'tool_batch_effect' ? family : string(inner.kind) || family;
    const keys = fields[kind];
    // Link only children named by this session's native journal. Never scan
    // another workspace or copy inherited history into a child capture.
    const child = validSession(string(inner.child_session_id)) ? string(inner.child_session_id) : '';
    if (!keys && !child) return;
    const data = Object.fromEntries((keys ?? []).filter(k => inner[k] !== undefined).map(k => [k, inner[k]]));
    if (kind === 'assistant_message_committed') {
      const chars = string(inner.text).length; data.context_chars = chars; data.context_tokens = estimateContextTokens(chars);
    }
    if (kind === 'model_input_trace_recorded' && inner.schema_version === 2 && inner.scope === 'full_request') {
      const b = object(inner.bounded);
      data.aggregates = (Array.isArray(b.aggregates) ? b.aggregates : []).map((raw: unknown) => {
        const a = object(raw);
        return {bytes: integer(a.byte_count), lane: string(a.logical_lane?.value),
          destination: string(a.provider_wire_destination?.value), source: string(a.source?.value)};
      });
      data.omitted_bytes = integer(b.omitted_aggregate_lane_bytes) ?? 0;
      data.omitted_groups = integer(b.omitted_aggregate_group_count) ?? 0;
    }
    if (kind === 'tool_result_batch_committed') data.results = (inner.results ?? []).map((result: any) => {
      let outcome = {}; try {outcome = object(JSON.parse(result.text));} catch {}
      const value = object(outcome);
      const chars = string(result.text).length;
      return {call_id: string(result.tool_call_id), context_chars: chars, context_tokens: estimateContextTokens(chars),
        ...(Number.isSafeInteger(value.exit_code) && typeof value.terminal_status === 'string' ?
          {exit_code: value.exit_code, terminal_status: value.terminal_status} : {})};
    });
    if (child) Object.assign(data, {child_session_id: child,
      child_session_log_path: string(inner.child_session_log_path),
      role: string(inner.reminder_agent_id) || string(inner.agent_type) || 'subagent'});
    records.push({id: string(envelope.id), at: (BigInt(us) * 1000n).toString(), family,
      run: string(p.run_id), task: string(p.task_id ?? inner.task_id), kind, data});
  };
  for (const e of doc.events) {
    if (e.kind === 'record') consume(e.envelope);
    else if (e.kind === 'retained_frame') {
      for (const child of e.envelope?.children ?? []) {
        try {consume(JSON.parse(child.record_json));} catch {diagnostics.unparseable_lines!++;}
      }
    } else if (e.kind === 'gap' && (!e.stream?.id || e.stream.id === id)) {
      // Export intentionally drops streamed tool-output deltas. Final lifecycle
      // records remain intact; this is not missing measured work.
      diagnostics[e.marker === 'omitted_live_only' ? 'omitted_live_only' : 'gaps']!++;
    }
  }
  records.sort((a, b) => BigInt(a.at) < BigInt(b.at) ? -1 : BigInt(a.at) > BigInt(b.at) ? 1 : 0);
  return {id, records, diagnostics, missingChildren: []};
}
