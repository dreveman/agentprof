// SPDX-License-Identifier: Apache-2.0

import type {PerfettoPlugin} from '../../public/plugin';
import m from 'mithril';
import {
  closeSecondaryPane,
  exampleHref,
  markExample,
  setOverviewCollapsed,
} from './navigation';
import {Overview} from './overview';
import {createTurnSetup} from './overview_loader';
import {
  COMMAND_QUERIES,
  DETECT_QUERY,
  TRACE_SLICE_DATASET_SQL,
  WORKSPACE_COUNTERS_QUERY,
  WORKSPACE_TRACKS_QUERY,
} from './overview_queries';
import {AGENTPROF_SQL_PACKAGE} from './sql_package';
import {AppImpl} from '../../core/app_impl';
import {registerHostOpenTrace} from '../../core/embedder/agentprof_open_trace';
import type {App} from '../../public/app';
import type {Trace} from '../../public/trace';
import {cacheTrace} from '../../core/cache_manager';
import {tarFileListToBlob} from '../../core/trace_stream';
import {TrackNode} from '../../public/workspace';
import {SliceTrack} from '../../components/tracks/slice_track';
import {ThreadSliceDetailsPanel} from '../../components/details/thread_slice_details_tab';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, NUM, NUM_NULL, STR, STR_NULL} from '../../trace_processor/query_result';
import QueryPagePlugin from '../dev.perfetto.QueryPage';
import TrackEventPlugin from '../dev.perfetto.TrackEvent';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';
import {trackDisplayName} from './track_names';
import {EXAMPLE_TRACE_BASE64} from './example_trace';
import {COMPARISON_EXAMPLE_TRACE_BASE64} from './comparison_example_trace';
import {CLAUDE_EXAMPLE_TRACE_BASE64} from './claude_example_trace';
import {CODEX_EXAMPLE_TRACE_BASE64} from './codex_example_trace';
import {MUSE_EXAMPLE_TRACE_BASE64} from './muse_example_trace';
import {EXAMPLES} from './examples';

export default class implements PerfettoPlugin {
  static readonly id = 'dev.agentprof.Agentprof';
  static readonly description = 'Agent timelines and analysis for coding harness recordings';
  static readonly dependencies = [QueryPagePlugin, TrackEventPlugin];

