// SPDX-License-Identifier: Apache-2.0

import type {PerfettoPlugin} from '../../public/plugin';
import m from 'mithril';
import {markExample, navigate} from './navigation';
import {Overview} from './overview';
import {OVERVIEW_SETUP_SQL} from './overview_queries';
import type {App} from '../../public/app';
import type {Trace} from '../../public/trace';
import {TrackNode} from '../../public/workspace';
import {SliceTrack} from '../../components/tracks/slice_track';
import {ThreadSliceDetailsPanel} from '../../components/details/thread_slice_details_tab';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, NUM_NULL, STR, STR_NULL} from '../../trace_processor/query_result';
import QueryPagePlugin from '../dev.perfetto.QueryPage';
import TrackEventPlugin from '../dev.perfetto.TrackEvent';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';
import {QUERIES, SETUP_SQL} from './queries';
import {trackDisplayName} from './track_names';
import {EXAMPLE_TRACE_BASE64} from './example_trace';
import {COMPARISON_EXAMPLE_TRACE_BASE64} from './comparison_example_trace';

export default class implements PerfettoPlugin {
  static readonly id = 'dev.agentprof.Agentprof';
  static readonly description = 'Agent timelines and analysis for coding harness recordings';
  static readonly dependencies = [QueryPagePlugin, TrackEventPlugin];

  static onActivate(app: App): void {
    const openExample = async (id: string, title: string, base64: string) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const trace = await app.openTraceFromBuffer({
        buffer: bytes.buffer,
        title,
        fileName: `${title}.pftrace`,
      });
      markExample(trace, id);
      // Reload the bundled fixture on refresh, including regenerated data.
      app.navigate(`#!/agentprof?agentprof_example=${id}&local_cache_key=`);
    };
    const commandId = `${devId()}.OpenExample`;
    app.commands.registerCommand({
      id: commandId,
      name: 'Open workflow example',
      callback: () => openExample('1', 'pi-workflow', EXAMPLE_TRACE_BASE64),
    });
    const comparisonCommandId = `${devId()}.OpenComparisonExample`;
    app.commands.registerCommand({
      id: comparisonCommandId, name: 'Open Pi vs Claude Code example',
      callback: () => openExample('comparison', 'pi-vs-claude-code', COMPARISON_EXAMPLE_TRACE_BASE64),
    });
    app.sidebar.addMenuItem({section: 'trace_files', commandId: comparisonCommandId, icon: 'compare_arrows', sortOrder: 2.7});
    app.sidebar.addMenuItem({
      section: 'trace_files', commandId, icon: 'smart_toy', sortOrder: 2.6,
    });
    const requestedExample = app.initialRouteArgs.agentprof_example;
    const exampleId = requestedExample === 'codemode' ? 'comparison' : requestedExample;
    if (exampleId === '1' || exampleId === 'comparison') {
      // Clear any old cache key before the startup route handler runs.
      window.history.replaceState(null, '', `#!/agentprof?agentprof_example=${exampleId}&local_cache_key=`);
      void app.commands.runCommand(exampleId === '1' ? commandId : comparisonCommandId);
    }
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    const detected = await trace.engine.query(
      `SELECT COUNT(*) AS count FROM slice WHERE category GLOB 'pi.*'
        OR (category = 'agentprof.metadata' AND EXTRACT_ARG(arg_set_id, 'debug.kind') = 'capture'
          AND EXTRACT_ARG(arg_set_id, 'debug.schema_version') = 1)`,
    );
    if (detected.firstRow({count: NUM}).count === 0) return;
    await trace.engine.query(SETUP_SQL);
    await trace.engine.query(OVERVIEW_SETUP_SQL);
    trace.pages.registerPage({route: '/agentprof', render: () => m(Overview, {trace, key: trace.engine.engineId})});
    trace.commands.registerCommand({
      id: `${devId()}.OpenOverview`, name: 'Open Agent Profiler overview',
      callback: () => navigate(trace, '/agentprof'),
    });
    trace.sidebar.addMenuItem({section: 'current_trace', text: 'Overview',
      href: '#!/agentprof', action: () => navigate(trace, '/agentprof'), icon: 'dashboard', sortOrder: 0});
    trace.initialPage.suggest('/agentprof', 100);

