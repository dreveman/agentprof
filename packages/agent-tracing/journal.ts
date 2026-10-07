// SPDX-License-Identifier: Apache-2.0
import type {Observation} from './trace.ts';

/** JSONL records are independent. Salvage complete valid observations after a
 * damaged line, but never treat an unterminated last line as committed. The
 * caller adds one recovery marker so downstream converters mark the trace
 * incomplete. Corrupt line contents must not be copied into diagnostics. */
export function parseObservationJournal(text: string): {rows: Observation[]; corruptRecords: number} {
  const lines = text.split('\n'), tail = lines.pop();
  const rows: Observation[] = [];
  let corruptRecords = tail ? 1 : 0;
  for (const line of lines) {
    try {
      const row: unknown = JSON.parse(line);
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid observation');
      const value = row as Partial<Observation>;
      if (typeof value.source !== 'string' || !value.source || typeof value.timestamp !== 'string' ||
          !/^\d{1,20}$/.test(value.timestamp) || BigInt(value.timestamp) > (1n << 64n) - 1n ||
          value.data === null || typeof value.data !== 'object' || Array.isArray(value.data))
        throw new Error('invalid observation');
      rows.push(value as Observation);
    } catch {corruptRecords++;}
  }
  return {rows, corruptRecords};
}
