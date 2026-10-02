// SPDX-License-Identifier: Apache-2.0
// Exercise the built UI and its WASM Trace Processor in a real browser.
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(resolve('third_party/src/perfetto/ui/package.json'));
const {chromium} = require('@playwright/test');
const server = process.argv.includes('--existing-server') ? undefined : spawn('python3', ['-m', 'http.server', '10000', '--bind', '127.0.0.1',
  '--directory', resolve('third_party/src/perfetto/out/agentprof/ui/dist')], {stdio: 'ignore'});
let browser;
let page;
try {
  for (let i = 0; i < 50; i++) {
    if (server && server.exitCode !== null) throw new Error('Test server failed; check whether port 10000 is occupied');
    try { if ((await fetch('http://127.0.0.1:10000/')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({headless: true});
  page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:10000/');
  const cookieButton = page.getByText('OK', {exact: true});
  if (await cookieButton.isVisible()) await cookieButton.click();
  const home = () => page.getByRole('heading', {name: 'See where your agent spends its time.', exact: true});
  const more = () => page.getByRole('button', {name: 'More options', exact: true}).click();
  const action = async name => {
    const direct = page.locator('.ap-navigation-actions').getByRole('button', {name, exact: true});
    if (await direct.isVisible()) return direct.click();
    await more();
    return page.getByRole('button', {name, exact: true}).click();
  };
  const nav = () => page.getByRole('navigation', {name: 'Main navigation'});
  const assertMainThreads = async expectedCount => {
    const result = await page.evaluate(async () => {
      const trace = window.app.trace;
      const rows = trace.currentWorkspace.flatTracks.flatMap(node => {
        const track = node.uri && trace.tracks.getTrack(node.uri);
        return track?.tags?.utid === undefined ? [] : [{name: node.name, uri: node.uri,
          utid: track.tags.utid, trackIds: track.tags.trackIds}];
      });
      const captures = await trace.engine.query("SELECT track_id, utid FROM agentprof_slices WHERE name IN ('profile (1)', 'prompt', 'attempt', 'turn')");
      const ids = [];
      for (const it = captures.iter({}); it.valid(); it.next())
        ids.push({id: Number(it.get('track_id')), utid: Number(it.get('utid'))});
      return {rows, ids};
    });
    assert.equal(result.rows.length, expectedCount, 'One native main-thread row per OS thread');
    assert.equal(new Set(result.rows.map(row => row.utid)).size, expectedCount);
    for (const row of result.rows) {
      assert.match(row.name, /^pi \d+$/);
      assert.ok(!row.uri.startsWith('dev.agentprof.Agentprof/'), 'Use the native thread renderer');
    }
    for (const capture of result.ids) assert.equal(result.rows.filter(row =>
      row.utid === capture.utid && row.trackIds.includes(capture.id)).length, 1,
      'Every capture and agent span must appear on exactly one main-thread row');
  };
  const assertTokenCounters = async expectedCount => {
    const counters = await page.evaluate(async () => {
      const trace = window.app.trace;
      const result = await trace.engine.query(`
        SELECT t.id, t.capture_id, cap.label, t.display_name AS name, COUNT(*) AS samples
        FROM agentprof_counter_tracks t JOIN counter c ON c.track_id = t.id
        LEFT JOIN agentprof_captures cap ON cap.capture_id = t.capture_id
        WHERE t.name IN ('llm.tokens.input', 'llm.tokens.output',
          'llm.context.estimated_tokens', 'llm.context.window_tokens')
        GROUP BY t.id ORDER BY t.id`);
      const recorded = [];
      for (const it = result.iter({}); it.valid(); it.next()) {
        recorded.push({id: Number(it.get('id')), capture: Number(it.get('capture_id')),
          label: it.get('label'), name: it.get('name'), samples: Number(it.get('samples'))});
      }
      const visible = [];
      const visit = (parent, captureLabel) => {
        if (parent.name?.startsWith('Capture ')) captureLabel = parent.name.slice('Capture '.length);
        for (const node of parent.children) {
          if (recorded.some(counter => counter.name === node.name)) {
            const track = trace.tracks.getTrack(node.uri);
            visible.push({id: track?.tags?.trackIds?.[0], captureLabel, name: node.name});
          }
          visit(node, captureLabel);
        }
      };
      visit(trace.currentWorkspace);
      return {recorded, visible: visible.sort((a, b) => a.id - b.id)};
    });
    assert.equal(counters.recorded.length, expectedCount);
    assert.ok(counters.recorded.every(counter => counter.samples > 0));
    assert.equal(counters.visible.length, counters.recorded.length,
      'Every sampled token counter appears once');
    for (const [index, visible] of counters.visible.entries()) {
      const recorded = counters.recorded[index];
      assert.equal(visible.id, recorded.id);
      assert.equal(visible.name, recorded.name);
      if (visible.captureLabel !== undefined) assert.equal(visible.captureLabel, recorded.label,
        'Shared-process counters appear under their own capture');
    }
  };
  const assertTopbarFits = async () => {
    await page.waitForTimeout(300); // Allow responsive transitions and ResizeObserver to settle.
    const boxes = await page.locator('.pf-topbar').evaluate(el => {
      const rect = node => {
        const r = node.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
      };
      return {width: window.innerWidth, regions: [...el.children].map(rect),
        controls: [...el.querySelectorAll('.ap-navigation > *, .ap-navigation-actions > *')].map(rect)};
    });
    for (const r of [...boxes.regions, ...boxes.controls]) {
      assert.ok(r.left >= 0 && r.right <= boxes.width, 'Top bar extends outside the viewport');
    }
    const search = boxes.regions[1];
    for (const control of boxes.controls) {
      assert.ok(control.right <= search.left || control.left >= search.right ||
        control.bottom <= search.top || control.top >= search.bottom, 'A control overlaps search');
    }
    assert.equal(await nav().locator('.ap-navigation__open .pf-button__label').evaluate(el =>
      el.clientWidth > 0 && el.scrollWidth > el.clientWidth), false, 'Open label is clipped');
    assert.ok(Math.abs((search.left + search.right) / 2 - boxes.width / 2) < 1, 'Search is not centered');
    for (const [i, a] of boxes.regions.entries()) for (const b of boxes.regions.slice(i + 1)) {
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        'Top bar controls overlap');
    }
  };
  await home().waitFor();
  assert.equal(await page.title(), 'Agent Profiler');
  assert.equal(await page.locator('.ap-home h1').evaluate(el => getComputedStyle(el).fontSize), '36px');
  assert.equal(await page.locator('.pf-sidebar').count(), 0);
  assert.equal(await nav().getByRole('link', {name: 'Overview', exact: true}).count(), 0);
  assert.equal(await nav().getByRole('link', {name: 'Timeline', exact: true}).count(), 0);
  await page.locator('.ap-navigation-actions').getByRole('button', {name: 'Dark mode', exact: true}).waitFor();
  await action('Dark mode');
  await page.screenshot({path: 'artifacts/screenshots/agentprof-home-dark.png'});
  assert.equal(await page.getByRole('button', {name: 'Dark mode', exact: true}).getAttribute('aria-pressed'), 'true');
  await action('Dark mode');
  await page.screenshot({path: 'artifacts/screenshots/agentprof-home.png'});
  for (const width of [1440, 1350, 1280, 1100, 1000, 900, 760, 390]) {
    await page.setViewportSize({width, height: 900});
    await assertTopbarFits();
    assert.equal(await page.locator('.ap-home').evaluate(el => el.scrollWidth > el.clientWidth), false);
  }
  await page.screenshot({path: 'artifacts/screenshots/agentprof-home-narrow.png'});
  await page.setViewportSize({width: 1440, height: 1000});
  assert.equal(await page.getByRole('button', {name: 'Open Pi comparison example'}).count(), 0);
  await page.getByRole('button', {name: 'Open pi-claude-opus-5 workflow example'}).click();
  await page.getByRole('heading', {name: 'What your trace says about agent activity'}).waitFor({timeout: 60000});
  await page.waitForURL(/agentprof_example=1/);
  const exampleCard = page.locator('.ap-card').filter({has: page.getByRole('heading',
    {name: 'What happened in this recording?', exact: true})});
  await exampleCard.locator('.ap-model-name').filter({hasText: 'claude-opus-5'}).waitFor();
  assert.deepEqual(await exampleCard.locator('.ap-model-name').allTextContents(), ['claude-opus-5']);
  assert.equal(await exampleCard.locator('tbody tr').count(), 1);
  const descriptionLines = await exampleCard.locator('p.ap-muted').first().evaluate(el =>
    el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight));
  assert.ok(descriptionLines < 1.5, 'Card description uses the available width');
  for (const width of [1440, 1350, 1280, 1201, 1200, 1100, 1000, 900, 760, 390]) {
    await page.setViewportSize({width, height: 1000});
    const overflow = await page.locator('.ap-page').evaluate(el => ({
      page: el.scrollWidth - el.clientWidth,
      tables: [...el.querySelectorAll('.ap-table-scroll')].map(table =>
        table.scrollWidth - table.clientWidth),
    }));
    assert.ok(overflow.page <= 1 && overflow.tables.every(extra => extra <= 1),
      `Overview has no horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`);
  }
  for (const width of [390, 1201, 1440]) {
    await page.setViewportSize({width, height: 1000});
    for (const [tab, heading] of [
      ['Responses', 'Responses by provider and model'],
      ['Tools', 'Tool summary'],
      ['Sessions', 'Captured sessions'],
    ]) {
      await page.locator('.ap-tabs .pf-tabs__tab-title').getByText(tab, {exact: true}).click();
      await page.getByRole('heading', {name: heading, exact: true}).waitFor();
      const overflow = await page.locator('.ap-page').evaluate(el => ({
        page: el.scrollWidth - el.clientWidth,
        tables: [...el.querySelectorAll('.ap-table-scroll')].map(table =>
          table.scrollWidth - table.clientWidth),
      }));
      assert.ok(overflow.page <= 1 && overflow.tables.every(extra => extra <= 1),
        `${tab} has no horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`);
      if (tab === 'Responses') {
        await page.locator('.ap-recorded-responses tbody tr').first().waitFor();
        const sessionLinksFit = await page.locator('.ap-recorded-responses tbody tr').evaluateAll(rows =>
          rows.every(row => {
            const cell = row.querySelector('td:first-child');
            const link = cell?.querySelector('.ap-table-link');
            return cell && link && link.getBoundingClientRect().right <=
              cell.getBoundingClientRect().right + 1;
          }));
        assert.ok(sessionLinksFit, `Recorded response sessions fit their cells at ${width}px`);
      }
    }
  }
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Summary', {exact: true}).click();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: 'artifacts/screenshots/agentprof-example-overview.png'});
  await page.reload();
  await exampleCard.locator('.ap-model-name').filter({hasText: 'claude-opus-5'}).waitFor({timeout: 60000});
  assert.equal(await exampleCard.locator('tbody tr').count(), 1);
  await page.getByRole('navigation', {name: 'Main navigation'})
    .getByRole('link', {name: 'Agent Profiler home', exact: true}).click();
  await home().waitFor();
  await page.getByRole('button', {name: 'Open pi-claude-opus-5 workflow example'}).click();
  const overview = () => page.getByRole('heading', {name: 'What your trace says about agent activity'});
  await overview().waitFor({timeout: 60000});
  await page.waitForURL(/agentprof_example=1/);
  assert.equal(await nav().getByRole('link', {name: 'Overview', exact: true}).getAttribute('aria-current'), 'page');
  await nav().getByRole('link', {name: 'Timeline', exact: true}).click();
  await page.waitForURL(/#!\/viewer.*agentprof_example=1/);
  await nav().locator('a[aria-current="page"][aria-label="Timeline"]').waitFor();
  const tools = await page.evaluate(async () => {
    const trace = window.app.trace;
    const nodes = trace.currentWorkspace.flatTracks;
    const tools = nodes.filter(n => n.name === 'Tools').map(n => ({uri: n.uri,
      ids: trace.tracks.getTrack(n.uri).tags.trackIds}));
    const result = await trace.engine.query("SELECT DISTINCT track_id FROM agentprof_slices WHERE kind='tool-execution'");
    const ids = [];
    for (const it = result.iter({}); it.valid(); it.next()) ids.push(Number(it.get('track_id')));
    return {tools, ids, names: nodes.map(n => n.name)};
  });
  assert.equal(tools.tools.length, 4, 'One tools row per process capture');
  assert.ok(tools.tools.every(t => t.uri.startsWith('/track_event_')), 'Use native merged tool renderers');
  assert.ok(tools.tools.some(t => t.ids.length > 1), 'Parallel tools share a visual row');
  assert.ok(tools.names.every(name => !/^(tools\.lane\.|workflow\.child\.)/.test(name)));
  for (const id of tools.ids) assert.equal(tools.tools.filter(t => t.ids.includes(id)).length, 1);
  const initialGroups = await page.evaluate(() => window.app.trace.currentWorkspace.children.map(n =>
    ({subtitle: n.subtitle, collapsed: n.collapsed})));
  assert.equal(initialGroups.filter(n => n.collapsed).length, 3, 'Subagent processes start collapsed');
  assert.equal(initialGroups.filter(n => !n.collapsed).length, 1, 'The parent process starts expanded');
  const diagnostics = await page.evaluate(() => window.app.trace.currentWorkspace.flatTracks
    .filter(n => n.name === 'Runtime' || n.name === 'Tracing')
    .map(n => ({name: n.name, collapsed: n.collapsed, children: n.children.map(c => c.name)})));
  assert.equal(diagnostics.length, 8, 'Each process capture has its own diagnostic groups');
  assert.ok(diagnostics.every(n => n.collapsed), 'Diagnostic groups start collapsed');
  for (const group of diagnostics) assert.deepEqual(group.children.sort(), group.name === 'Runtime'
    ? ['CPU time (interval)', 'JS heap', 'Resident memory'] : ['Dropped events', 'Lane overflows', 'Queue depth']);
  assert.ok(['Requests', 'Responses', 'Tools', 'Input tokens', 'Output tokens',
    'Context size', 'Context window']
    .every(name => tools.names.includes(name)), 'Readable track names are used throughout');
  assert.ok(!tools.names.includes('Agent'), 'No separate Agent track');
  const focusedLayout = await page.evaluate(() => window.app.trace.currentWorkspace.children
    .map(n => n.children.map(c => ({name: c.name, collapsed: c.collapsed, children: c.children.map(t => t.name)}))));
  for (const tracks of focusedLayout) {
    assert.ok(tracks.some(t => /^pi \d+$/.test(t.name)), 'Main Pi thread is directly under its process');
    assert.ok(tracks.some(t => t.name === 'Requests'), 'Request track is directly under its process');
    assert.ok(['Responses', 'Tools', 'Context size', 'Context window',
      'Token usage', 'Runtime', 'Tracing'].every(name => tracks.some(t => t.name === name)));
    assert.ok(!tracks.some(t => t.name === 'Agent' || t.name === 'Details'));
    assert.ok(tracks.filter(t => t.children.length).every(t => t.collapsed));
    assert.deepEqual(tracks.find(t => t.name === 'Token usage').children, ['Input tokens', 'Output tokens']);
  }
  await page.screenshot({path: 'artifacts/screenshots/agentprof-focused-timeline.png'});
  // Delegation uses native flows between processes within this one recording.
  const delegation = await page.evaluate(async () => {
    const trace = window.app.trace;
    const result = await trace.engine.query(`SELECT f.slice_out, f.slice_in FROM flow f
      JOIN slice src ON src.id=f.slice_out JOIN slice dst ON dst.id=f.slice_in
      WHERE src.name='subagent' AND dst.name='prompt-input'`);
    const links = [];
    for (const it = result.iter({}); it.valid(); it.next()) links.push({source: Number(it.get('slice_out')), target: Number(it.get('slice_in'))});
    if (links.length !== 3) throw new Error(`Expected 3 delegation flows, found ${links.length}`);
    await trace.selection.selectSqlEvent('slice', links[0].source);
    return links[0];
  });
  await page.waitForFunction(link => window.app.trace.flows.connectedFlows.some(
    flow => flow.begin.sliceId === link.source && flow.end.sliceId === link.target), delegation);
  await page.screenshot({path: 'artifacts/screenshots/agentprof-delegation-flow.png'});
  await page.evaluate(async link => {
    const trace = window.app.trace;
    await trace.selection.selectSqlEvent('slice', link.target, {scrollToSelection: true});
  }, delegation);
  await page.waitForFunction(() => {
    const trace = window.app.trace;
    const selection = trace.selection.selection;
    if (selection.kind !== 'track_event') return false;
    const node = trace.currentWorkspace.flatTracks.find(t => t.uri === selection.trackUri);
    if (!node) return false;
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.collapsed) return false;
    return true;
  });

  // Area selection must expose the existing Flow Events panel for our tracks.
  const expectedFlows = await page.evaluate(async () => {
    const trace = window.app.trace;
    const uris = new Set(trace.currentWorkspace.flatTracks.map(t => t.uri));
    const tracks = trace.tracks.getAllTracks().filter(t => uris.has(t.uri) && t.renderer.rootTableName === 'slice');
    if (!tracks.length || tracks.some(t => t.renderer.rootTableName !== 'slice'))
      throw new Error('Agent tracks must identify their root SQL table for area flows');
    trace.selection.selectArea({start: trace.traceInfo.start, end: trace.traceInfo.end,
      trackUris: tracks.map(t => t.uri)});
    const result = await trace.engine.query('SELECT COUNT(*) AS count FROM flow');
    return Number(result.iter({}).get('count'));
  });
  assert.ok(expectedFlows > 0);
  await page.waitForFunction(count => window.app.trace.flows.selectedFlows.length === count, expectedFlows);
  await page.getByText('Flow Events', {exact: true}).click();
  const flowGrid = page.locator('.pf-grid').filter({has: page.getByText('Flow Category', {exact: true})});
  const showAll = flowGrid.locator('label.pf-checkbox').first();
  await showAll.click();
  await page.waitForFunction(() => window.app.trace.flows.visibleCategories.get('_all_') === true);
  await page.screenshot({path: 'artifacts/screenshots/agentprof-flow-events.png'});
  await showAll.click();
  await page.waitForFunction(() => window.app.trace.flows.visibleCategories.get('_all_') === false);
  await page.evaluate(() => window.app.trace.selection.clearSelection());
  await nav().getByRole('link', {name: 'Overview', exact: true}).click();
  await overview().waitFor();
  await nav().getByRole('link', {name: 'Agent Profiler home', exact: true}).click();
  await home().waitFor();
  await nav().getByRole('link', {name: 'Overview', exact: true}).click();
  await overview().waitFor();
  await page.reload();
  await overview().waitFor({timeout: 60000});
  const runSummary = page.locator('.ap-card').filter({has: page.getByRole('heading', {name: 'What happened in this recording?', exact: true})});
  assert.deepEqual(await runSummary.locator('.ap-headline-label').allTextContents(),
    ['TOKENS/S', 'WALL WINDOW', 'MODEL BUSY', 'PEAK RESPONSES']);
  assert.equal(await runSummary.locator('.ap-headline-metric').nth(3).locator('strong').textContent(), '3');
  const recorded = JSON.parse(await readFile('examples/pi-opus-5/recording.json', 'utf8'));
  const assertRecordedRuns = async recordings => {
    const childIds = recordings.some(r => r.sessionId === recorded.workflow.parentSessionId)
      ? new Set(recorded.workflow.children.map(c => c.sessionId)) : new Set();
    const roots = recordings.filter(r => !childIds.has(r.sessionId)).map(r => {
      const family = r.sessionId === recorded.workflow.parentSessionId
        ? recordings.filter(c => c.sessionId === r.sessionId || childIds.has(c.sessionId)) : [r];
      const totals = {...r};
      for (const key of ['inputTokens', 'outputTokens', 'turns', 'responses', 'toolCalls'])
        totals[key] = family.reduce((sum, c) => sum + c[key], 0);
      return totals;
    });
    for (const r of roots) {
      const row = runSummary.locator('tbody tr').filter({has: page.locator('td:nth-child(5)').filter({hasText: new RegExp(`^${r.outputTokens.toLocaleString('en-US')}$`)})});
      await row.waitFor();
      const cells = await row.locator('td').allTextContents();
      assert.equal(await row.getByRole('img', {name: 'Pi', exact: true}).count(), 1);
      assert.equal(await row.locator('.ap-prompt-link .pf-button__label').textContent(),
        'Fix summarizeIntervals in intervals.mjs...');
      assert.equal(await row.getByRole('button', {name: /^Open prompt:/}).count(), 1);
      assert.equal(cells[1], r.model + r.provider);
      assert.deepEqual(cells.slice(3, 5), [r.inputTokens.toLocaleString('en-US'),
        r.outputTokens.toLocaleString('en-US')]);
      assert.ok(Number(cells[5]) > 0);
      assert.ok(parseFloat(cells[6]) > 0);
      assert.match(cells[7], / s$/);
      assert.match(cells[8], /^\d+\.\d%$/);
      assert.equal(await row.locator('.ap-spark__bar').count(), 48);
      const barWidths = await row.locator('.ap-cellbar--stacked .ap-cellbar__track')
        .evaluateAll(tracks => tracks.map(track => track.getBoundingClientRect().width));
      assert.equal(barWidths.length, 2);
      assert.ok(Math.abs(barWidths[0] - barWidths[1]) < 0.5);
      assert.ok(barWidths[0] < 120);
      assert.equal(await row.locator('.ap-cellbar--stacked .ap-cellbar__pct:first-child').count(), 2);
      assert.equal(cells.length, 9);
    }
    assert.equal(await runSummary.locator('tbody tr').count(), roots.length);
    assert.equal(await runSummary.getByRole('columnheader', {name: 'Session', exact: true}).count(), 1);
    for (const name of ['Capture', 'Provider', 'Effort', 'Peak responses', 'Turns',
      'Tool calls', 'Incomplete operations', 'Model responses', 'Peak context', 'Max context window']) {
      assert.equal(await runSummary.getByRole('columnheader', {name, exact: true}).count(), 0);
    }
    const starts = await page.evaluate(async () => {
      const result = await window.app.trace.engine.query('SELECT session, CAST(MIN(ts) AS TEXT) AS start_ns FROM agentprof_slices GROUP BY capture_id, session');
      const values = {};
      for (const it = result.iter({}); it.valid(); it.next()) values[it.get('session')] = it.get('start_ns');
      return values;
    });
    for (const r of recordings) assert.ok(Math.abs(Number(starts[r.sessionId]) - Number(r.startNs)) < 12e6);
    if (recorded.workflow && recorded.workflow.children.every(child => recordings.some(r => r.sessionId === child.sessionId))) {
      const edges = await page.evaluate(async () => {
        const result = await window.app.trace.engine.query(`
          SELECT DISTINCT p.session AS parent, c.session AS child,
            EXTRACT_ARG(c.arg_set_id, 'debug.subagent_type') AS role
          FROM agentprof_slices p JOIN agentprof_slices c
            ON EXTRACT_ARG(p.arg_set_id, 'debug.child_session') = c.session
          WHERE EXTRACT_ARG(p.arg_set_id, 'debug.delegation') = 1 AND c.name IN ('profile (1)', 'child-start subagent')
            AND EXTRACT_ARG(c.arg_set_id, 'debug.parent_session') = p.session`);
        const rows = [];
        for (const it = result.iter({}); it.valid(); it.next())
          rows.push([it.get('parent'), it.get('child'), it.get('role')]);
        return rows.sort((a, b) => a[2].localeCompare(b[2]));
      });
      assert.deepEqual(edges, recorded.workflow.children.map(child =>
        [recorded.workflow.parentSessionId, child.sessionId, child.role]).sort((a, b) => a[2].localeCompare(b[2])));
    }
    assert.equal(await page.locator('.ap-error').count(), 0);
  };
  await assertRecordedRuns(recorded.recordings.filter(r => recorded.bundledFiles.includes(r.file)));
  await assertTokenCounters(16);
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Sessions', {exact: true}).click();
  await page.getByRole('heading', {name: 'Captured sessions', exact: true}).waitFor();
  const capturedRows = page.locator('.ap-session-table:not(.ap-session-table--subagents) > tbody > .ap-session-row');
  const capturedRecordings = recorded.recordings.filter(r => recorded.bundledFiles.includes(r.file));
  const parent = capturedRecordings.find(r => !r.parentSessionId);
  assert.equal(await capturedRows.count(), 1);
  assert.equal(await page.locator('.ap-session-table:not(.ap-session-table--subagents) > thead th').last().textContent(), '');
  assert.equal(await capturedRows.first().getByRole('img', {name: 'Pi', exact: true}).count(), 1);
  assert.equal(await capturedRows.first().locator('.ap-model-name').textContent(), parent.model);
  assert.equal(await capturedRows.first().getByRole('button', {name: /^Open prompt:/}).count(), 1);
  await capturedRows.first().getByRole('button', {name: /^Show details for session/}).click();
  assert.equal(await capturedRows.first().getByRole('button', {name: /^Hide details for session/})
    .getAttribute('aria-expanded'), 'true');
  const expandedParent = page.locator('.ap-session-table:not(.ap-session-table--subagents) > tbody > .ap-session-expanded');
  const detailColumns = () => expandedParent.locator('.ap-session-details').first()
    .evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(await detailColumns(), 4);
  const fact = (scope, label) => scope.locator('.ap-session-fact').filter({has:
      page.getByText(label, {exact: true})}).locator('.ap-session-fact__value');
  assert.equal(await fact(expandedParent, 'Session ID').textContent(), parent.sessionId);
  assert.equal(await fact(expandedParent, 'Role').textContent(), 'Primary');
  const childRows = expandedParent.locator('.ap-session-table--subagents > tbody > .ap-session-row');
  assert.equal(await childRows.count(), capturedRecordings.length - 1);
  for (const r of capturedRecordings.filter(r => r.parentSessionId)) {
    const child = childRows.filter({hasText: `Subagent · ${r.role}`});
    assert.equal(await child.count(), 1);
    assert.equal(await child.locator('.ap-model-name').textContent(), r.model);
    await child.getByRole('button', {name: /^Show details for session/}).click();
    const details = child.locator('xpath=following-sibling::tr[1]');
    assert.equal(await fact(details, 'Session ID').textContent(), r.sessionId);
    assert.equal(await fact(details, 'Input tokens').textContent(), r.inputTokens.toLocaleString('en-US'));
    assert.equal(await fact(details, 'Output tokens').textContent(), r.outputTokens.toLocaleString('en-US'));
    assert.equal(await fact(details, 'Responses').textContent(), String(r.responses));
    assert.equal(await fact(details, 'Tool calls').textContent(), String(r.toolCalls));
    assert.equal(await child.locator('.ap-spark__bar').count(), 48);
  }
  await capturedRows.first().locator('td').nth(1).click();
  await capturedRows.first().getByRole('button', {name: /^Show details for session/}).waitFor();
  assert.equal(await expandedParent.count(), 0);
  await capturedRows.first().locator('td').nth(1).click();
  await expandedParent.waitFor();
  await page.setViewportSize({width: 390, height: 1000});
  assert.equal(await page.locator('.ap-page').evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.equal(await detailColumns(), 2);
  await page.setViewportSize({width: 1440, height: 1000});
  await page.evaluate(() => {
    window.sessionRowClicks = 0;
    document.querySelector('.ap-session-table:not(.ap-session-table--subagents) > tbody > .ap-session-row')
      .addEventListener('click', () => window.sessionRowClicks++);
  });
  await capturedRows.first().getByRole('button', {name: /^Open prompt:/}).click();
  await page.waitForURL(/viewer/);
  assert.equal(await page.evaluate(() => window.sessionRowClicks), 0);
  await nav().getByRole('link', {name: 'Overview', exact: true}).click();
  await page.getByRole('heading', {name: 'Captured sessions', exact: true}).waitFor();
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Summary', {exact: true}).click();
  await overview().waitFor();
  await assertMainThreads(4);
  await page.screenshot({path: 'artifacts/screenshots/agentprof-overview.png'});
  const realProcesses = await page.evaluate(() => window.app.trace.currentWorkspace.children.map(node => ({
    name: node.name, uri: node.uri, subtitle: node.subtitle,
  })));
  assert.equal(realProcesses.length, recorded.bundledFiles.length);
  assert.ok(realProcesses.every(group => /^pi \d+/.test(group.name) && group.uri.startsWith('/process_')));
  for (const r of recorded.recordings.filter(r => recorded.bundledFiles.includes(r.file))) {
    assert.ok(realProcesses.some(group => group.subtitle?.includes(`session:${r.sessionId}`)));
  }
  const recordedPromptId = await page.evaluate(async sessionId => {
    const result = await window.app.trace.engine.query(`SELECT id FROM agentprof_slices
      WHERE name = 'prompt' AND session = '${sessionId}' LIMIT 1`);
    return Number(result.iter({}).get('id'));
  }, recorded.workflow.parentSessionId);
  await runSummary.locator('.ap-prompt-link').click();
  await page.waitForURL(/#!\/viewer/);
  await page.waitForFunction(id => {
    const selection = window.app.trace.selection.selection;
    return selection.kind === 'track_event' && selection.eventId === id;
  }, recordedPromptId);
  await nav().getByRole('link', {name: 'Overview', exact: true}).click();
  await overview().waitFor();

  // Independently exercise the file merger with the original real recordings.
  const previousEngine = await page.evaluate(() => window.app.trace.engine.engineId);
  const [recordedChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    nav().getByRole('button', {name: 'Open trace file', exact: true}).click(),
  ]);
  const bundledRecordings = recorded.recordings.filter(r => recorded.bundledFiles.includes(r.file));
  await recordedChooser.setFiles(bundledRecordings.map(r => resolve('examples/pi-opus-5', r.file)));
  await page.getByText('All traces line up on the shared timeline.', {exact: true}).waitFor({timeout: 60000});
  await page.getByRole('button', {name: /Open Traces/}).click();
  await page.waitForFunction(id => window.app.trace && window.app.trace.engine.engineId !== id, previousEngine);
  await overview().waitFor({timeout: 60000});
  await assertRecordedRuns(bundledRecordings);
  await assertTokenCounters(16);
  await page.screenshot({path: 'artifacts/screenshots/agentprof-real-merged.png'});

  // Keep deterministic coverage for overlap, missing usage, errors, and truncation.
  await page.locator('input.trace_file').setInputFiles(resolve('artifacts/examples/synthetic.pftrace'));
  await page.locator('.ap-banner').filter({hasText: 'synthetic.pftrace'}).waitFor({timeout: 60000});
  await page.getByText('Up to 2 tools ran at once.', {exact: true}).waitFor();
  const runCells = await runSummary.locator('tbody tr td').allTextContents();
  assert.equal(runCells[2], 'agentprof-exampl...');
  assert.deepEqual(runCells.slice(0, 2), ['', 'opus-5synthetic']);
  assert.deepEqual(runCells.slice(3, 7), ['280', '65', '50', '0.2%']);
  assert.match(runCells[8], /^\d+\.\d%$/);
  assert.equal(runCells.length, 9);
  assert.equal(await runSummary.locator('.ap-prompt-link').count(), 0);
  await assertTokenCounters(4);
  await assertMainThreads(1);
  assert.equal(await runSummary.getByRole('columnheader', {name: 'Incomplete operations', exact: true}).count(), 0);
  await page.getByRole('heading', {name: 'How responsive was the model?', exact: true}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Run comparison', exact: true}).count(), 0);
  assert.equal(await page.locator('.ap-error').count(), 0);
  await page.getByRole('button', {name: /Agent activity · Summary/}).click();
  await page.locator('.pf-menu-item').filter({hasText: 'Sessions'}).click();
  await page.getByRole('heading', {name: 'Captured sessions', exact: true}).waitFor();
  await page.locator('.ap-session-table > tbody > .ap-session-row').first()
    .getByRole('button', {name: /^Show details for session/}).click();
  const incompleteFact = page.locator('.ap-session-table > tbody > .ap-session-expanded .ap-session-fact')
    .filter({has: page.getByText('Incomplete operations', {exact: true})});
  await incompleteFact.waitFor();
  assert.equal(await incompleteFact.locator('.ap-session-fact__value').textContent(), '1');
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Summary', {exact: true}).click();
  await page.getByRole('button', {name: /Full recording/}).click();
  await page.locator('.pf-menu-item').filter({hasText: 'Full recording'}).click();
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Responses', {exact: true}).click();
  await page.getByRole('heading', {name: 'Recorded responses', exact: true}).waitFor();
  await page.getByRole('button', {name: 'agentprof-example', exact: true}).first().click();
  await page.getByText('pi-example 1001', {exact: true}).waitFor();
  await page.locator('a[href="#!/agentprof"]').click();
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Tools', {exact: true}).waitFor();
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Tools', {exact: true}).click();
  await page.getByRole('button', {name: 'bash', exact: true}).first().click();
  await page.getByText('pi-example 1001', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.app.trace.currentWorkspace.flatTracks
    .find(t => t.name === 'Child workflows')?.parent?.name), 'pi-example 1001');
  await page.getByText('example-bash', {exact: true}).filter({visible: true}).first().waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({path: 'artifacts/screenshots/agentprof-timeline.png'});
  await page.keyboard.press('Control+Shift+p');
  await page.getByPlaceholder('Filter commands...').fill('Agent Profiler: Slow tools');
  await page.keyboard.press('Enter');
  await page.getByText('example-bash', {exact: true}).filter({visible: true}).first().waitFor();
  await page.screenshot({path: 'artifacts/screenshots/agentprof-tools.png'});
  // A normal file import must also choose Overview by default.
  await page.locator('input.trace_file').setInputFiles(resolve('artifacts/examples/synthetic.pftrace'));
  await overview().waitFor({timeout: 60000});
  await page.getByText('Up to 2 tools ran at once.', {exact: true}).waitFor();
  assert.equal(await page.locator('.ap-error').count(), 0);
  for (const width of [1440, 1350, 1280, 1100, 1000, 900, 760, 390]) {
    await page.setViewportSize({width, height: 900});
    await assertTopbarFits();
    await action('Settings');
    await page.waitForURL(/#!\/settings/);
    await nav().getByRole('link', {name: 'Overview', exact: true}).click();
    await overview().waitFor();
  }
  await page.setViewportSize({width: 900, height: 900});
  await page.screenshot({path: 'artifacts/screenshots/agentprof-overview-narrow.png'});
  assert.equal(await page.locator('.ap-page').evaluate(el => el.scrollWidth > el.clientWidth), false);
  await page.setViewportSize({width: 1440, height: 1000});
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    nav().getByRole('button', {name: 'Open trace file', exact: true}).click(),
  ]);
  await chooser.setFiles(['code-mode', 'classic', 'unknown'].map(name => resolve(`artifacts/examples/comparison/${name}.pftrace`)));
  await page.getByText('All traces line up on the shared timeline.', {exact: true}).waitFor({timeout: 60000});
  await page.getByRole('button', {name: /Open Traces/}).click();
  await overview().waitFor({timeout: 60000});
  const comparison = page.locator('.ap-card').filter({has: page.getByRole('heading', {name: 'What happened in this recording?', exact: true})});
  await comparison.getByText('model-0', {exact: true}).waitFor();
  assert.equal(await comparison.locator('tbody tr').count(), 3);
  await page.getByRole('heading', {name: 'How responsive were model responses?', exact: true}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'How responsive was the model?', exact: true}).count(), 0);
  const modelLabel = label => ({'code-mode': 'model-0', classic: 'model-1,model-2', unknown: 'Not recorded'})[label];
  const row = label => comparison.locator('tbody tr').filter({has: page.locator('.ap-model-name').filter({hasText: new RegExp(`^${modelLabel(label).split(',')[0]}$`)})});
  assert.deepEqual(await comparison.locator('thead th').allTextContents().then(cells => cells.slice(0, 3)),
    ['Agent', 'Model', 'Session']);
  assert.deepEqual((await row('code-mode').locator('td').allTextContents()).slice(1, 7),
    ['model-0synthetic', 'comparison-sessi...', '100', '20', 'Not recorded', '0.4%']);
  assert.deepEqual((await row('classic').locator('td').allTextContents()).slice(1, 7),
    ['model-1syntheticmodel-2synthetic', 'comparison-sessi...', '180', '45', 'Not recorded', 'Not recorded']);
  assert.deepEqual((await row('unknown').locator('td').allTextContents()).slice(1, 7),
    ['Not recorded', 'other-session', ...Array(4).fill('Not recorded')]);
  assert.equal(await comparison.locator('tbody tr').filter({hasText: 'model-0'}).locator('td').nth(8).textContent(), 'Not recorded');
  assert.equal(await comparison.locator('.ap-spark').count(), 0);
  assert.equal(await page.locator('.ap-error').count(), 0);
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Sessions', {exact: true}).click();
  await page.getByRole('heading', {name: 'Captured sessions', exact: true}).waitFor();
  const comparisonRows = page.locator('.ap-session-table:not(.ap-session-table--subagents) > tbody > .ap-session-row');
  assert.equal(await comparisonRows.count(), 3);
  const classicRow = comparisonRows.filter({has: page.getByText('model-1', {exact: true})});
  assert.deepEqual(await classicRow.locator('.ap-model-name').allTextContents(), ['model-1', 'model-2']);
  await classicRow.getByRole('button', {name: /^Show details for session/}).click();
  await classicRow.locator('xpath=following-sibling::tr[1]').locator('code').waitFor();
  assert.equal(await classicRow.locator('xpath=following-sibling::tr[1]').locator('code').count(), 1);
  await page.locator('.ap-tabs .pf-tabs__tab-title').getByText('Summary', {exact: true}).click();
  const actualStarts = await page.evaluate(async () => {
    const result = await window.app.trace.engine.query(`
      SELECT capture, CAST(MIN(ts) AS TEXT) AS start_ns
      FROM agentprof_slices GROUP BY capture_id, capture`);
    const rows = {};
    for (const it = result.iter({}); it.valid(); it.next()) rows[it.get('capture')] = it.get('start_ns');
    return rows;
  });
  const expectedStarts = JSON.parse(await readFile('artifacts/examples/comparison/expected-starts.json', 'utf8'));
  for (const label of ['code-mode', 'classic', 'unknown']) {
    assert.ok(Math.abs(Number(actualStarts[label]) - Number(expectedStarts[label])) < 12e6,
      `${label}: browser clock alignment differs from the recorded real time`);
  }
  await page.screenshot({path: 'artifacts/screenshots/agentprof-multi-file.png'});
  await page.getByRole('button', {name: 'Open timeline'}).click();
  for (const label of ['code-mode', 'classic']) {
    await page.getByText(`Capture ${label}`, {exact: true}).waitFor();
  }
  const processGroups = await page.evaluate(() => window.app.trace.currentWorkspace.children.map(node => ({
    name: node.name, uri: node.uri, subtitle: node.subtitle,
    captures: node.children.filter(child => child.name.startsWith('Capture ')).map(child => ({name: child.name, uri: child.uri})),
  })));
  assert.equal(processGroups.length, 2, 'Three captures on two processes must have two process rows');
  assert.ok(processGroups.every(group => group.uri.startsWith('/process_')));
  assert.equal(processGroups.flatMap(group => group.captures).length, 2);
  assert.ok(processGroups.flatMap(group => group.captures).every(capture => capture.uri === undefined));
  await assertTokenCounters(8);
  await assertMainThreads(2);
  // Multiple sessions in one protobuf file use the same summary automatically.
  await page.locator('input.trace_file').setInputFiles({
    name: 'sessions.pftrace', mimeType: 'application/octet-stream',
    buffer: Buffer.concat(await Promise.all(['code-mode', 'classic', 'unknown'].map(name =>
      readFile(`artifacts/examples/comparison/${name}.pftrace`)))),
  });
  await overview().waitFor({timeout: 60000});
  await comparison.getByText('model-0', {exact: true}).waitFor();
  assert.equal(await comparison.locator('tbody tr').count(), 3);
  await page.getByRole('heading', {name: 'How responsive were model responses?', exact: true}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'How responsive was the model?', exact: true}).count(), 0);
  for (const label of ['code-mode', 'classic', 'unknown']) {
    const cells = await row(label).locator('td').allTextContents();
    assert.equal((await row(label).locator('.ap-model-name').allTextContents()).join(','), modelLabel(label));
    assert.equal(cells.length, 9);
  }
  assert.equal(await page.locator('.ap-error').count(), 0);
  await page.screenshot({path: 'artifacts/screenshots/agentprof-sessions.png'});
  // One session can switch models or have no model metadata at all.
  for (const label of ['classic', 'unknown']) {
    await page.locator('input.trace_file').setInputFiles(resolve(`artifacts/examples/comparison/${label}.pftrace`));
    await page.locator('.ap-banner').filter({hasText: `${label}.pftrace`}).waitFor({timeout: 60000});
    await overview().waitFor({timeout: 60000});
    await row(label).waitFor();
    assert.equal(await comparison.locator('tbody tr').count(), 1);
    await page.getByRole('heading', {name: 'How responsive were model responses?', exact: true}).waitFor();
    assert.equal(await page.getByRole('heading', {name: 'How responsive was the model?', exact: true}).count(), 0);
  }
  // Two logical agents on one host process are generic children of one real process.
  await page.locator('input.trace_file').setInputFiles(['agent-a', 'agent-b'].map(name =>
    resolve(`artifacts/examples/logical-agents/${name}.pftrace`)));
  await page.getByRole('button', {name: /Open Traces/}).click();
  await overview().waitFor({timeout: 60000});
  await comparison.locator('tbody tr').nth(1).waitFor();
  const shared = await page.evaluate(() => window.app.trace.currentWorkspace.children.map(node => ({
    uri: node.uri, name: node.name, subtitle: node.subtitle,
    captures: node.children.map(child => ({name: child.name, uri: child.uri, subtitle: child.subtitle})),
  })));
  assert.equal(shared.length, 1);
  assert.equal(shared[0].name, 'shared-host 4321');
  assert.ok(shared[0].uri.startsWith('/process_'));
  assert.equal(shared[0].subtitle, undefined);
  assert.deepEqual(shared[0].captures.map(c => c.name).sort(), ['Capture agent-a', 'Capture agent-b']);
  assert.ok(shared[0].captures.every(c => c.uri === undefined));
  await nav().getByRole('link', {name: 'Timeline', exact: true}).click();
  await page.getByText('Capture agent-a', {exact: true}).waitFor();
  await page.screenshot({path: 'artifacts/screenshots/agentprof-shared-process.png'});
  // A process containing both a root and workers stays expanded; only its
  // subagent capture groups start collapsed, including nested workers.
  await page.locator('input.trace_file').setInputFiles(resolve('artifacts/examples/logical-agents/hierarchy.pftrace'));
  await page.locator('.ap-banner').filter({hasText: 'hierarchy.pftrace'}).waitFor({timeout: 60000});
  await overview().waitFor();
  await comparison.getByText('parent-model', {exact: true}).waitFor();
  assert.equal(await comparison.locator('tbody tr').count(), 7);
  const hierarchyGroups = await page.evaluate(() => window.app.trace.currentWorkspace.children.map(n => ({
    name: n.name, collapsed: n.collapsed,
    captures: n.children.map(c => ({name: c.name, collapsed: c.collapsed,
      groups: c.children.filter(g => ['Runtime', 'Tracing'].includes(g.name))
        .map(g => ({name: g.name, collapsed: g.collapsed, children: g.children.map(t => t.name)}))})),
  })));
  assert.equal(hierarchyGroups.length, 1);
  assert.equal(hierarchyGroups[0].collapsed, false);
  assert.equal(hierarchyGroups[0].captures.length, 10);
  for (const [i, name] of ['root', 'child', 'grandchild', 'unknown-usage'].entries()) {
    assert.equal(hierarchyGroups[0].captures.find(c => c.name === `Capture ${name}-${i}`).collapsed, i > 0);
  }
  const legacyGroups = hierarchyGroups[0].captures.find(c => c.name === 'Capture root-0').groups;
  assert.deepEqual(legacyGroups, [
    {name: 'Runtime', collapsed: true, children: ['Resident memory']},
    {name: 'Tracing', collapsed: true, children: ['Dropped events']},
  ], 'Old flat diagnostic counters receive the same display names and grouping');
  // An agent with no OS process association must not gain a process row.
  await page.locator('input.trace_file').setInputFiles(resolve('artifacts/examples/logical-agents/unattached.pftrace'));
  await page.locator('.ap-banner').filter({hasText: 'unattached.pftrace'}).waitFor({timeout: 60000});
  await overview().waitFor({timeout: 60000});
  const unattached = await page.evaluate(() => window.app.trace.currentWorkspace.children.map(node => ({
    uri: node.uri, name: node.name, subtitle: node.subtitle,
  })));
  assert.deepEqual(unattached, [{uri: undefined, name: 'Capture unattached', subtitle: 'Session unattached-agent'}]);
  await page.locator('input.trace_file').setInputFiles(resolve('artifacts/examples/import-error.pftrace'));
  await page.locator('.ap-banner').filter({hasText: 'import-error.pftrace'}).waitFor({timeout: 60000});
  await page.locator('.pf-topbar__error-box button').waitFor({timeout: 60000});
  // The URL's cache key must match the loaded trace before navigating, or
  // Perfetto treats the click as a request to load a different trace.
  await page.waitForFunction(
    () => new URLSearchParams(location.hash.split('?')[1] ?? '').get('local_cache_key') === window.app.trace.traceInfo.uuid,
    undefined, {timeout: 60000});
  assert.ok(await page.evaluate(() => window.app.trace.traceInfo.importErrors > 0));
  await page.locator('.pf-topbar__error-box button').click();
  await page.waitForURL(/#!\/info/);
  await page.getByText('Import Errors', {exact: true}).first().click();
  await page.getByText('clock_sync_failure_unknown_source_clock', {exact: true}).first().waitFor();
  await page.locator('input.trace_file').setInputFiles({
    name: 'ordinary-trace.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({traceEvents: [
      {name: 'ordinary work', cat: 'test', ph: 'X', ts: 0, dur: 1000, pid: 1, tid: 1},
    ]})),
  });
  await page.waitForURL(/#!\/viewer/);
  await page.getByRole('button', {name: /workspaces/}).waitFor();
  assert.equal(await page.locator('.ap-page').count(), 0);
  assert.equal(await nav().getByRole('link', {name: 'Overview', exact: true}).count(), 0);
  await nav().locator('a[aria-current="page"][aria-label="Timeline"]').waitFor();
  await action('Query (SQL)');
  await page.waitForURL(/#!\/query/);
  await more();
  await page.getByRole('button', {name: 'Close recording', exact: true}).click();
  await home().waitFor();
  assert.equal(await nav().getByRole('link', {name: 'Timeline', exact: true}).count(), 0);
  await page.reload();
  await home().waitFor();
  assert.deepEqual(errors, [], 'Browser reported JavaScript errors');
  console.log('PASS browser: real Pi example, recorded-file merge, overview, reload, model/tool drill-down, file import, narrow layout, multi-file and single-file session summaries, model-aware headings, native process labels, shared-process and unattached agents, ordinary trace fallback');
} catch (error) {
  if (page) {
    await mkdir('artifacts/screenshots', {recursive: true});
    await page.screenshot({path: 'artifacts/screenshots/agentprof-failure.png'});
    console.error(await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  server?.kill();
}
