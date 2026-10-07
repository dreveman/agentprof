// SPDX-License-Identifier: Apache-2.0
import {expect, test} from 'bun:test';
import {OverviewLoader, TAB_QUERIES, type OverviewSection} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_loader.ts';
import {OVERVIEW_QUERIES} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';
import {Database} from 'bun:sqlite';

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('Overview fetches only visible tabs and caches shared/in-flight sections', async () => {
  const requested: OverviewSection[] = [];
  const pending = new Map<OverviewSection, (rows: string[]) => void>();
  const loader = new OverviewLoader<string>(key => {
    requested.push(key);
    return new Promise(resolve => pending.set(key, resolve));
  }, () => {});
  loader.open('Summary');
  await turn();
  expect(new Set(requested)).toEqual(new Set(TAB_QUERIES.Summary));
  expect(requested).not.toContain('context_changes');
  expect(requested).not.toContain('responses');
  expect(requested).not.toContain('script_calls');
  loader.open('Responses'); loader.open('Responses');
  loader.open('Context');
  await turn();
  expect(requested.filter(key => key === 'models')).toHaveLength(1);
  expect(requested.filter(key => key === 'context_latest')).toHaveLength(1);
  expect(requested.filter(key => key === 'responses')).toHaveLength(1);
  expect(['context_snapshots', 'context_changes', 'context_history', 'context_compactions']
    .every(key => requested.includes(key as OverviewSection))).toBe(true);
  loader.open('Sessions'); loader.open('Tools');
  await turn();
  expect(new Set(requested)).toEqual(new Set(Object.keys(OVERVIEW_QUERIES)));
  for (const [key, finish] of pending) finish([key]);
  await turn();
  expect(loader.data.responses?.rows).toEqual(['responses']);
  loader.open('Summary'); loader.open('Tools');
  await turn();
  expect(requested).toHaveLength(Object.keys(OVERVIEW_QUERIES).length);
});

test('Tools avoids script queries when Summary confirms no scripts', async () => {
  const requested: OverviewSection[] = [];
  const loader = new OverviewLoader<{scripts?: number}>(async key => {
    requested.push(key); return [{scripts: key === 'summary' ? 0 : undefined}];
  }, () => {});
  loader.open('Summary'); await turn();
  loader.open('Tools'); await turn();
  expect(requested).toContain('slow');
  expect(requested).not.toContain('scripts');
  expect(requested).not.toContain('script_calls');
});

test('Overview isolates failures and ignores late results after disposal', async () => {
  let changed = 0;
  let resolve!: (rows: string[]) => void;
  const loader = new OverviewLoader<string>(key => key === 'slow' ? Promise.reject(new Error('bad section')) :
    key === 'summary' ? new Promise(done => {resolve = done;}) : Promise.resolve([key]), () => {changed++;});
  loader.open('Tools');
  await turn();
  expect(loader.data.slow?.error).toContain('bad section');
  expect(loader.data.tools?.rows).toEqual(['tools']);
  const before = changed;
  loader.dispose();
  resolve(['late']);
  await turn();
  expect(loader.data.summary?.rows).toBeUndefined();
  expect(changed).toBe(before);
  const neverStarted: OverviewSection[] = [];
  const removed = new OverviewLoader(key => {neverStarted.push(key); return Promise.resolve([]);}, () => {});
  removed.open('Summary'); removed.dispose();
  await turn();
  expect(neverStarted).toEqual([]);
});

test('context detail SQL caps recent rows without losing the latest sample of an older capture', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE agentprof_context_snapshots(event_id INTEGER, capture_id INTEGER, ts INTEGER, categories TEXT);
      CREATE TABLE agentprof_capture_hierarchy(capture_id INTEGER, root_capture_id INTEGER);
      CREATE TABLE agentprof_capture_runs(capture_id INTEGER, harness TEXT, session TEXT, end_ts INTEGER, context_window_tokens INTEGER);
      CREATE TABLE agentprof_context_changes(delta_tokens INTEGER, ts INTEGER);
      CREATE TABLE agentprof_counter_tracks(id INTEGER, capture_id INTEGER, name TEXT);
      CREATE TABLE counter(track_id INTEGER, ts INTEGER, value INTEGER);
      CREATE TABLE agentprof_slices(id INTEGER, capture_id INTEGER, ts INTEGER, dur INTEGER, arg_set_id INTEGER, kind TEXT, incomplete INTEGER);
      INSERT INTO agentprof_capture_hierarchy VALUES (1,1),(2,2);
      INSERT INTO agentprof_capture_runs VALUES (1,'pi','old',3000,1000),(2,'pi','new',3000,1000);`);
    const insert = db.prepare('INSERT INTO agentprof_context_snapshots VALUES (?,?,?,?)');
    db.transaction(() => {
      insert.run(1, 1, 0, '{"prompts":10}');
      for (let i = 1; i <= 2001; i++) insert.run(i + 1, 2, i, '{"prompts":20}');
    })();
    const latest = db.query(OVERVIEW_QUERIES.context_latest).all() as Array<{capture_id: number; ts: number}>;
    expect(latest.map(row => [row.capture_id, row.ts])).toEqual([[1, 0], [2, 2001]]);
    const detail = db.query(OVERVIEW_QUERIES.context_snapshots).all() as Array<{capture_id: number; ts: number}>;
    expect(detail).toHaveLength(2000);
    expect(detail[0]!.ts).toBe(2);
    expect(detail.at(-1)!.ts).toBe(2001);
    expect(detail.every(row => row.capture_id === 2)).toBe(true);
    expect(db.query(OVERVIEW_QUERIES.context_changes).all()).toEqual([]);
    expect(db.query(OVERVIEW_QUERIES.context_history).all()).toEqual([]);
    // Perfetto's EXTRACT_ARG is unavailable in Bun SQLite; its bounded SQL
    // is checked structurally below and by the pinned processor in CI.
  } finally {db.close();}
});

test('context detail queries are bounded while Summary keeps latest per capture', () => {
  expect(OVERVIEW_QUERIES.context_latest).toContain('PARTITION BY capture_id');
  expect(OVERVIEW_QUERIES.context_snapshots).toContain('LIMIT 2000');
  expect(OVERVIEW_QUERIES.context_history).toContain('LIMIT 2000');
  expect(OVERVIEW_QUERIES.context_changes).toContain('LIMIT 500');
  expect(OVERVIEW_QUERIES.context_compactions).toContain('LIMIT 500');
});
