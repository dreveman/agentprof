// SPDX-License-Identifier: Apache-2.0
import type {Attrs, Observation} from '../agent-tracing/trace.ts';
import {createHash} from 'node:crypto';
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const string = (v: unknown): string => typeof v === 'string' ? v : '';
export function number(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}
export const integer = (v: unknown) => {const n = number(v); return Number.isSafeInteger(n) ? n : undefined;};
export function ns(v: unknown): bigint | undefined {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}
export function isoTime(v: unknown): bigint | undefined {
  if (typeof v !== 'string') return;
  const value = Date.parse(v);
  return Number.isFinite(value) && value >= 0 ? BigInt(value) * 1_000_000n : undefined;
}
export function attributes(raw: unknown): Attrs {
  const result: Attrs = Object.create(null);
  for (const entry of array(raw)) {
    const a = object(entry), v = object(a.value), key = string(a.key);
    if (typeof v.stringValue === 'string') result[key] = v.stringValue;
    else if (typeof v.boolValue === 'boolean') result[key] = v.boolValue;
    else if (integer(v.intValue) !== undefined) result[key] = integer(v.intValue)!;
    else if (number(v.doubleValue) !== undefined) result[key] = number(v.doubleValue)!;
  }
  return result;
}
export interface Span {key: string; trace: string; parent: string; name: string; start: bigint; end: bigint; attrs: Attrs; error: boolean}
export interface Log {key: string; trace: string; span: string; at: bigint; attrs: Attrs}
export function readOtel(rows: Observation[]) {
  const spans = new Map<string, Span>(), logs = new Map<string, Log>();
  for (const row of rows) {
    for (const resource of array(row.data.resourceSpans)) for (const scope of array(object(resource).scopeSpans)) {
      for (const entry of array(object(scope).spans)) {
        const s = object(entry), start = ns(s.startTimeUnixNano), end = ns(s.endTimeUnixNano);
        if (start === undefined || end === undefined || end < start || !s.spanId || !s.traceId) continue;
        const trace = string(s.traceId), key = `${trace}:${s.spanId}`;
        spans.set(key, {key, trace, parent: `${trace}:${s.parentSpanId ?? ''}`, name: string(s.name), start, end,
          attrs: attributes(s.attributes), error: [2, 'STATUS_CODE_ERROR'].includes(object(s.status).code as never)});
      }
    }
    for (const resource of array(row.data.resourceLogs)) for (const scope of array(object(resource).scopeLogs)) {
      for (const entry of array(object(scope).logRecords)) {
        const l = object(entry), attrs = attributes(l.attributes);
        // The installed exporter uses zero timeUnixNano; source event.timestamp is authoritative.
        const at = (ns(l.timeUnixNano) || isoTime(attrs['event.timestamp']));
        if (at === undefined) continue;
        const key = createHash('sha256').update(JSON.stringify([at.toString(), l.traceId, l.spanId, Object.entries(attrs).sort()])).digest('hex');
        logs.set(key, {key, trace: string(l.traceId), span: `${l.traceId}:${l.spanId}`, at, attrs});
      }
    }
  }
  return {spans, logs: [...logs.values()]};
}
