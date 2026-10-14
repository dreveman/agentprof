// SPDX-License-Identifier: Apache-2.0
import {Database} from 'bun:sqlite';
import {modelDisplayName} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/model_display';
import {expect, test} from 'bun:test';
import {TURNS_SETUP_SQL, turnsPageQuery, turnEventsQuery, TURN_UNASSIGNED_QUERY} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/turns_queries';
import {intervalPosition, nanoseconds, turnDuration} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/turns_timeline';

test('Claude display labels omit only dated snapshot suffixes', () => {
  expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  expect(modelDisplayName('claude-opus-4-20250514')).toBe('claude-opus-4');
  expect(modelDisplayName('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  expect(modelDisplayName('claude-haiku-4-5-latest')).toBe('claude-haiku-4-5-latest');
  expect(modelDisplayName('gpt-4.1-20250414')).toBe('gpt-4.1-20250414');
  expect(modelDisplayName('')).toBe('');
});

const MS = 1_000_000;
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agentprof_slices(id INTEGER PRIMARY KEY, parent_id INTEGER, capture_id INTEGER,
    session TEXT, capture TEXT, ts INTEGER, dur INTEGER, incomplete INTEGER, kind TEXT, name TEXT, arg_set_id INTEGER, args_json TEXT, track_id INTEGER);
    CREATE TABLE slice(id INTEGER PRIMARY KEY, parent_id INTEGER, track_id INTEGER);
    CREATE TABLE agentprof_capture_markers(slice_id INTEGER, capture_id INTEGER);
    CREATE TABLE agentprof_capture_runs(capture_id INTEGER PRIMARY KEY, start_ts INTEGER, end_ts INTEGER, session TEXT);
    CREATE TABLE agentprof_messages(id INTEGER PRIMARY KEY, message_start_ts INTEGER, message_ns INTEGER,
      provider TEXT, model TEXT, first_ns INTEGER, input_tokens INTEGER, output_tokens INTEGER);
    CREATE TABLE agentprof_tool_calls(id INTEGER PRIMARY KEY, intent TEXT, arguments TEXT, args_truncated INTEGER,
      language TEXT, line_count INTEGER, call_id TEXT, parent_call_id TEXT, is_error INTEGER);
    CREATE TABLE agentprof_script_children(script_id INTEGER, id INTEGER, depth INTEGER);
    CREATE TABLE flow(slice_out INTEGER, slice_in INTEGER);
    CREATE INDEX flow_out ON flow(slice_out); CREATE INDEX flow_in ON flow(slice_in);
    INSERT INTO agentprof_capture_runs VALUES (1,0,100000000000000,'session-1'),(2,0,100000000000000,'session-2');`);
  function add(id: number, kind: string, start: number, duration: number, options: {capture?: number; parent?: number; incomplete?: boolean; args?: Record<string, unknown>} = {}) {
    const capture = options.capture ?? 1;
    db.prepare('INSERT INTO slice VALUES (?,?,?)').run(id, options.parent ?? null, capture);
    db.prepare('INSERT INTO agentprof_slices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, options.parent ?? null, capture, `session-${capture}`, `capture-${capture}`, start * MS,
      duration < 0 ? duration : duration * MS, options.incomplete ? 1 : 0, kind, kind, id, JSON.stringify(options.args ?? {}), capture);
    if (kind === 'assistant-message') db.prepare('INSERT INTO agentprof_messages VALUES (?,?,?,?,?,?,?,?)')
      .run(id, start * MS, duration < 0 ? null : duration * MS, 'provider', 'model', 2 * MS, 10, 5);
    if (kind === 'tool-execution') db.prepare('INSERT INTO agentprof_tool_calls(id,intent) VALUES (?,?)').run(id, 'Recorded tool');
  }
  // SQLite fixtures substitute JSON extraction for Perfetto's args lookup.
  const setup = () => {
    const sql = TURNS_SETUP_SQL.replaceAll('CREATE PERFETTO TABLE', 'CREATE TABLE')
      .replace(/EXTRACT_ARG\(s\.arg_set_id, '([^']+)'\)/g, (_, key) => `json_extract(s.args_json, '$."${key}"')`);
    db.exec(sql);
  };
  return {db, add, setup};
}

test('human turn groups multiple response/tool cycles with unioned overlap and explicit request links', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 20, {args: {'debug.text': 'User request'}});
    add(2, 'assistant-message', 1, 5);
    add(3, 'provider-request', 0.5, 1);
    db.exec('INSERT INTO flow VALUES (3,2)');
    add(4, 'tool-execution', 6, 2);
    add(5, 'assistant-message', 8, 3);
    add(6, 'tool-execution', 10, 5);
    add(7, 'provider-request', 9, 1); // Overlap alone must not suppress a distinct request.
    add(8, 'turn', 0, 6); // Native model/tool iteration is not the human unit.
    setup();
    const row = db.query(turnsPageQuery()).get() as Record<string, number | string>;
    expect(row).toMatchObject({prompt_id: 1, turn_number: 1, events: 5, model_calls: 2,
      tools: 2, unmatched_requests: 1, input_tokens: 20, output_tokens: 10,
      display_end_ts: 20 * MS, models_only_ns: 7 * MS, tools_only_ns: 6 * MS,
      overlap_ns: MS, unattributed_ns: 6 * MS, prompt_text: 'User request'});
    expect((db.query(turnEventsQuery(1)).all() as {id: number}[]).map(row => row.id)).toEqual([2,4,5,7,6]);
  } finally {db.close();}
});

test('turn headers retain distinct model/provider pairs without importing other turns or captures', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 10);
    for (let id = 2; id <= 7; id++) add(id, 'assistant-message', id, 0.5);
    db.exec("UPDATE agentprof_messages SET provider='provider-a', model='model-one' WHERE id IN (2,3);");
    db.exec("UPDATE agentprof_messages SET provider='provider-b', model='model-two' WHERE id=4;");
    db.exec("UPDATE agentprof_messages SET provider='provider-c', model='model-one' WHERE id=5;");
    db.exec("UPDATE agentprof_messages SET provider=NULL, model=NULL WHERE id=6;");
    db.exec("UPDATE agentprof_messages SET provider=' ', model=' ' WHERE id=7;");
    add(20, 'prompt', 20, 10);
    add(21, 'assistant-message', 21, 1);
    add(30, 'assistant-message', 35, 1);
    add(40, 'prompt', 40, 5);
    add(100, 'prompt', 0, 10, {capture: 2});
    add(101, 'assistant-message', 1, 1, {capture: 2});
    db.exec("UPDATE agentprof_messages SET provider='other-provider', model='other-model' WHERE id IN (21,30,101);");
    add(8, 'tool-execution', 8, 1);
    setup();
    const rows = db.query(turnsPageQuery()).all() as {prompt_id: number; model_identities: string}[];
    const identities = JSON.parse(rows.find(row => row.prompt_id === 1)!.model_identities);
    expect(identities.sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual([
        {provider: 'provider-a', model: 'model-one'}, {provider: 'provider-b', model: 'model-two'},
        {provider: 'provider-c', model: 'model-one'}, {provider: null, model: null},
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    expect(JSON.parse(rows.find(row => row.prompt_id === 20)!.model_identities))
      .toEqual([{provider: 'other-provider', model: 'other-model'}]);
    expect(JSON.parse(rows.find(row => row.prompt_id === 40)!.model_identities)).toEqual([]);
    expect(JSON.parse(rows.find(row => row.prompt_id === 100)!.model_identities))
      .toEqual([{provider: 'other-provider', model: 'other-model'}]);
  } finally {db.close();}
});

test('completed turn never includes idle time before the next user prompt', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 29_000);
    add(2, 'assistant-message', 1000, 23_000);
    add(3, 'prompt', 86_400_000, 11_000);
    setup();
    expect((db.query(turnsPageQuery()).all() as {display_end_ts: number}[])[0]!.display_end_ts).toBe(29_000 * MS);
  } finally {db.close();}
});

test('incomplete interaction shows only observed work and preserves unknown durations', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 86_400_000, {incomplete: true});
    add(2, 'assistant-message', 1000, 3000);
    add(3, 'tool-execution', 5000, -1, {incomplete: true});
    add(4, 'prompt', 10_000, 2000);
    setup();
    const rows = db.query(turnsPageQuery()).all() as {display_end_ts: number; prompt_text: string | null; unknown_tools: number}[];
    expect(rows[0]).toMatchObject({display_end_ts: 5000 * MS, prompt_text: null, unknown_tools: 1});
    const event = (db.query(turnEventsQuery(1)).all() as {id: number; measured_ns: number | null}[]).find(row => row.id === 3);
    expect(event?.measured_ns).toBeNull();
  } finally {db.close();}
});

test('nested ownership is unique while unrelated overlapping prompts remain ambiguous', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 20);
    add(2, 'prompt', 5, 5);
    add(3, 'tool-execution', 6, 1);
    add(4, 'prompt', 30, 20);
    add(5, 'prompt', 40, 20);
    add(6, 'tool-execution', 45, 1);
    add(7, 'tool-execution', 46, 1, {parent: 4});
    add(8, 'prompt', 30, 20, {capture: 2});
    add(9, 'tool-execution', 45, 1, {capture: 2});
    setup();
    const owners = db.query('SELECT id,prompt_id FROM agentprof_turn_events ORDER BY id').all();
    expect(owners).toEqual([{id:3,prompt_id:2},{id:6,prompt_id:null},{id:7,prompt_id:4},{id:9,prompt_id:8}]);
    expect(db.query(TURN_UNASSIGNED_QUERY).get()).toMatchObject({events: 1, tools: 1});
  } finally {db.close();}
});

test('native interaction identity wins over ambiguous containment', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 20, {args: {'debug.turn_id': 'first'}});
    add(2, 'prompt', 10, 20, {args: {'debug.turn_id': 'second'}});
    add(3, 'tool-execution', 15, 1, {args: {'debug.turn_id': 'first'}});
    setup();
    expect(db.query('SELECT prompt_id FROM agentprof_turn_events WHERE id=3').get()).toEqual({prompt_id: 1});
  } finally {db.close();}
});

test('pagination and expanded event queries are bounded', () => {
  const {db, add, setup} = fixture();
  try {
    for (let id = 1; id <= 205; id++) add(id, 'prompt', id * 1000, 900);
    for (let id = 1000; id < 1510; id++) add(id, 'tool-execution', 1001 + (id - 1000), 0);
    setup();
    const first = db.query(turnsPageQuery()).all() as {total_turns: number}[];
    expect(first).toHaveLength(200);
    expect(first[0]!.total_turns).toBe(205);
    expect(db.query(turnsPageQuery(200)).all()).toHaveLength(5);
    const events = db.query(turnEventsQuery(1)).all() as {total_events: number}[];
    expect(events).toHaveLength(500);
    expect(events[0]!.total_events).toBe(510);
    expect(() => turnEventsQuery(-1)).toThrow();
    expect(() => turnsPageQuery(Number.NaN)).toThrow();
  } finally {db.close();}
});

test('flow-linked requests are canonicalized even when ownership differs or is unknown', () => {
  for (const withPrompt of [false, true]) {
    const {db, add, setup} = fixture();
    try {
      add(1, 'provider-request', 9, 1);
      add(2, 'assistant-message', 11, 2);
      if (withPrompt) add(3, 'prompt', 10, 10);
      db.exec('INSERT INTO flow VALUES (1,2)');
      setup();
      expect(db.query('SELECT id FROM agentprof_turn_events ORDER BY id').all()).toEqual([{id: 2}]);
      expect(db.query(TURN_UNASSIGNED_QUERY).get()).toMatchObject({events: withPrompt ? 0 : 1});
    } finally {db.close();}
  }
});

test('large sequential captures use indexed clusters before page limits', () => {
  const {db, add, setup} = fixture();
  try {
    db.transaction(() => {
      for (let id = 1; id <= 5000; id++) add(id, 'prompt', id * 1000, 900);
      for (let prompt = 1; prompt <= 5000; prompt++) {
        for (let event = 0; event < 5; event++) add(10000 + prompt * 5 + event, 'tool-execution', prompt * 1000 + event * 10, 5);
      }
    })();
    setup();
    expect(db.query('SELECT COUNT(*) AS n FROM agentprof_turn_prompts').get()).toEqual({n: 5000});
    const rows = db.query(turnsPageQuery()).all() as {total_turns: number; tools: number}[];
    expect(rows).toHaveLength(200);
    expect(rows[0]).toMatchObject({total_turns: 5000, tools: 5});
  } finally {db.close();}
}, 5000);

test('request-ID correlation is half-open and preserves merely touching calls', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 30);
    add(2, 'provider-request', 0, 10, {args: {'debug.request_id': 'reused'}});
    add(3, 'assistant-message', 10, 5, {args: {'debug.request_id': 'reused'}});
    add(4, 'provider-request', 11, 1, {args: {'debug.request_id': 'reused'}});
    setup();
    expect(db.query('SELECT id FROM agentprof_turn_events ORDER BY id').all()).toEqual([{id: 2}, {id: 3}]);
  } finally {db.close();}
});

test('large flow-linked request captures use indexed canonicalization', () => {
  const {db, add, setup} = fixture();
  try {
    db.transaction(() => {
      add(1, 'prompt', 0, 100_000);
      for (let call = 0; call < 5000; call++) {
        const request = 10 + call * 2;
        add(request, 'provider-request', call * 10, 1);
        add(request + 1, 'assistant-message', call * 10, 5);
        db.prepare('INSERT INTO flow VALUES (?,?)').run(request, request + 1);
      }
    })();
    setup();
    expect(db.query('SELECT COUNT(*) AS n FROM agentprof_turn_events').get()).toEqual({n: 5000});
    expect(db.query('SELECT model_calls,unmatched_requests FROM agentprof_turns').get()).toEqual({model_calls: 5000, unmatched_requests: 0});
  } finally {db.close();}
}, 5000);

test('explicit prompt flows resolve overlapping turns and retain capture isolation', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 20); add(2, 'prompt', 10, 20);
    add(3, 'assistant-message', 15, 1); add(4, 'tool-execution', 16, 1);
    add(5, 'assistant-message', 15, 1, {capture: 2});
    db.exec('INSERT INTO flow VALUES (1,3),(3,4),(1,5)');
    setup();
    expect(db.query('SELECT id,prompt_id FROM agentprof_turn_events ORDER BY id').all())
      .toEqual([{id: 3,prompt_id: 1}, {id: 4,prompt_id: 1}, {id: 5,prompt_id: null}]);
  } finally {db.close();}
});

test('prompt ancestry traverses native parents but stops at nested captures and prompts', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 100);
    const native = db.prepare('INSERT INTO slice VALUES (?,?,1)');
    for (let id = 10; id < 110; id++) native.run(id, id === 10 ? 1 : id-1);
    add(2, 'prompt', 10, 50, {parent: 109});
    add(3, 'assistant-message', 20, 1, {parent: 2});
    add(4, 'tool-execution', 20, 1, {parent: 109});
    native.run(200, 1);
    db.exec('INSERT INTO agentprof_capture_markers VALUES (200,2)');
    add(5, 'tool-execution', 20, 1, {parent: 200, capture: 2});
    db.exec('UPDATE slice SET track_id=1 WHERE id=5');
    setup();
    expect(db.query('SELECT id,prompt_id FROM agentprof_turn_events ORDER BY id').all())
      .toEqual([{id:3,prompt_id:2},{id:4,prompt_id:1},{id:5,prompt_id:null}]);
  } finally {db.close();}
});

test('a reused native turn ID falls back to unique prompt ancestry', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 10, {args: {'debug.turn_id': 'reused'}});
    add(2, 'prompt', 20, 10, {args: {'debug.turn_id': 'reused'}});
    add(3, 'assistant-message', 21, 1, {parent: 2, args: {'debug.turn_id': 'reused'}});
    setup();
    expect(db.query('SELECT prompt_id FROM agentprof_turn_events WHERE id=3').get()).toEqual({prompt_id: 2});
  } finally {db.close();}
});

test('ambiguous request-ID matches cannot hide retries or consume explicitly linked responses', () => {
  for (const explicit of [false, true]) {
    const {db, add, setup} = fixture();
    try {
      add(1, 'prompt', 0, 30);
      add(2, 'provider-request', 0, 20, {args: {'debug.request_id': 'reused'}});
      add(3, 'provider-request', 5, 10, {args: {'debug.request_id': 'reused'}});
      add(4, 'assistant-message', 7, 5, {args: {'debug.request_id': 'reused'}});
      if (explicit) db.exec('INSERT INTO flow VALUES (3,4)');
      setup();
      expect(db.query('SELECT id FROM agentprof_turn_events ORDER BY id').all())
        .toEqual(explicit ? [{id: 2}, {id: 4}] : [{id: 2}, {id: 3}, {id: 4}]);
      expect(db.query('SELECT unmatched_requests FROM agentprof_turns').get())
        .toEqual({unmatched_requests: explicit ? 1 : 2});
    } finally {db.close();}
  }
});

test('one request-ID cannot silently merge distinct assistant messages', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 30);
    add(2, 'provider-request', 0, 20, {args: {'debug.request_id': 'reused'}});
    add(3, 'assistant-message', 5, 5, {args: {'debug.request_id': 'reused'}});
    add(4, 'assistant-message', 10, 5, {args: {'debug.request_id': 'reused'}});
    setup();
    expect(db.query('SELECT id FROM agentprof_turn_events ORDER BY id').all()).toEqual([{id:2}, {id:3}, {id:4}]);
  } finally {db.close();}
});

test('setup cleans partial prefixes and releases transient tables while details stay available', () => {
  const {db, add, setup} = fixture();
  try {
    add(1, 'prompt', 0, 10); add(2, 'tool-execution', 1, 5);
    db.exec('CREATE TABLE agentprof_turn_work(stale INTEGER); CREATE TABLE agentprof_turns(stale INTEGER)');
    setup(); setup();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'agentprof_turn*' ORDER BY name").all();
    expect(tables).toEqual([{name:'agentprof_turn_events'}, {name:'agentprof_turn_prompts'}, {name:'agentprof_turns'}]);
    expect(db.query(turnEventsQuery(1)).get()).toMatchObject({id:2, intent:'Recorded tool', total_events:1});
    expect(db.query("SELECT name FROM pragma_table_info('agentprof_turn_events') WHERE name IN ('arguments','intent')").all()).toEqual([]);
  } finally {db.close();}
});

test('mini timeline uses relative bigint arithmetic, clips intervals, and distinguishes points', () => {
  const origin = 1_700_000_000_000_000_000n;
  expect(intervalPosition(origin + 10n, origin + 30n, origin, origin + 100n)).toEqual({left: 10, width: 20, point: false});
  expect(intervalPosition(origin - 10n, origin + 120n, origin, origin + 100n)).toEqual({left: 0, width: 100, point: false});
  expect(intervalPosition(origin + 10n, origin + 10n, origin, origin + 100n).point).toBe(true);
  expect(nanoseconds(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  expect(turnDuration(null)).toBe('Not recorded');
  expect(turnDuration(500_000n)).toBe('<1 ms');
});
