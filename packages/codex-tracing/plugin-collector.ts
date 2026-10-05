// SPDX-License-Identifier: Apache-2.0
import {createServer} from 'node:http';
import {writeFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {readConnection} from './plugin-config.ts';
import {Journal, publish, now} from './plugin-journal.ts';
import {readKnownSession} from './metadata.ts';
import {readOtel, object, string, array, attributes, type Span} from './otel.ts';
import type {Observation} from './convert.ts';

const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
interface LiveSession {id: string; pid: number; cwd: string; transcript: string; model: string; parent?: string; prompt?: Observation; ended?: boolean}
interface Capture {journal: Journal; sessions: Set<string>; end?: string; saving?: Promise<Record<string, unknown>>; telemetry: boolean}

export class Collector {
  readonly sessions = new Map<string, LiveSession>();
  readonly captures = new Map<string, Capture>();
  private routes = new Map<string, Set<string>>();
  private pending = new Map<string, {span: Span; wire: unknown; bytes: number}>();
  private pendingBytes = 0;
  private spans = new Map<string, Span>();
  private lastActivity = Date.now();
  private lastClock = Date.now();
  constructor(readonly state: string, readonly drainMs = 7000) {mkdirSync(state, {recursive: true, mode: 0o700});}
  private recordState(id: string, value: Record<string, unknown>) {
    writeFileSync(join(this.state, `${id}.json`), JSON.stringify(value), {mode: 0o600});
  }
  status(id: string): Record<string, unknown> {
    if (!validId(id)) throw new Error('Missing current Codex session identity.');
    const capture = this.captureFor(id);
    if (capture) return {state: capture.end ? 'saving' : 'recording', output: capture.journal.output,
      session_id: capture.journal.sessionId, native_telemetry_received: capture.telemetry};
    const path = join(this.state, `${id}.json`);
    if (existsSync(path)) {
      const status = JSON.parse(readFileSync(path, 'utf8'));
      if (['recording', 'saving'].includes(status.state)) return {...status, state: 'interrupted',
        message: 'Recorder restarted. Recover the retained capture journal.'};
      return status;
    }
    return {state: 'idle', session_id: id};
  }
  private captureFor(id: string): Capture | undefined {
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const capture = this.captures.get(id);
      if (capture) return capture;
      id = this.sessions.get(id)?.parent ?? '';
    }
  }
  private add(capture: Capture, row: Observation) {
    if (capture.end && BigInt(row.timestamp) > BigInt(capture.end)) return;
    capture.journal.add(row);
  }
  start(id: string, output?: string): Record<string, unknown> {
    const session = this.sessions.get(id);
    if (!session || session.ended) throw new Error('No live Codex session. Enable and trust the Agent Profiler hooks.');
    if (session.parent) throw new Error('Start recording in the primary session; its subagents share the trace.');
    const existing = this.captureFor(id);
    if (existing) {
      if (existing.end) throw new Error('The previous recording is still being saved.');
      if (output) throw new Error(`Already recording to ${existing.journal.output}`);
      return this.status(id);
    }
    const journal = new Journal(id, session.pid, session.cwd, output);
    const capture: Capture = {journal, sessions: new Set([id]), telemetry: false};
    this.captures.set(id, capture);
    for (const item of this.sessions.values()) {
      if (this.captureFor(item.id) !== capture || item.ended) continue;
      capture.sessions.add(item.id);
      journal.add({source: 'codex.hook', timestamp: journal.start, data: {hook_event_name: 'SessionStart',
        session_id: item.id, model: item.model, parent_session: item.parent, source: 'recording'}});
      if (item.prompt) journal.add({...item.prompt, timestamp: journal.start,
        data: {...item.prompt.data, started_before_capture: true}});
    }
    journal.flush();
    const status = this.status(id);
    this.recordState(id, status);
    return status;
  }
  async stop(id: string, incomplete = false): Promise<Record<string, unknown>> {
    const capture = this.captureFor(id);
    if (!capture) return this.status(id);
    if (capture.journal.sessionId !== id) throw new Error('Stop the recording from its primary session.');
    if (capture.saving) return capture.saving;
    capture.end = now();
    this.recordState(id, this.status(id));
    capture.saving = (async () => {
      try {
        // Codex batches native telemetry independently of hooks. Continue to
        // receive late exports, but the recording's end time stays fixed.
        await delay(this.drainMs);
        this.flushPending();
        for (const sessionId of capture.sessions) {
          const path = this.sessions.get(sessionId)?.transcript;
          if (!path) continue;
          try {await readKnownSession(path, sessionId, data => capture.journal.add({source: 'session_metadata', timestamp: now(), data}));}
          catch {capture.journal.dropped++;}
        }
        capture.journal.close(capture.end!, incomplete);
        const summary = publish(capture.journal.directory);
        const result = {state: 'saved', ...summary};
        this.recordState(id, result);
        return result;
      } catch (error) {
        const result = {state: 'error', output: capture.journal.output,
          journal: capture.journal.directory, error: String(error)};
        this.recordState(id, result);
        writeFileSync(join(capture.journal.directory, 'error.txt'), String(error), {mode: 0o600});
        return result;
      } finally {this.captures.delete(id); this.lastActivity = Date.now();}
    })();
    return capture.saving;
  }
  async hook(data: Record<string, unknown>, pid: number, timestamp: string, autoStart = false) {
    const event = string(data.hook_event_name);
    if (data.agent_id && !['SubagentStart', 'SubagentStop'].includes(event))
      data = {...data, parent_session: data.session_id, session_id: data.agent_id};
    const id = string(data.session_id);
    if (!validId(id) || !Number.isInteger(pid) || pid <= 0) throw new Error('Invalid hook identity.');
    this.lastActivity = Date.now();
    let session = this.sessions.get(id);
    const firstStart = !session || session.ended;
    if (!session) {
      session = {id, pid, cwd: string(data.cwd), transcript: string(data.transcript_path), model: string(data.model)};
      this.sessions.set(id, session);
    }
    session.pid = pid;
    if (data.cwd) session.cwd = string(data.cwd);
    if (data.transcript_path && event !== 'SubagentStart') session.transcript = string(data.transcript_path);
    if (data.model && event !== 'SubagentStart') session.model = string(data.model);
    if (data.parent_session) session.parent = string(data.parent_session);
    if (event === 'SessionStart') session.ended = false;
    if (event === 'SessionStart' && firstStart && autoStart && ['startup', 'resume'].includes(string(data.source))) {
      const result = this.start(id);
      return {systemMessage: `Agent Profiler: recording to ${result.output}`};
    }
    if (event === 'UserPromptSubmit') {
      const control = string(data.prompt).trim().match(/^tracing (start|stop|status)(?:\s+(.+))?$/);
      if (control) {
        const capture = this.captureFor(id);
        const observation = {source: 'codex.control', timestamp, data: {session_id: id, turn_id: data.turn_id,
          action: control[1], prompt_length: Buffer.byteLength(string(data.prompt))}};
        if (capture && !capture.end) capture.journal.add(observation);
        let result;
        try {result = control[1] === 'start' ? this.start(id, control[2]) : control[1] === 'stop' ? await this.stop(id) : this.status(id);}
        catch (error) {result = {state: 'error', error: String(error)};}
        if (!capture && control[1] === 'start') this.captureFor(id)?.journal.add(observation);
        const status = object(result);
        const message = status.state === 'recording' ? `Recording to ${status.output}` :
          status.state === 'saved' ? `Saved ${status.output}` : status.state === 'saving' ? `Saving ${status.output}` :
          status.state === 'idle' ? 'Not recording.' : string(status.error) || string(status.message);
        return {decision: 'block', reason: `Agent Profiler: ${message}`};
      }
      session.prompt = {source: 'codex.hook', timestamp, data};
    }
    if (event === 'SubagentStart' || event === 'SubagentStop') {
      const childId = string(data.agent_id);
      if (validId(childId)) {
        let child = this.sessions.get(childId);
        if (!child) {child = {...session, id: childId, prompt: undefined, transcript: ''}; this.sessions.set(childId, child);}
        child.parent = id;
        child.ended = event === 'SubagentStop';
        if (event === 'SubagentStart' && data.transcript_path) child.transcript = string(data.transcript_path);
        if (data.model) child.model = string(data.model);
        if (data.agent_transcript_path) child.transcript = string(data.agent_transcript_path);
      }
    }
    const capture = this.captureFor(id);
    if (capture && !capture.end) {
      capture.sessions.add(id);
      if (data.agent_id) capture.sessions.add(string(data.agent_id));
      this.add(capture, {source: 'codex.hook', timestamp, data});
    }
    if (event === 'Stop' || event === 'Interrupt') session.prompt = undefined;
    if (event === 'SessionEnd') {
      session.ended = true;
      if (capture && !capture.end && capture.journal.sessionId === id) void this.stop(id);
    }
    this.flushPending();
    return {};
  }
  ingest(data: Record<string, unknown>) {
    const rows: Observation[] = [{source: 'otel', timestamp: now(), data}];
    const parsed = readOtel(rows);
    const remember = (trace: string, id: string) => {
      if (!trace || !id) return;
      const ids = this.routes.get(trace) ?? new Set<string>(); ids.add(id); this.routes.set(trace, ids);
    };
    // Routing metadata is kept in memory. Unrecorded sessions never enter a journal.
    for (const log of parsed.logs) remember(log.trace, string(log.attrs['conversation.id']));
    for (const span of parsed.spans.values()) {
      remember(span.trace, string(span.attrs['conversation.id']) || string(span.attrs['thread.id']));
      this.spans.set(span.key, {...span, attrs: {
        'conversation.id': string(span.attrs['conversation.id']), 'thread.id': string(span.attrs['thread.id']),
      }});
    }
    for (const resource of array(data.resourceLogs)) for (const scope of array(object(resource).scopeLogs)) for (const log of array(object(scope).logRecords)) {
      const attrs = attributes(object(log).attributes), id = string(attrs['conversation.id']);
      const capture = this.captureFor(id);
      if (!capture) continue;
      const row = {source: '/v1/logs', timestamp: now(), data: {resourceLogs: [{scopeLogs: [{logRecords: [log]}]}]}};
      const at = readOtel([row]).logs[0]?.at;
      if (at === undefined || at < BigInt(capture.journal.start) || (capture.end && at > BigInt(capture.end))) continue;
      capture.sessions.add(id); capture.telemetry = true;
      capture.journal.add(row);
    }
    for (const resource of array(data.resourceSpans)) for (const scope of array(object(resource).scopeSpans)) for (const wire of array(object(scope).spans)) {
      const value = object(wire), key = `${value.traceId}:${value.spanId}`, span = parsed.spans.get(key);
      if (span) {
        const bytes = Buffer.byteLength(JSON.stringify(wire));
        this.pendingBytes += bytes - (this.pending.get(key)?.bytes ?? 0);
        this.pending.set(key, {span, wire, bytes});
      }
    }
    this.flushPending();
    if (this.pending.size > 8192 || this.pendingBytes > 16 * 1024 * 1024 || this.spans.size > 32768 || this.routes.size > 32768) {
      for (const capture of this.captures.values()) capture.journal.dropped++;
      this.pending.clear(); this.pendingBytes = 0; this.spans.clear(); this.routes.clear();
    }
    if (!this.captures.size) {this.pending.clear(); this.pendingBytes = 0; this.spans.clear(); this.routes.clear();}
  }
  private flushPending() {
    for (const [key, {span, wire, bytes}] of this.pending) {
      let parent: Span | undefined = span, id = '';
      const seen = new Set<string>();
      while (parent && !seen.has(parent.key)) {
        seen.add(parent.key); id = string(parent.attrs['conversation.id']) || string(parent.attrs['thread.id']);
        if (id) break;
        parent = this.spans.get(parent.parent);
      }
      const route = this.routes.get(span.trace);
      if (!id && route?.size === 1) id = [...route][0]!;
      if (!id) continue;
      const capture = this.captureFor(id);
      if (capture && span.end >= BigInt(capture.journal.start) && (!capture.end || span.start <= BigInt(capture.end))) {
        capture.sessions.add(id); capture.telemetry = true;
        const value = object(wire);
        const attrs = [...array(value.attributes), {key: 'conversation.id', value: {stringValue: id}}];
        capture.journal.add({source: '/v1/traces', timestamp: now(), data: {resourceSpans: [{scopeSpans: [{spans: [{...value, attributes: attrs}]}]}]}});
      }
      this.pending.delete(key); this.pendingBytes -= bytes;
    }
  }
  tick(): boolean {
    for (const capture of this.captures.values()) if (!capture.end) {
      capture.journal.flush();
      if (Date.now() - this.lastClock >= 60000) capture.journal.clock();
      const root = this.sessions.get(capture.journal.sessionId);
      if (root && !alive(root.pid)) {root.ended = true; void this.stop(root.id, true);}
    }
    if (Date.now() - this.lastClock >= 60000) this.lastClock = Date.now();
    return !this.captures.size && Date.now() - this.lastActivity > 15000 &&
      [...this.sessions.values()].every(session => session.ended || !alive(session.pid));
  }
}