    const workspace = trace.workspaces.createEmptyWorkspace('Agent Profiler');
    const tracks = await trace.engine.query(`
      WITH captures AS (
        SELECT capture_id, session, MIN(upid) AS upid, MAX(h.is_subagent) AS is_subagent FROM agentprof_slices
        JOIN agentprof_capture_hierarchy h USING(capture_id)
        GROUP BY capture_id, session
      ), processes AS (
        SELECT upid, COUNT(DISTINCT capture_id) AS captures,
          COUNT(DISTINCT session) AS sessions, MIN(is_subagent) AS all_subagents FROM captures GROUP BY upid
      ), sessions AS (
        SELECT session, COUNT(DISTINCT upid) AS processes FROM captures GROUP BY session
      )
      SELECT s.track_id, s.capture_id, s.upid, s.utid, s.session, s.capture, c.label AS capture_label, s.track_name,
        COALESCE(p.captures, 0) AS process_captures,
        h.is_subagent, COALESCE(p.all_subagents, 0) AS all_subagents,
        (p.sessions = 1 AND a.processes = 1) AS single_agent
      FROM agentprof_slices s JOIN agentprof_capture_hierarchy h USING(capture_id)
      LEFT JOIN processes p USING(upid) LEFT JOIN sessions a USING(session)
      LEFT JOIN agentprof_captures c ON c.capture_id = s.capture_id
      GROUP BY s.track_id, s.capture_id ORDER BY s.upid, s.capture_id, s.track_id
    `);
    const processTracks = trace.plugins.getPlugin(ProcessThreadGroupsPlugin);
    const processes = new Map<number, TrackNode>();
    const captures = new Map<number, TrackNode>();
    const threadTracks = new Set<number>();
    const mergedSliceTracks = new Set<string>();
    const order: Record<string, number> = {
      'Requests': 5, 'Responses': 10, 'Tools': 20, 'Compaction': 25,
      'Context size': 30, 'Context window': 31,
      'Token usage': 40, 'Runtime': 60, 'Tracing': 70,
    };
    const groups = new Map<TrackNode, Map<string, TrackNode>>();
    const collapsedGroup = (parent: TrackNode, name: string): TrackNode => {
      let children = groups.get(parent);
      if (children === undefined) {
        children = new Map();
        groups.set(parent, children);
      }
      let group = children.get(name);
      if (group === undefined) {
        group = new TrackNode({name, isSummary: true, collapsed: true, sortOrder: order[name]});
        parent.addChildInOrder(group);
        children.set(name, group);
      }
      return group;
    };

