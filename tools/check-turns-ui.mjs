// SPDX-License-Identifier: Apache-2.0
// Browser checks use retained examples and synthetic fixtures, never a model.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const checkout = resolve(root, 'third_party/src/perfetto');
const require = createRequire(resolve(checkout, 'ui/package.json'));
const {chromium} = require('@playwright/test');
const url = 'http://127.0.0.1:10000';

export async function checkTurns(page) {
  await page.locator('.ap-tabs .pf-tab-strip__tab-title').getByText('Turns', {exact: true}).click();
  await page.locator('.ap-turn').first().waitFor();
  assert.equal(await page.locator('.ap-turn-details').count(), 0, 'Details are lazy');
  const rows = await page.evaluate(async () => {
    const result = await window.app.trace.engine.query('SELECT turn_number, incomplete, display_end_ts-start_ts AS duration, model_calls, tools, models_only_ns, tools_only_ns, overlap_ns FROM agentprof_turns ORDER BY start_ts');
    const rows = [];
    for (const it = result.iter({}); it.valid(); it.next()) rows.push(Object.fromEntries(result.columns().map(key => [key, Number(it.get(key))])));
    return rows;
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {turn_number: 1, incomplete: 0, duration: 3_700_000_000,
    model_calls: 3, tools: 4, models_only_ns: 1_700_000_000,
    tools_only_ns: 1_300_000_000, overlap_ns: 200_000_000});
  assert.equal(rows[1].incomplete, 1);
  const first = page.locator('.ap-turn').first();
  assert.equal(await first.locator('.ap-turn-models').textContent(), 'opus-5 · synthetic');
  assert.equal(await first.locator('.ap-turn-session').textContent(), 'Session agentprof-example');
  assert.equal(await first.locator('.ap-turn-session').getAttribute('title'), 'Session agentprof-example');
  const summary = first.locator('.ap-turn-summary');
  await page.mouse.move(0, 0);
  const normalBackground = await summary.evaluate(element => getComputedStyle(element).backgroundColor);
  const cardBackground = await first.evaluate(element => getComputedStyle(element).backgroundColor);
  await first.locator('.ap-turn-prompt').hover();
  const hoverBackground = await summary.evaluate(element => getComputedStyle(element).backgroundColor);
  assert.notEqual(hoverBackground, normalBackground, 'Hover highlights the clickable summary');
  assert.equal(await first.evaluate(element => getComputedStyle(element).backgroundColor), cardBackground);
  assert.equal(await first.getByRole('button', {name: /^Expand turn /}).getAttribute('aria-expanded'), 'false');
  await first.locator('.ap-turn-prompt').click();
  await first.locator('.ap-turn-event-link').first().waitFor();
  assert.equal(await first.getByRole('button', {name: /Model response$/}).count(), 3);
  const eventLabels = await first.locator('.ap-turn-event-label').allTextContents();
  assert.ok(eventLabels.every(label => !label.includes('opus-5') && !label.includes('synthetic')),
    'Model/provider identity appears once in the turn header, not in response rows');
  assert.ok(eventLabels.some(label => label.includes('first content') && label.includes('output tokens')));
  await first.locator('.ap-turn-details').hover({position: {x: 5, y: 5}});
  assert.equal(await summary.evaluate(element => getComputedStyle(element).backgroundColor), normalBackground,
    'An expanded summary is not highlighted without hover');
  assert.equal(await first.evaluate(element => getComputedStyle(element).backgroundColor), cardBackground,
    'Hovering details does not highlight the whole card');
  await first.locator('.ap-turn-description').first().click();
  assert.equal(await first.getByRole('button', {name: /^Collapse turn /}).getAttribute('aria-expanded'), 'true');
  await first.getByRole('button', {name: /^Collapse turn /}).click();
  await first.locator('.ap-turn-details').waitFor({state: 'detached'});
  for (const selector of ['.ap-turn-activity', '.ap-turn-legend']) {
    await first.locator(selector).click();
    await first.locator('.ap-turn-details').waitFor();
    await first.locator(selector).click();
    await first.locator('.ap-turn-details').waitFor({state: 'detached'});
  }
  await summary.click({position: {x: 4, y: 4}});
  await first.locator('.ap-turn-details').waitFor();
  await summary.click({position: {x: 4, y: 4}});
  await first.locator('.ap-turn-details').waitFor({state: 'detached'});
  await first.locator('.ap-turn-number').click();
  await first.getByRole('button', {name: /^Collapse turn /}).waitFor();
  await first.getByRole('button', {name: /^Collapse turn /}).click();
  await first.locator('.ap-turn-details').waitFor({state: 'detached'});
  await first.getByRole('button', {name: /^Expand turn /}).focus();
  await page.keyboard.press('Enter');
  await first.getByRole('button', {name: /^Collapse turn /}).waitFor();
  await first.locator('.ap-turn-details').waitFor();
  await page.keyboard.press('Space');
  await first.locator('.ap-turn-details').waitFor({state: 'detached'});
  await page.keyboard.press('Space');
  await first.locator('.ap-turn-details').waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    assert.equal(await page.locator('.ap-page').evaluate(element => element.scrollWidth > element.clientWidth), false);
    const position = await first.locator('.ap-turn-header').evaluate(header => {
      const arrow = header.querySelector('.ap-turn-toggle');
      return {last: arrow === header.lastElementChild, icon: arrow.textContent.trim(),
        arrow: arrow.getBoundingClientRect().right, edge: header.getBoundingClientRect().right};
    });
    assert.equal(position.last, true);
    assert.equal(position.icon, 'expand_less');
    assert.ok(Math.abs(position.arrow - position.edge) < 2, 'Session-style arrow stays at the header’s right edge');
    await page.screenshot({path: resolve(root, `artifacts/screenshots/turns-${width}.png`), fullPage: true});
  }
  await first.locator('.ap-turn-event-link').first().click();
  await page.waitForURL(/#!\/viewer/);
  await page.waitForFunction(() => window.app.trace.selection.selection.kind === 'track_event');
  await page.getByRole('navigation', {name: 'Main navigation'}).getByRole('link', {name: 'Overview', exact: true}).click();
  await page.locator('.ap-tabs .pf-tab-strip__tab-title').getByText('Turns', {exact: true}).click();
  await page.locator('.ap-turn').first().waitFor();
  assert.equal(await page.locator('.ap-error').count(), 0, 'Setup survives remount after timeline navigation');
  const expandAgain = page.locator('.ap-turn').first().getByRole('button', {name: /^Expand turn /});
  if (await expandAgain.count()) await expandAgain.click();
  await page.locator('.ap-turn-event-link').first().waitFor();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.getByRole('button', {name: 'Dark mode', exact: true}).click();
  await page.screenshot({path: resolve(root, 'artifacts/screenshots/turns-dark.png'), fullPage: true});
  await page.getByRole('button', {name: 'Dark mode', exact: true}).click();
}

async function checkSetupRetry(page) {
  await page.evaluate(() => {
    const engine = window.app.trace.engine;
    const original = engine.query.bind(engine);
    let fail = true;
    engine.query = async sql => {
      if (sql.includes('CREATE PERFETTO TABLE agentprof_turn_prompts')) {
        window.turnSetupSql = sql;
        if (fail) {
          fail = false;
          await original('CREATE TABLE agentprof_turn_work(stale INTEGER)');
          throw new Error('Synthetic setup failure');
        }
        engine.query = original;
      }
      return original(sql);
    };
  });
  await page.locator('.ap-tabs .pf-tab-strip__tab-title').getByText('Turns', {exact: true}).click();
  await page.getByRole('button', {name: 'Retry turns', exact: true}).first().click();
  await page.locator('.ap-turn').first().waitFor();
  assert.equal(await page.locator('.ap-error').count(), 0, 'Retry recovers after a partially completed native setup');
}

async function checkTurnStress(page) {
  const result = await page.evaluate(async () => {
    const engine = window.app.trace.engine;
    const sql = window.turnSetupSql.replaceAll('agentprof_', 'stress_agentprof_')
      .replaceAll('FROM slice s', 'FROM stress_slice s').replaceAll('flow f', 'stress_flow f');
    const cleanup = sql.slice(0, sql.indexOf('CREATE PERFETTO TABLE stress_agentprof_turn_prompts'));
    const inputs = ['stress_agentprof_slices','stress_slice','stress_flow','stress_agentprof_messages',
      'stress_agentprof_tool_calls','stress_agentprof_capture_runs','stress_agentprof_capture_markers',
      'stress_agentprof_script_children'];
    try {
      await engine.query(`
        CREATE TABLE stress_agentprof_slices AS
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
        SELECT CAST(1000000+n AS INTEGER) AS id, 1 AS capture_id, 'stress' AS session, 'stress' AS capture,
          ((n-1)/100)*10000+1 AS ts, 1 AS dur, 0 AS incomplete, 'tool-execution' AS kind,
          'tool' AS name, NULL AS arg_set_id, 1 AS track_id FROM seq;
        INSERT INTO stress_agentprof_slices
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000)
        SELECT n,1,'stress','stress',(n-1)*10000,9000,0,'prompt','prompt',NULL,1 FROM seq;
        CREATE INDEX stress_slices_id ON stress_agentprof_slices(id);
        CREATE TABLE stress_slice AS SELECT id, track_id, CASE WHEN kind='prompt' THEN NULL
          WHEN (id-1000001)%100=0 THEN (id-1000001)/100+1 ELSE id-1 END AS parent_id
          FROM stress_agentprof_slices;
        CREATE INDEX stress_slice_id ON stress_slice(id);
        CREATE TABLE stress_flow AS
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000)
        SELECT CAST(10000000+n AS INTEGER) AS slice_out, CAST(20000000+n AS INTEGER) AS slice_in FROM seq;
        CREATE INDEX stress_flow_out ON stress_flow(slice_out);
        CREATE INDEX stress_flow_in ON stress_flow(slice_in);
        CREATE TABLE stress_agentprof_messages(id INTEGER PRIMARY KEY, message_start_ts INTEGER,
          message_ns INTEGER,provider TEXT,model TEXT,first_ns INTEGER,input_tokens INTEGER,output_tokens INTEGER);
        CREATE TABLE stress_agentprof_tool_calls AS SELECT id, 'Recorded tool' AS intent,
          printf('%0512d', id) AS arguments, 0 AS args_truncated, NULL AS language, NULL AS line_count,
          NULL AS call_id,NULL AS parent_call_id,0 AS is_error FROM stress_agentprof_slices WHERE kind='tool-execution';
        CREATE INDEX stress_tool_id ON stress_agentprof_tool_calls(id);
        CREATE TABLE stress_agentprof_capture_runs(capture_id INTEGER PRIMARY KEY,start_ts INTEGER,end_ts INTEGER,session TEXT);
        INSERT INTO stress_agentprof_capture_runs VALUES(1,0,10000000,'stress');
        CREATE TABLE stress_agentprof_capture_markers(slice_id INTEGER,capture_id INTEGER);
        CREATE TABLE stress_agentprof_script_children(script_id INTEGER,id INTEGER,depth INTEGER);
      `);
      console.log('Turns stress inputs ready');
      const start = performance.now();
      await engine.query(sql);
      console.log('Turns stress setup complete');
      const elapsed = performance.now() - start;
      const counts = await engine.query(`SELECT (SELECT COUNT(*) FROM stress_agentprof_turns) AS turns,
        (SELECT COUNT(*) FROM stress_agentprof_turn_events) AS events,
        (SELECT MIN(tools) FROM stress_agentprof_turns) AS tools,
        (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name GLOB 'stress_agentprof_turn*') AS retained`);
      const row = counts.iter({});
      return {elapsed, turns: Number(row.get('turns')), events: Number(row.get('events')),
        tools: Number(row.get('tools')), retained: Number(row.get('retained'))};
    } finally {
      await engine.query(cleanup + inputs.map(name => 'DROP TABLE IF EXISTS ' + name + ';').join('\n'));
    }
  });
  assert.deepEqual({turns: result.turns, events: result.events, tools: result.tools, retained: result.retained},
    {turns: 1000, events: 100000, tools: 100, retained: 3});
  assert.ok(result.elapsed < 30000, 'WASM setup must not repeatedly scan unrelated flows or shared ancestry');
  console.log('Turns WASM stress: 100,000 operations, 1,000,000 unrelated indexed flows; setup ' + result.elapsed.toFixed(0) + ' ms');
}

async function main() {
  console.log('Starting local Turns browser checks');
  await mkdir(resolve(root, 'artifacts/screenshots'), {recursive: true});
  console.log('Screenshot directory ready');
  let server;
  if (!process.argv.includes('--existing-server')) {
    try {await fetch(url, {signal: AbortSignal.timeout(1000)}); throw new Error('Port 10000 already has a server; use --existing-server intentionally');}
    catch (error) {if (error.message.includes('already has')) throw error;}
    console.log('Starting UI server');
    server = spawn(process.execPath, ['ui/build.mjs', '--out', 'out/agentprof', '--serve', '--no-build', '--no-depscheck', '--bundle', '--serve-host', '127.0.0.1', '--serve-port', '10000'],
      {cwd: checkout, detached: true, stdio: ['ignore', 'inherit', 'inherit']});
  }
  let browser;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {if ((await fetch(url, {signal: AbortSignal.timeout(1000)})).ok) break;} catch {}
      if (attempt === 199) throw new Error('UI server did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log('UI server ready; starting Chromium');
    browser = await chromium.launch({headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    page.on('pageerror', error => console.error('Browser error:', error));
    page.on('console', message => {if (message.text().startsWith('Turns stress')) console.log(message.text());});
    await page.goto(url + '/?testing=1');
    await page.locator('.ap-home').waitFor();
    for (const agent of ['Claude Code', 'Codex', 'Muse Code', 'Pi']) {
      console.log('Checking Turns:', agent);
      await page.getByRole('group', {name: 'Recording agent'}).getByRole('button', {name: agent, exact: true}).click();
      await page.locator('.ap-home__example').click();
      await page.locator('.ap-session-summary tbody tr').first().waitFor({timeout: 60000});
      await page.locator('.ap-tabs .pf-tab-strip__tab-title').getByText('Turns', {exact: true}).click();
      await page.locator('.ap-turn').first().waitFor({timeout: 60000});
      await page.locator('.ap-turn').first().getByRole('button', {name: /^Expand turn /}).click();
      await page.locator('.ap-turn-details').first().waitFor();
      assert.equal(await page.locator('.ap-error').count(), 0, `${agent} original SQL works in WASM`);
      if (agent === 'Claude Code') {
        const model = page.locator('.ap-turn-models').first();
        assert.equal(await model.textContent(), 'claude-haiku-4-5 · anthropic');
        assert.equal(await model.getAttribute('title'), 'claude-haiku-4-5-20251001 · anthropic');
        const session = page.locator('.ap-turn-session').first();
        assert.equal(await session.textContent(), 'Session 27bf59a7');
        assert.equal(await session.getAttribute('title'), 'Session 27bf59a7-adec-48ad-964d-00ab0504a0cd');
      }
      await page.evaluate(() => {window.app.closeCurrentTrace(); window.app.navigate('#!/?local_cache_key=');});
      await page.locator('.ap-home').waitFor();
    }
    await page.locator('input.trace_file').setInputFiles(resolve(root, 'artifacts/examples/synthetic.pftrace'));
    await page.locator('.ap-session-summary tbody tr').first().waitFor({timeout: 60000});
    console.log('Checking native setup retry');
    await checkSetupRetry(page);
    console.log('Checking synthetic Turns UI');
    await checkTurns(page);
    console.log('Checking large WASM fixture');
    await checkTurnStress(page);
    console.log('Turns browser checks passed for all four harness examples and synthetic multi-cycle work.');
  } catch (error) {
    console.error('Turns browser check failed:', error);
    throw error;
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) {
      const closed = new Promise(resolve => server.once('close', resolve));
      try {process.kill(-server.pid, 'SIGTERM');} catch {}
      const force = setTimeout(() => {try {process.kill(-server.pid, 'SIGKILL');} catch {}}, 2000);
      await closed;
      clearTimeout(force);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