  static onActivate(app: App): void {
    try {
      AppImpl.instance.addSqlPackages([AGENTPROF_SQL_PACKAGE]);
    } catch {
      // Minimal unit-test harnesses may invoke onActivate without AppImpl.
    }
    registerHostOpenTrace(app);
    const splitSetting = app.settings?.get<boolean>('splitSecondaryPages');
    if (splitSetting && splitSetting.isDefault !== false) {
      splitSetting.set(true);
    }
    const openExample = async (id: string, title: string, base64: string) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const trace = await app.openTraceFromBuffer({
        buffer: bytes.buffer,
        title,
        fileName: `${title}.pftrace`,
      });
      markExample(trace, id);
      // Drop any previous trace cache key without triggering Router's 3-step
      // empty-key normalization, and reload the bundled fixture on refresh.
      if (typeof window !== 'undefined' && window.location.hash.includes('local_cache_key=')) {
        window.history.replaceState(null, '', '#!/agentprof');
      }
      app.navigate(exampleHref('/agentprof', id));
    };
    const examples = [
      {...EXAMPLES.claude, base64: CLAUDE_EXAMPLE_TRACE_BASE64},
      {...EXAMPLES.codex, base64: CODEX_EXAMPLE_TRACE_BASE64},
      {...EXAMPLES.muse, base64: MUSE_EXAMPLE_TRACE_BASE64},
      {...EXAMPLES.comparison, base64: COMPARISON_EXAMPLE_TRACE_BASE64},
      {...EXAMPLES.workflow, base64: EXAMPLE_TRACE_BASE64},
    ];
    examples.forEach((example, index) => {
      app.commands.registerCommand({
        id: example.commandId, name: example.title,
        callback: () => openExample(example.routeId, example.traceName, example.base64),
      });
      app.sidebar.addMenuItem({section: 'trace_files', commandId: example.commandId,
        icon: example.icon, sortOrder: 2.6 + index / 10});
    });
    const requestedExample = app.initialRouteArgs.agentprof_example;
    const exampleId = requestedExample === 'codemode' ? 'comparison' : requestedExample;
    const example = examples.find(candidate => candidate.routeId === exampleId);
    if (example !== undefined) {
      // Clear any old cache key before the startup route handler runs.
      window.history.replaceState(null, '', exampleHref('/agentprof', example.routeId));
      void app.commands.runCommand(example.commandId);
    }
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    const detected = await trace.engine.query(DETECT_QUERY);
    if (detected.firstRow({count: NUM}).count === 0) return;
    setOverviewCollapsed(false);
    const rawSource = (
      trace.traceInfo as {
        source?: {type?: string; files?: ReadonlyArray<File>};
        uuid?: string;
      }
    ).source;
    const traceUuid = (trace.traceInfo as {uuid?: string}).uuid;
    if (
      rawSource?.type === 'MULTIPLE_FILES' &&
      rawSource.files &&
      rawSource.files.length > 0 &&
      traceUuid
    ) {
      const traceFiles = rawSource.files.filter(
        (f) =>
          f.name !== 'merge_manifest.json' &&
          f.name !== 'perfetto_manifest.json',
      );
      const files = traceFiles.length > 0 ? traceFiles : rawSource.files;
      const names = files.map((f) => f.name.split(/[/\\]/).pop() ?? f.name);
      void tarFileListToBlob(rawSource.files)
        .then((blob) => blob.arrayBuffer())
        .then((buffer) =>
          cacheTrace(
            {
              type: 'ARRAY_BUFFER',
              buffer,
              title: names[0] ?? 'Merged recording',
              fileName: names.map(encodeURIComponent).join(','),
            },
            traceUuid,
          ),
        )
        .catch(() => undefined);
    }
    const loadTurns = createTurnSetup(() =>
      trace.engine.query('INCLUDE PERFETTO MODULE dev.agentprof.turns;'),
    );
    trace.pages.registerPage({
      route: '/agentprof',
      render: (subpage) =>
        m(Overview, {trace, loadTurns, subpage, key: trace.engine.engineId}),
    });
    trace.commands.registerCommand({
      id: `${devId()}.OpenOverview`, name: 'Open Agent Profiler overview',
      callback: () => {
        setOverviewCollapsed(false);
        closeSecondaryPane(trace);
      },
    });
    trace.sidebar.addMenuItem({section: 'current_trace', text: 'Overview',
      href: '#!/agentprof', action: () => {
        setOverviewCollapsed(false);
        closeSecondaryPane(trace);
      }, icon: 'dashboard', sortOrder: 0});
    trace.initialPage.suggest('/agentprof', 100);

    const workspace = trace.workspaces.createEmptyWorkspace('Agent Profiler');
    const tracks = await trace.engine.query(WORKSPACE_TRACKS_QUERY);
    const processTracks = trace.plugins.getPlugin(ProcessThreadGroupsPlugin);
    const processes = new Map<number, TrackNode>();
    const captures = new Map<number, TrackNode>();
    const threadTracks = new Set<number>();
    const mergedSliceTracks = new Set<string>();
    const order: Record<string, number> = {
      'Requests': 5, 'Responses': 10, 'Tools': 20, 'Compaction': 25,
      'Context size': 30, 'Context window': 31,
      'Token usage': 40, 'Context': 45, 'Runtime': 60, 'Tracing': 70,
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
            src: TRACE_SLICE_DATASET_SQL(row.track_id, row.utid),
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
    const counters = await trace.engine.query(WORKSPACE_COUNTERS_QUERY);
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
    for (const [title, query] of Object.entries(COMMAND_QUERIES)) {
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
