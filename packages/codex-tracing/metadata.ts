// SPDX-License-Identifier: Apache-2.0
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {object, string, array} from './otel.ts';
import type {Observation} from '../agent-tracing/trace.ts';

export async function readKnownSession(path: string, id: string, emit: (data: Record<string, unknown>) => void): Promise<boolean> {
  const lines = createInterface({input: createReadStream(path), crlfDelay: Infinity});
  let matched = false, owner = id;
  let context: Record<string, unknown> | undefined;
  for await (const line of lines) {
    if (line.length > 8 * 1024 * 1024) continue;
    let r: Record<string, unknown>;
    try {r = object(JSON.parse(line));} catch {continue;}
    const p = object(r.payload);
    if (r.type === 'session_meta') {
      // Forked transcripts begin with their own identity, then may contain a
      // parent's historical session header and token records. Do not stop at
      // that embedded header or attribute its usage to the child.
      if (matched) {owner = ''; continue;}
      if ((p.id ?? p.session_id) !== id) break;
      matched = true;
      const spawn = object(object(object(p.source).subagent).thread_spawn);
      emit({session_id: id, record: {type: r.type, timestamp: r.timestamp, payload: {
        id, model_provider: string(p.model_provider), cli_version: string(p.cli_version),
        source: {subagent: {thread_spawn: {parent_thread_id: string(spawn.parent_thread_id), agent_role: string(spawn.agent_role)}}},
      }}});
    }
    if (!matched) continue;
    if (r.type === 'turn_context') context = {type: r.type, timestamp: r.timestamp,
      payload: {model: p.model, effort: p.effort, turn_id: p.turn_id}};
    if (r.type === 'token_usage_record') {
      owner = string(p.thread_id);
      if (owner === id && context && object(context.payload).turn_id === p.turn_id) {
        emit({session_id: id, record: context}); context = undefined;
      }
    }
    if (r.type === 'event_msg' && p.type === 'token_count' && owner === id) {
      const info = object(p.info);
      emit({session_id: id, record: {type: r.type, timestamp: r.timestamp, payload: {
        type: 'token_count', info: {model_context_window: info.model_context_window,
          last_token_usage: info.last_token_usage, total_token_usage: info.total_token_usage},
      }}});
    }
  }
  return matched;
}

export function capturedSessionIds(rows: Observation[]): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) ids.add(v);};
  for (const row of rows) {
    if (row.source === 'cli' && row.data.type === 'thread.started') add(row.data.thread_id);
    for (const resource of array(row.data.resourceLogs)) for (const scope of array(object(resource).scopeLogs)) {
      for (const log of array(object(scope).logRecords)) for (const a of array(object(log).attributes))
        if (object(a).key === 'conversation.id') add(object(object(a).value).stringValue);
    }
  }
  return [...ids];
}

// Read only the transcripts of sessions observed by this recorder. Keep the
// version-sensitive adapter narrow: never ingest auth, reasoning or old tool data.
export async function sessionMetadata(root: string, ids: string[], emit: (data: Record<string, unknown>) => void): Promise<number> {
  let found = 0;
  for (const id of ids) {
    const glob = new Bun.Glob(`**/*-${id}.jsonl`);
    for await (const path of glob.scan({cwd: root, onlyFiles: true, throwErrorOnBrokenSymlink: false})) {
      if (await readKnownSession(join(root, path), id, emit)) found++;
    }
  }
  return found;
}
