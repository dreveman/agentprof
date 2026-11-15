// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import type {App} from '../../public/app';
import {AppImpl} from '../app_impl';
import {downloadTrace} from '../../frontend/trace_actions';
import {Anchor} from '../../widgets/anchor';
import {Button} from '../../widgets/button';
import {MenuDivider, MenuItem, PopupMenu} from '../../widgets/menu';
import {PopupPosition} from '../../widgets/popup';
import {AgentprofBrand} from './agentprof_brand';
import {
  syncNativeBar,
  type NativeBarAction,
} from './agentprof_native_bar';
import {inIOSApp, openTraceFiles} from './agentprof_open_trace';
import {
  closeSecondaryPane,
  isOverviewCollapsed,
  isSplitSecondaryEnabled,
  isWideSplitViewport,
  navigate,
  navigateHome,
  setOverviewCollapsed,
} from '../../plugins/dev.agentprof.Agentprof/navigation';
import {EXAMPLES} from '../../plugins/dev.agentprof.Agentprof/examples';
import './agentprof_topbar.scss';

const REPO = 'https://github.com/dreveman/agentprof';
const OVERVIEW_COMMAND = 'dev.agentprof.Agentprof.OpenOverview';

function getSidePanel(): {visible: boolean; currentTabUri?: string} | undefined {
  try {
    return AppImpl.instance.sidePanel;
  } catch {
    return undefined;
  }
}

function overviewState(app: App) {
  const trace = app.trace;
  const {page} = app.getCurrentRoute();
  const splitEnabled = isSplitSecondaryEnabled(trace?.settings ?? app.settings);
  const isWide = isWideSplitViewport();
  const sidePanel = getSidePanel();
  const sidePanelOpen = !isWide && Boolean(sidePanel?.visible);
  const hasOverview = Boolean(trace?.commands.hasCommand(OVERVIEW_COMMAND));
  const overviewExpanded =
    hasOverview &&
    !isOverviewCollapsed() &&
    !sidePanelOpen &&
    (page === '/agentprof' || (splitEnabled && isWide));
  return {
    trace,
    page,
    splitEnabled,
    isWide,
    sidePanel,
    sidePanelOpen,
    hasOverview,
    overviewExpanded,
  };
}

export function goHome(app: App): void {
  const {isWide, sidePanel} = overviewState(app);
  if (!isWide && sidePanel) {
    sidePanel.visible = false;
  }
  if (app.trace) {
    setOverviewCollapsed(true);
  }
  navigateHome(app);
}

function toggleOverviewFromBar(app: App): void {
  const {trace, page, splitEnabled, isWide, sidePanel, overviewExpanded} =
    overviewState(app);
  if (!trace) return;
  if (!isWide && sidePanel?.visible) {
    sidePanel.visible = false;
    setOverviewCollapsed(false);
    if (page !== '/agentprof') {
      closeSecondaryPane(trace);
    }
    return;
  }
  if (overviewExpanded) {
    setOverviewCollapsed(true);
    if (page === '/agentprof') {
      navigate(trace, '/');
    }
  } else {
    setOverviewCollapsed(false);
    if (
      !splitEnabled ||
      !isWide ||
      page === '' ||
      page === '/' ||
      page === '/agentprof'
    ) {
      closeSecondaryPane(trace);
    }
  }
}

export class AgentprofNavigation implements m.ClassComponent<{app: App}> {
  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const {trace, hasOverview, overviewExpanded} = overviewState(app);
    return m(
      'nav.ap-navigation',
      {'aria-label': 'Main navigation'},
      m(
        Anchor,
        {
          'className': 'ap-navigation__brand',
          'href': '#!/?local_cache_key=',
          'aria-label': 'Agent Profiler home',
          'onclick': (event: MouseEvent) => {
            if (
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            goHome(app);
          },
        },
        m(AgentprofBrand),
      ),
      trace &&
        hasOverview &&
        m(Button, {
          'icon': 'dashboard',
          'title': 'Overview',
          'aria-label': 'Overview',
          'aria-pressed': String(overviewExpanded),
          'active': overviewExpanded,
          'onclick': () => toggleOverviewFromBar(app),
        }),
    );
  }
}

type Action = NativeBarAction;

export class AgentprofActions implements m.ClassComponent<{app: App}> {
  private width = 0;
  private observer?: ResizeObserver;