    for (const row = tracks.iter({track_id: NUM, capture_id: NUM, upid: NUM_NULL, utid: NUM_NULL,
      session: STR, capture: STR, capture_label: STR_NULL, track_name: STR, process_captures: NUM, single_agent: NUM_NULL, is_subagent: NUM, all_subagents: NUM});
      row.valid(); row.next()) {
      let processGroup = row.upid === null ? undefined : processes.get(row.upid);
      if (processGroup === undefined && row.upid !== null) {
        const nativeProcess = processTracks.getGroupForProcess(row.upid);
        if (nativeProcess !== undefined) {
          processGroup = nativeProcess.clone();
          if (row.all_subagents) processGroup.collapse();
          else processGroup.expand();
          // A process label cannot identify an individual agent when that
          // process hosts several sessions (or a session spans processes).
          if (!row.single_agent) processGroup.subtitle = undefined;
          processes.set(row.upid, processGroup);
          workspace.addChildLast(processGroup);
        }
      }
      let group = captures.get(row.capture_id);
      if (group === undefined) {
        if (processGroup !== undefined && row.process_captures === 1) {
          group = processGroup;
        } else {
          const label = row.capture_label ?? row.session.split('/').at(-1)!.slice(0, 8);
          group = new TrackNode({name: `${row.is_subagent ? 'Subagent session' : 'Session'} ${label}`,
            subtitle: `Session ${row.session} · Capture ${row.capture}`,
            isSummary: true, collapsed: Boolean(row.is_subagent)});
          (processGroup ?? workspace).addChildInOrder(group);
        }
        captures.set(row.capture_id, group);
      }
      const name = row.utid === null
        ? (row.track_name === 'Tracing' ? 'Configuration' : trackDisplayName(row.track_name))
        : row.track_name;
      // Physical threads remain unique even when a process hosts several captures.
      const parent = row.utid !== null ? (processGroup ?? group)
        : name === 'Configuration' ? collapsedGroup(group, 'Tracing') : group;
      if (['Tools', 'Child workflows'].includes(name)) {
        // The native TrackEvent renderer honors sibling merging and lays out
        // overlapping slices across all of the group's analysis tracks.
        const nativeTrack = trace.tracks.findTrack(t => t.tags?.trackEvent === true &&
          t.tags.trackIds?.includes(row.track_id));
        if (nativeTrack !== undefined) {
          if (!mergedSliceTracks.has(nativeTrack.uri)) {
            parent.addChildInOrder(new TrackNode({uri: nativeTrack.uri, name, sortOrder: order[name]}));
            mergedSliceTracks.add(nativeTrack.uri);
          }
          continue;
        }
      }
      if (row.utid !== null) {
        // One native OS thread row holds all of its capture spans. Do not
        // duplicate that physical thread under each logical capture group.
        if (threadTracks.has(row.utid)) continue;
        const nativeTrack = trace.tracks.findTrack(t => t.tags?.trackIds?.includes(row.track_id));
        if (nativeTrack !== undefined) {
          parent.addChildFirst(new TrackNode({uri: nativeTrack.uri, name}));
          threadTracks.add(row.utid);
          continue;
        }
      }
      const uri = `${devId()}/track/${row.track_id}`;
      trace.tracks.registerTrack({
        uri,
        description: trackDisplayName(row.track_name) === 'Requests'
          ? 'Request start through response headers; excludes consuming the response stream.' : undefined,
        tags: {trackIds: [row.track_id], utid: row.utid ?? undefined},
        renderer: SliceTrack.create({
          trace, uri,
          rootTableName: 'slice',
          detailsPanel: () => new ThreadSliceDetailsPanel(trace),
          dataset: new SourceDataset({
            src: `SELECT id, ts, dur, name FROM agentprof_slices WHERE ${row.utid === null
              ? `track_id = ${row.track_id}` : `utid = ${row.utid}`}`,
            schema: {id: NUM, ts: LONG, dur: LONG, name: STR},
          }),
          onSliceClick: ({slice}) => trace.selection.selectSqlEvent('slice', slice.id),
        }),
      });
      if (row.utid !== null) {
        parent.addChildFirst(new TrackNode({uri, name}));
        threadTracks.add(row.utid);
      } else {
        parent.addChildInOrder(new TrackNode({uri, name, sortOrder: order[name]}));
      }
    }
    // Reuse native counter renderers, including sample selection and scaling.
    // Descriptors without samples must not imply that usage was recorded.
    const counters = await trace.engine.query(`
      SELECT t.id, t.display_name AS name,
        CASE WHEN t.name IN ('llm.tokens.input', 'llm.tokens.output') THEN 'Token usage'
          ELSE t.group_name END AS group_name, t.capture_id
      FROM agentprof_counter_tracks t
      WHERE EXISTS (SELECT 1 FROM counter c WHERE c.track_id = t.id)
      ORDER BY t.id
    `);
    for (const row = counters.iter({id: NUM, name: STR, group_name: STR_NULL, capture_id: NUM});
      row.valid(); row.next()) {
      const track = trace.tracks.findTrack(t => t.tags?.trackIds?.includes(row.id));
      let group = captures.get(row.capture_id);
      if (track !== undefined && group !== undefined) {
        if (row.group_name !== null) group = collapsedGroup(group, row.group_name);
        group.addChildInOrder(new TrackNode({uri: track.uri, name: row.name, sortOrder: order[row.name]}));
      }
    }
    trace.workspaces.switchWorkspace(workspace);
    for (const [title, query] of Object.entries(QUERIES)) {
      const commandId = `${devId()}.${title.replaceAll(' ', '')}`;
      trace.commands.registerCommand({
        id: commandId,
        name: `Agent Profiler: ${title}`,
        callback: () => trace.plugins.getPlugin(QueryPagePlugin)
          .addQueryResultsTab({title: `Agent Profiler: ${title}`, query}, commandId),
      });
    }
  }
}

function devId(): string {
  return 'dev.agentprof.Agentprof';
}
