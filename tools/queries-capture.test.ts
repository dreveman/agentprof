// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {SLICE_CAPTURE_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';

test('indexed child lookup handles a deep slice chain without repeated full scans', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE slice(id INTEGER PRIMARY KEY, parent_id INTEGER, category TEXT, track_id INTEGER);
      CREATE TABLE agentprof_capture_markers(slice_id INTEGER, capture_id INTEGER);
      INSERT INTO slice VALUES (1,NULL,'pi.metadata',1);
      INSERT INTO agentprof_capture_markers VALUES (1,100);`);
    const insert = db.prepare('INSERT INTO slice VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let id = 2; id <= 10001; id++) insert.run(id, id - 1, 'pi.agent', 1);
    })();
    db.exec(SLICE_CAPTURE_SQL.replace('CREATE PERFETTO TABLE', 'CREATE TABLE'));
    expect(db.query('SELECT COUNT(*) AS mapped, COUNT(DISTINCT id) AS unique_ids FROM agentprof_slice_capture').get())
      .toEqual({mapped: 10001, unique_ids: 10001});
  } finally {db.close();}
}, 5000);

test('temporary lookup ignores unrelated tracks and is empty without markers', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE slice(id INTEGER PRIMARY KEY, parent_id INTEGER, category TEXT, track_id INTEGER);
      CREATE TABLE agentprof_capture_markers(slice_id INTEGER, capture_id INTEGER);
      INSERT INTO slice VALUES (1,NULL,'pi.metadata',1),(2,1,'pi.agent',1);
      INSERT INTO agentprof_capture_markers VALUES (1,100);`);
    const insert = db.prepare('INSERT INTO slice VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let id = 3; id <= 10002; id++) insert.run(id, id === 3 ? null : id - 1, 'unrelated.category', 99);
    })();
    const lookup = /CREATE TABLE agentprof_slice_parent_lookup AS[\s\S]*?;/.exec(SLICE_CAPTURE_SQL)![0];
    db.exec(lookup);
    expect(db.query('SELECT COUNT(*) AS edges FROM agentprof_slice_parent_lookup').get()).toEqual({edges: 1});
    db.exec('DROP TABLE agentprof_slice_parent_lookup');
    db.exec(SLICE_CAPTURE_SQL.replace('CREATE PERFETTO TABLE', 'CREATE TABLE'));
    expect(db.query('SELECT id, capture_id FROM agentprof_slice_capture ORDER BY id').all())
      .toEqual([{id: 1, capture_id: 100}, {id: 2, capture_id: 100}]);
    db.exec('DELETE FROM agentprof_capture_markers');
    db.exec(lookup);
    expect(db.query('SELECT COUNT(*) AS edges FROM agentprof_slice_parent_lookup').get()).toEqual({edges: 0});
  } finally {db.close();}
});

test('nearest enclosing marker assigns each slice once, across non-agent parents', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE slice(id INTEGER PRIMARY KEY, parent_id INTEGER, category TEXT, track_id INTEGER);
      CREATE TABLE agentprof_capture_markers(slice_id INTEGER, capture_id INTEGER);
      INSERT INTO slice VALUES
        (1,NULL,'pi.metadata',1), (2,1,'pi.agent',1), (3,1,'pi.metadata',1),
        (4,3,'pi.agent',1), (5,1,'pi.agent',1), (6,4,'unrelated.category',1),
        (7,6,'pi.tools',1), (8,NULL,'pi.agent',2), (9,NULL,'pi.metadata',3),
        (10,9,'pi.agent',3);
      INSERT INTO agentprof_capture_markers VALUES (1,100),(3,200),(9,300);`);
    db.exec(SLICE_CAPTURE_SQL.replace('CREATE PERFETTO TABLE', 'CREATE TABLE'));
    const rows = db.query('SELECT id, capture_id FROM agentprof_slice_capture ORDER BY id').all();
    expect(rows).toEqual([
      {id: 1, capture_id: 100}, {id: 2, capture_id: 100},
      {id: 3, capture_id: 200}, {id: 4, capture_id: 200},
      {id: 5, capture_id: 100}, {id: 7, capture_id: 200},
      {id: 9, capture_id: 300}, {id: 10, capture_id: 300},
    ]);
    expect(db.query('SELECT COUNT(*) = COUNT(DISTINCT id) AS unique_ids FROM agentprof_slice_capture').get())
      .toEqual({unique_ids: 1});
    // An agent slice without an enclosing marker still uses its track/process
    // fallback at the consumer join; the mapping must not invent an owner.
    expect(db.query(`SELECT COALESCE(m.capture_id, 999) AS capture_id
      FROM slice s LEFT JOIN agentprof_slice_capture m USING(id) WHERE s.id = 8`).get())
      .toEqual({capture_id: 999});
  } finally {db.close();}
});