  private syncPaneCloseButtons(app: App): void {
    if (typeof document === 'undefined') return;
    const closePane = () => {
      if (app.trace?.commands.hasCommand(OVERVIEW_COMMAND)) {
        closeSecondaryPane(app.trace);
      } else if (app.trace) {
        navigate(app.trace, '/viewer');
      } else {
        navigateHome(app);
      }
    };
    const targets: ReadonlyArray<{selector: string; label: string}> = [
      {selector: '.pf-settings-shell', label: 'Close settings'},
      {selector: '.pf-trace-info-page', label: 'Close trace details'},
    ];
    for (const {selector, label} of targets) {
      const container = document.querySelector<HTMLElement>(selector);
      if (!container) continue;
      let btn = container.querySelector<HTMLButtonElement>(
        ':scope > button.ap-pane-close',
      );
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ap-pane-close';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        const icon = document.createElement('i');
        icon.className = 'pf-icon';
        icon.textContent = 'close';
        btn.appendChild(icon);
        container.appendChild(btn);
      }
      btn.onclick = closePane;
    }
  }

  oncreate({dom, attrs: {app}}: m.CVnodeDOM<{app: App}>) {
    this.observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      if (width > 0 && width !== this.width) {
        this.width = width;
        app.raf.scheduleFullRedraw();
      }
    });
    this.observer.observe(dom);
    this.syncPaneCloseButtons(app);
  }

  onupdate({attrs: {app}}: m.CVnodeDOM<{app: App}>) {
    this.syncPaneCloseButtons(app);
  }

  onremove() {
    this.observer?.disconnect();
  }

  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const {trace, page, isWide, sidePanel, sidePanelOpen, hasOverview, overviewExpanded} =
      overviewState(app);
    const theme = app.settings.get<string>('theme');
    const go = (route: string) => {
      if (!isWide && sidePanel?.visible) {
        sidePanel.visible = false;
        if (page === route) return;
      }
      if (trace) {
        if (page === route) {
          if (hasOverview) closeSecondaryPane(trace);
          else if (route !== '/viewer') navigate(trace, '/viewer');
        } else {
          navigate(trace, route);
        }
      } else {
        if (page === route) navigateHome(app);
        else app.navigate(`#!${route}`);
      }
    };
    const closeRecording = () => {
      setOverviewCollapsed(false);
      app.closeCurrentTrace();
      navigateHome(app);
    };
    const external = (path: string) =>
      window.open(`${REPO}${path}`, '_blank', 'noopener');

    const actions: Action[] = [];
    if (trace) {
      actions.push(
        {
          id: 'timeline',
          label: 'Timeline',
          icon: 'line_style',
          checked: !sidePanelOpen && page === '/viewer',
          run: () => go('/viewer'),
        },
        {
          id: 'query',
          label: 'Query (SQL)',
          icon: 'terminal',
          checked: !sidePanelOpen && page === '/query',
          run: () => go('/query'),
        },
      );
    }

    const menuActions: Action[] = [
      {
        id: 'open',
        label: 'Open trace files',
        icon: 'folder_open',
        run: () => openTraceFiles(app),
      },
      ...(trace
        ? [
            ...(trace.traceInfo.downloadable
              ? [
                  {
                    id: 'download',
                    label: 'Download recording',
                    icon: 'download',
                    run: () => {
                      const current = AppImpl.instance.trace;
                      return current ? downloadTrace(current) : undefined;
                    },
                  },
                ]
              : []),
            {
              id: 'trace-details',
              label: 'Trace details',
              icon: 'info',
              checked: !sidePanelOpen && page === '/info',
              run: () => go('/info'),
            },
          ]
        : []),
      {
        id: 'dark-mode',
        label: 'Dark mode',
        icon: 'dark_mode',
        checked: theme?.get() === 'dark',
        run: () => theme?.set(theme.get() === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings',
        checked: !sidePanelOpen && page === '/settings',
        run: () => go('/settings'),
      },
      ...(trace
        ? [
            {
              id: 'close',
              label: 'Close recording',
              icon: 'close',
              run: closeRecording,
            },
          ]
        : []),
    ];

    syncNativeBar(
      app,
      [
        {
          id: 'home',
          label: 'Agent Profiler home',
          icon: 'home',
          run: () => goHome(app),
        },
        ...(trace && hasOverview
          ? [
              {
                id: 'overview',
                label: 'Overview',
                icon: 'dashboard',
                checked: overviewExpanded,
                run: () => toggleOverviewFromBar(app),
              },
            ]
          : []),
        ...actions,
        ...menuActions.map((action) => ({...action, group: 'more' as const})),
      ],
      () => {
        try {
          AppImpl.instance.omnibox.focus();
        } catch {
          document.querySelector<HTMLInputElement>('.pf-omnibox input')?.focus();
        }
      },
    );

    const visible =
      !isWide || this.width === 0
        ? actions.length
        : Math.max(0, Math.floor((this.width - 32) / 36));
    const menuItem = (action: Omit<Action, 'id'>) =>
      m(MenuItem, {
        'label': action.label,
        'aria-label': action.label,
        'icon': action.checked ? 'check' : action.icon,
        'role': action.checked !== undefined ? 'menuitemcheckbox' : undefined,
        'aria-checked':
          action.checked !== undefined ? String(action.checked) : undefined,
        'disabled': action.disabled,
        'onclick': action.run,
      });

    const webExternalLinks: ReadonlyArray<Omit<Action, 'id'>> = inIOSApp()
      ? []
      : [
          {
            label: 'Help',
            icon: 'help_outline',
            run: () => external('/blob/main/docs/investigating-agents.md'),
          },
          {label: 'GitHub', icon: 'code', run: () => external('')},
          {
            label: 'Report a bug',
            icon: 'bug_report',
            run: () => external('/issues/new'),
          },
        ];

    return m(
      '.ap-navigation-actions',
      ...actions.slice(0, visible).map((action) =>
        m(Button, {
          'key': action.label,
          'icon': action.icon,
          'title': action.label,
          'aria-label': action.label,
          'aria-pressed':
            action.checked !== undefined ? String(action.checked) : undefined,
          'active': action.checked,
          'onclick': action.run,
        }),
      ),
      m(
        PopupMenu,
        {
          key: 'more',
          trigger: m(Button, {
            'icon': 'more_horiz',
            'title': 'More options',
            'aria-label': 'More options',
          }),
          position: PopupPosition.BottomEnd,
        },
        actions.slice(visible).map(menuItem),
        visible < actions.length && m(MenuDivider),
        menuActions.map(menuItem),
        m(MenuDivider),
        Object.values(EXAMPLES).map((example) =>
          menuItem({
            label: example.title,
            icon: example.icon,
            run: () => app.commands.runCommand(example.commandId),
          }),
        ),
        webExternalLinks.length > 0 && m(MenuDivider),
        webExternalLinks.map(menuItem),
      ),
    );
  }
}