export async function serve(state: string) {
  const connection = readConnection(state), collector = new Collector(state);
  const server = createServer(async (request, response) => {
    const reply = (status: number, data: unknown) => {response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(data));};
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${connection.token}`) return reply(403, {error: 'Forbidden'});
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {reply(413, {error: 'Request too large'}); return;}
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body, {maxOutputLength: 8 * 1024 * 1024});
      const data = object(JSON.parse(body.toString('utf8')));
      if (request.url === '/health') return reply(200, {ready: true});
      if (request.url === '/v1/logs' || request.url === '/v1/traces') {collector.ingest(data); return reply(200, {});}
      if (request.url === '/hook') return reply(200, await collector.hook(object(data.hook), Number(data.pid), string(data.timestamp), data.auto_start === true));
      const id = string(data.session_id);
      if (request.url === '/start') return reply(200, collector.start(id, typeof data.output_path === 'string' ? data.output_path : undefined));
      if (request.url === '/stop') return reply(200, await collector.stop(id));
      if (request.url === '/status') return reply(200, collector.status(id));
      reply(404, {error: 'Unknown operation'});
    } catch (error) {reply(400, {error: String(error)});}
  });
  server.requestTimeout = 12000;
  await new Promise<void>((done, reject) => {server.once('error', reject); server.listen(connection.port, '127.0.0.1', done);});
  const timer = setInterval(() => {if (collector.tick()) {clearInterval(timer); server.close();}}, 1000);
}
