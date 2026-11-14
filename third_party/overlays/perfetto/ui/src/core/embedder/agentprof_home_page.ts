// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import {formatBytesSi} from '../../base/bytes_format';
import type {App} from '../../public/app';
import {CommandError} from '../../public/commands';
import {
  deleteCachedTrace,
  getRecentCachedTraces,
  tryGetTrace,
  type CachedTraceEntry,
} from '../cache_manager';
import {Button} from '../../widgets/button';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {Icon} from '../../widgets/icon';
import {AgentprofBrand} from './agentprof_brand';
import {HOST_CHANGE_EVENT} from './agentprof_native_bar';
import {
  getAgentprofHost,
  inIOSApp,
  isTouchDevice,
  openTraceFiles,
} from './agentprof_open_trace';
import {
  EXAMPLES,
  exampleForAgent,
  type RecordingAgent,
} from '../../plugins/dev.agentprof.Agentprof/examples';
import {
  closeSecondaryPane,
  setOverviewCollapsed,
} from '../../plugins/dev.agentprof.Agentprof/navigation';
import './agentprof_home_page.scss';

const MAX_VISIBLE_RECENT_TRACES = 4;

export interface RecentTraceItem {
  readonly id: string;
  readonly title: string;
  readonly files?: ReadonlyArray<string>;
  readonly sizeBytes?: number;
  readonly updatedAt?: string | number;
}

export interface RecentTracesProvider {
  getRecentTraces():
    | ReadonlyArray<RecentTraceItem>
    | Promise<ReadonlyArray<RecentTraceItem>>;
  openRecentTrace(app: App, item: RecentTraceItem): Promise<void> | void;
  removeRecentTrace?(item: RecentTraceItem): Promise<void> | void;
}

interface HostWithRecentTraces {
  readonly platform?: string;
  readonly recentTraces?: ReadonlyArray<RecentTraceItem>;
  readonly getRecentTraces?: () =>
    | ReadonlyArray<RecentTraceItem>
    | Promise<ReadonlyArray<RecentTraceItem>>;
  readonly onOpenRecentTrace?: (id: string) => Promise<void> | void;
  readonly onRemoveRecentTrace?: (id: string) => Promise<void> | void;
}

function getHostRecentProvider(): RecentTracesProvider | undefined {
  const host = getAgentprofHost<HostWithRecentTraces>();
  if (!host) return undefined;
  if (
    typeof host.getRecentTraces !== 'function' &&
    !Array.isArray(host.recentTraces)
  ) {
    return undefined;
  }
  return {
    getRecentTraces: () =>
      typeof host.getRecentTraces === 'function'
        ? host.getRecentTraces()
        : (host.recentTraces ?? []),
    openRecentTrace: async (_app, item) => {
      await host.onOpenRecentTrace?.(item.id);
    },
    removeRecentTrace: host.onRemoveRecentTrace
      ? async (item) => {
          await host.onRemoveRecentTrace?.(item.id);
        }
      : undefined,
  };
}

export function parseCachedEntryFiles(
  entry: Pick<CachedTraceEntry, 'title' | 'fileName'>,
): ReadonlyArray<string> {
  if (entry.fileName) {
    if (entry.fileName.includes('\n')) {
      return entry.fileName
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (entry.fileName.includes(',')) {
      return entry.fileName
        .split(',')
        .map((s) => {
          try {
            return decodeURIComponent(s.trim());
          } catch {
            return s.trim();
          }
        })
        .filter(Boolean);
    }
  }
  const primary = entry.title || entry.fileName;
  return primary ? [primary] : [];
}

const defaultCacheRecentProvider: RecentTracesProvider = {
  getRecentTraces(): Promise<ReadonlyArray<RecentTraceItem>> {
    if (inIOSApp()) return Promise.resolve([]);
    return getRecentCachedTraces().then((entries) => {
      const sorted = [...entries].sort((a, b) => {
        const ta = a.expires ? Date.parse(a.expires) : 0;
        const tb = b.expires ? Date.parse(b.expires) : 0;
        return tb - ta;
      });
      return sorted.map((entry) => {
        const files = parseCachedEntryFiles(entry);
        return {
          id: entry.uuid,
          title:
            files[0] ?? (entry.title || entry.fileName || 'Untitled trace'),
          files: files.length > 1 ? files : undefined,
          sizeBytes: entry.sizeBytes,
          updatedAt: entry.expires,
        };
      });
    });
  },
  async openRecentTrace(app: App, item: RecentTraceItem): Promise<void> {
    if (app.trace?.traceInfo.uuid === item.id) {
      setOverviewCollapsed(false);
      closeSecondaryPane(app.trace);
      return;
    }
    const source = await tryGetTrace(item.id);
    if (source) {
      await app.openTraceFromBuffer({
        ...source,
        fileName: source.fileName ?? source.title,
      });
    } else {
      app.navigate(`#!/?local_cache_key=${encodeURIComponent(item.id)}`);
    }
  },
  async removeRecentTrace(item: RecentTraceItem): Promise<void> {
    await deleteCachedTrace(item.id);
  },
};

export interface HomePageAttrs {
  app: App;
  recentProvider?: RecentTracesProvider;
}

export class AgentprofHomePage implements m.ClassComponent<HomePageAttrs> {
  private agent: RecordingAgent = 'claude';
  private recentTraces: ReadonlyArray<RecentTraceItem> = [];
  private recentExpanded = false;
  private loadingRecentId?: string;
  private loadingExampleId?: string;
  private lastKnownTraceUuid?: string;
  private hostListener?: () => void;
  private error?: string;

  private resolveProvider(custom?: RecentTracesProvider): RecentTracesProvider {
    return custom ?? getHostRecentProvider() ?? defaultCacheRecentProvider;
  }

  oninit({attrs: {app, recentProvider}}: m.CVnode<HomePageAttrs>) {
    this.lastKnownTraceUuid = app.trace?.traceInfo.uuid;
    void this.reloadRecentTraces(app, recentProvider);
    if (typeof window !== 'undefined') {
      this.hostListener = () => {
        void this.reloadRecentTraces(app, recentProvider);
      };
      window.addEventListener(HOST_CHANGE_EVENT, this.hostListener);
    }
  }

  onbeforeupdate({attrs: {app, recentProvider}}: m.CVnode<HomePageAttrs>) {
    const currentUuid = app.trace?.traceInfo.uuid;
    if (currentUuid !== this.lastKnownTraceUuid) {
      this.lastKnownTraceUuid = currentUuid;
      void this.reloadRecentTraces(app, recentProvider);
    }
  }

  onremove() {
    if (this.hostListener && typeof window !== 'undefined') {
      window.removeEventListener(HOST_CHANGE_EVENT, this.hostListener);
      this.hostListener = undefined;
    }
  }

  private async reloadRecentTraces(
    app: App,
    custom?: RecentTracesProvider,
  ): Promise<void> {
    try {
      const provider = this.resolveProvider(custom);
      this.recentTraces = await provider.getRecentTraces();
      if (this.recentTraces.length <= MAX_VISIBLE_RECENT_TRACES) {
        this.recentExpanded = false;
      }
      app.raf?.scheduleFullRedraw?.();
    } catch {
      this.recentTraces = [];
    }
  }

  private async openRecent(
    app: App,
    item: RecentTraceItem,
    custom?: RecentTracesProvider,
  ): Promise<void> {
    this.error = undefined;
    this.loadingRecentId = item.id;
    app.raf?.scheduleFullRedraw?.();
    try {
      await this.resolveProvider(custom).openRecentTrace(app, item);
    } catch (e) {
      const cause = e instanceof CommandError ? e.cause : e;
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    this.loadingRecentId = undefined;
    app.raf?.scheduleFullRedraw?.();
  }

  private async removeRecent(
    app: App,
    item: RecentTraceItem,
    custom?: RecentTracesProvider,
  ): Promise<void> {
    await this.resolveProvider(custom).removeRecentTrace?.(item);
    await this.reloadRecentTraces(app, custom);
  }

  private async openExample(
    app: App,
    commandId: string,
    custom?: RecentTracesProvider,
  ): Promise<void> {
    this.loadingExampleId = commandId;
    this.error = undefined;
    try {
      await app.commands.runCommand(commandId);
    } catch (e) {
      const cause = e instanceof CommandError ? e.cause : e;
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    this.loadingExampleId = undefined;
    app.raf?.scheduleFullRedraw?.();
    void this.reloadRecentTraces(app, custom);
  }

  private renderCliSteps(): m.Children {
    const isPi = this.agent === 'pi';
    const isCodex = this.agent === 'codex';
    const isMuse = this.agent === 'muse';
    const recorder = isMuse ? 'muse' : isCodex ? 'codex' : 'claude';
    const agentName = isMuse ? 'Muse Code' : isCodex ? 'Codex' : 'Claude Code';
    const command = (text: string) =>
      m(
        '.ap-home__command',
        m('span', {'aria-hidden': 'true'}, '$'),
        m('code', text),
      );
    const step = (
      number: string,
      title: string,
      description: m.Children,
      content: m.Children,
    ) =>
      m(
        'article.ap-home__step',
        m('span.ap-home__number', {'aria-hidden': 'true'}, number),
        m('h2', title),
        m('p', description),
        m('.ap-home__step-content', content),
      );
    return [
      m(
        '.ap-home__agents',
        {role: 'group', 'aria-label': 'Recording agent'},
        (['claude', 'codex', 'muse', 'pi'] as const).map((agent) =>
          m(Button, {
            label:
              agent === 'pi'
                ? 'Pi'
                : agent === 'codex'
                  ? 'Codex'
                  : agent === 'muse'
                    ? 'Muse Code'
                    : 'Claude Code',
            active: this.agent === agent,
            'aria-pressed': String(this.agent === agent),
            onclick: () => {
              this.agent = agent;
            },
          }),
        ),
      ),
      step(
        '1',
        'Install agent tracing',
        isPi
          ? 'Install the tracing extension for your Pi account:'
          : isMuse
            ? 'Install the Muse Code plugin. Requires Muse Code 1.4.1 or later with plugins enabled, and Node.js 22 or later.'
            : isCodex
              ? 'Install the native Codex plugin. Requires Codex CLI 0.160.0 or later, and Node.js 22 or later.'
              : 'Install the Claude Code plugin. Requires Claude Code 2.1.289 or later with mods enabled, and Node.js 22 or later.',
        isPi
          ? command('pi install git:github.com/dreveman/agentprof')
          : !isCodex && !isMuse
            ? m(
                '.ap-home__commands',
                command('claude plugin marketplace add dreveman/agentprof'),
                command('claude plugin install agentprof@agentprof'),
              )
            : isCodex
              ? m(
                  '.ap-home__commands',
                  command('codex plugin marketplace add dreveman/agentprof'),
                  command('codex plugin add agentprof@agentprof'),
                )
              : m(
                  '.ap-home__commands',
                  command(
                    'muse plugins marketplace add agentprof dreveman/agentprof',
                  ),
                  command('muse plugins install agentprof@agentprof'),
                  command('muse plugins approve agentprof'),
                ),
      ),
      step(
        '2',
        'Record your agent',
        isPi
          ? 'Start Pi with tracing enabled and run your task as usual.'
          : isMuse
            ? 'Start Muse normally, type tracing start, then run your task.'
            : isCodex
              ? 'Start Codex normally. Review the plugin hooks in /hooks, then type tracing start.'
              : 'Start Claude normally. Use the recording button or /tracing start, then run your task.',
        isPi
          ? [
              command('pi --tracing'),
              m(
                'p.ap-home__record-note',
                'Exit Pi to save the recording and print its file path. Optionally, press ',
                m(HotkeyGlyphs, {hotkey: 'Ctrl+Shift+T'}),
                ' in Pi to manually start or stop recording.',
              ),
            ]
          : !isCodex && !isMuse
            ? [
                command('claude'),
                m(
                  'p.ap-home__record-note',
                  'Press ',
                  m(HotkeyGlyphs, {hotkey: 'Ctrl+X'}),
                  ', then Tab and R to start or stop recording. ',
                  'Use /tracing stop to save, or exit Claude to finish the recording. ',
                  'The agent can also use tracing_start and tracing_stop tools.',
                  ' ',
                  m(
                    'a',
                    {
                      href: 'https://github.com/dreveman/agentprof/blob/main/packages/claude-tracing/README.md',
                      target: '_blank',
                      rel: 'noopener',
                    },
                    'Claude Code recording guide',
                  ),
                ),
              ]
            : [
                command(isMuse ? 'muse' : 'codex'),
                m(
                  'p.ap-home__record-note',
                  `Type tracing stop to save, or exit ${isMuse ? 'Muse' : 'Codex'} to finish the recording. `,
                  'Use tracing status to see its path. The agent can also use tracing_start and tracing_stop tools. ',
                  m(
                    'a',
                    {
                      href: `https://github.com/dreveman/agentprof/blob/main/packages/${recorder}-tracing/README.md`,
                      target: '_blank',
                      rel: 'noopener',
                    },
                    `${agentName} recording guide`,
                  ),
                ),
              ],
      ),
    ];
  }

  private renderRecentSection(
    app: App,
    recentProvider: RecentTracesProvider | undefined,
    isBusy: boolean,
  ): m.Children {
    if (this.recentTraces.length === 0) return undefined;
    const provider = this.resolveProvider(recentProvider);
    const canRemove = typeof provider.removeRecentTrace === 'function';
    const hiddenCount = Math.max(
      0,
      this.recentTraces.length - MAX_VISIBLE_RECENT_TRACES,
    );
    const visible = this.recentExpanded
      ? this.recentTraces
      : this.recentTraces.slice(0, MAX_VISIBLE_RECENT_TRACES);
    return m(
      'section.ap-home__recent',
      {'aria-label': 'Recent traces'},
      m('h2', 'Recent traces'),
      visible.map((entry) => {
        const extraFiles =
          entry.files && entry.files.length > 1 ? entry.files.length - 1 : 0;
        const tooltip =
          entry.files && entry.files.length > 1
            ? entry.files.join(', ')
            : entry.title;
        return m(
          '.ap-home__recent-item',
          {key: entry.id},
          m(
            'button.ap-home__recent-open',
            {
              'type': 'button',
              'title': tooltip,
              'disabled': isBusy,
              'aria-busy': String(this.loadingRecentId === entry.id),
              'onclick': () => this.openRecent(app, entry, recentProvider),
            },
            m(Icon, {icon: 'description', className: 'ap-home__recent-icon'}),
            m(
              'span.ap-home__recent-title',
              entry.title || 'Untitled recording',
            ),
            extraFiles > 0 &&
              m('span.ap-home__recent-count', `+${extraFiles}`),
            m(
              'span.ap-home__recent-size',
              this.loadingRecentId === entry.id
                ? 'Loading…'
                : entry.sizeBytes !== undefined &&
                    Number.isFinite(entry.sizeBytes)
                  ? formatBytesSi(entry.sizeBytes)
                  : undefined,
            ),
          ),
          canRemove &&
            m(
              'button.ap-home__recent-delete',
              {
                'type': 'button',
                'title': 'Remove from recent traces',
                'aria-label': `Remove ${entry.title || 'trace'} from recent traces`,
                'onclick': (e: MouseEvent) => {
                  e.stopPropagation();
                  void this.removeRecent(app, entry, recentProvider);
                },
              },
              m(Icon, {icon: 'close'}),
            ),
        );
      }),
      hiddenCount > 0 &&
        m(
          'button.ap-home__recent-toggle',
          {
            'type': 'button',
            'aria-expanded': String(this.recentExpanded),
            'onclick': () => {
              this.recentExpanded = !this.recentExpanded;
            },
          },
          m(Icon, {icon: this.recentExpanded ? 'expand_less' : 'expand_more'}),
          m(
            'span',
            this.recentExpanded ? 'Show less' : `Show ${hiddenCount} more`,
          ),
        ),
    );
  }

  view({attrs: {app, recentProvider}}: m.CVnode<HomePageAttrs>) {
    const ios = inIOSApp();
    const isBusy =
      this.loadingRecentId !== undefined || this.loadingExampleId !== undefined;
    const openStep = (number: string) =>
      m(
        'article.ap-home__step',
        m('span.ap-home__number', {'aria-hidden': 'true'}, number),
        m('h2', ios ? 'Open agent recordings' : 'Open existing agent recordings'),
        m(
          'p',
          'Choose a .pftrace file or a trace archive. Select multiple files to view sessions together.',
        ),
        m(
          '.ap-home__step-content',
          m(
            'button.ap-home__open',
            {
              type: 'button',
              disabled: isBusy,
              onclick: () => openTraceFiles(app),
            },
            'Open recordings',
          ),
        ),
      );
    const examples = ios
      ? Object.values(EXAMPLES)
      : [exampleForAgent(this.agent)];
    return m(
      'main.ap-home',
      m(
        'header.ap-home__hero',
        m(AgentprofBrand, {className: 'ap-home__logo'}),
        m('h1', 'See where your agent spends its time.'),
        m(
          'p.ap-home__lede',
          'Explore model responses, tool calls, and token usage. Open sessions together to compare runs and follow delegated work.',
        ),
      ),
      m(
        'section.ap-home__steps',
        {'aria-label': 'Get started'},
        ios ? openStep('1') : [...(this.renderCliSteps() as m.ChildArray), openStep('3')],
      ),
      this.renderRecentSection(app, recentProvider, isBusy),
      m(
        'section.ap-home__examples',
        {'aria-label': 'Example recordings'},
        m('h2', 'Or explore an example'),
        examples.map((example) =>
          m(
            'button.ap-home__example',
            {
              'key': example.commandId,
              'type': 'button',
              'disabled': isBusy,
              'aria-busy': String(this.loadingExampleId === example.commandId),
              'onclick': () =>
                this.openExample(app, example.commandId, recentProvider),
            },
            m('span.ap-home__example-title', example.title),
            m('span', example.description),
            m(
              'span.ap-home__example-meta',
              this.loadingExampleId === example.commandId
                ? 'Loading recording…'
                : example.metadata,
            ),
          ),
        ),
        this.error && m('p.ap-home__error', {role: 'alert'}, this.error),
      ),
      ios &&
        m(
          'details.ap-home__cli-details',
          m('summary', 'Record a new agent run from your terminal'),
          m('.ap-home__steps', this.renderCliSteps()),
        ),
      !isTouchDevice() &&
        m(
          'aside.ap-home__shortcuts',
          {'aria-label': 'Keyboard shortcuts'},
          m('strong', 'Shortcuts'),
          m('span', 'Open recordings ', m(HotkeyGlyphs, {hotkey: '!Mod+O'})),
          m('span', 'Commands ', m(HotkeyGlyphs, {hotkey: '!Mod+Shift+P'})),
        ),
      m(
        'p.ap-home__privacy',
        'Open local recordings directly in the browser. No upload is required.',
      ),
      m(
        'footer.ap-home__footer',
        m(
          'a',
          {
            href: 'https://github.com/dreveman/agentprof',
            target: '_blank',
            rel: 'noopener',
          },
          'Agent Profiler',
        ),
        m('span', '·'),
        m(
          'a',
          {href: 'https://perfetto.dev', target: '_blank', rel: 'noopener'},
          'Built on Perfetto',
        ),
      ),
    );
  }
}
