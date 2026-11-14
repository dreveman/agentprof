// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import type {App} from '../../public/app';
import {AppImpl} from '../app_impl';
import {downloadTrace} from '../../frontend/trace_actions';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {MenuDivider, MenuItem, PopupMenu} from '../../widgets/menu';
import {PopupPosition} from '../../widgets/popup';
import {AgentprofBrand} from './agentprof_brand';
import {
  closeSecondaryPane,
  isOverviewCollapsed,
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

export function goHome(app: App): void {
  const sidePanel = getSidePanel();
  if (!isWideSplitViewport() && sidePanel) {
    sidePanel.visible = false;
  }
  if (app.trace) {
    setOverviewCollapsed(true);
  }
  navigateHome(app);
}

export class AgentprofNavigation implements m.ClassComponent<{app: App}> {
  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const trace = app.trace;
    const page = app.getCurrentRoute().page;
    const hasOverview = Boolean(trace?.commands.hasCommand(OVERVIEW_COMMAND));
    const link = (
      label: string,
      route: string,
      icon: string,
      active: boolean,
      onActivate: () => void,
    ) =>
      m(
        'a.ap-navigation__link',
        {
          'href': `#!${route}`,
          'title': label,
          'aria-label': label,
          'aria-current': active ? 'page' : undefined,
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
            onActivate();
          },
        },
        m(Icon, {icon}),
      );
    return m(
      'nav.ap-navigation',
      {'aria-label': 'Main navigation'},
      m(
        'a.ap-navigation__brand',
        {
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
      m(Button, {
        'label': 'Open trace file',
        'aria-label': 'Open trace file',
        'icon': 'folder_open',
        'className': 'ap-navigation__open',
        'title': 'Open trace file (one or more recordings)',
        'onclick': () => app.commands.runCommand('dev.perfetto.OpenTrace'),
      }),
      trace &&
        hasOverview &&
        link(
          'Overview',
          '/agentprof',
          'dashboard',
          page === '/agentprof' && !isOverviewCollapsed(),
          () => {
            setOverviewCollapsed(false);
            closeSecondaryPane(trace);
          },
        ),
      trace &&
        link('Timeline', '/viewer', 'line_style', page === '/viewer', () => {
          if (page === '/viewer' && hasOverview) {
            closeSecondaryPane(trace);
          } else {
            navigate(trace, '/viewer');
          }
        }),
    );
  }
}

interface Action {
  label: string;
  icon: string;
  run: () => unknown;
  checked?: boolean;
  active?: boolean;
}

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
        app.navigate('#!/?local_cache_key=');
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
      if (width !== this.width) {
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
    const trace = app.trace;
    const theme = app.settings.get<string>('theme');
    const isWide = isWideSplitViewport();
    const sidePanel = getSidePanel();
    const sidePanelOpen = !isWide && Boolean(sidePanel?.visible);
    const {page} = app.getCurrentRoute();
    const hasOverview = Boolean(trace?.commands.hasCommand(OVERVIEW_COMMAND));
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
        app.navigate(page === route ? '#!/?local_cache_key=' : `#!${route}`);
      }
    };
    const external = (path: string) =>
      window.open(`${REPO}${path}`, '_blank', 'noopener');
    const actions: Action[] = [];
    if (trace) {
      if (trace.traceInfo.downloadable) {
        actions.push({
          label: 'Download recording',
          icon: 'download',
          run: () => {
            const current = AppImpl.instance.trace;
            return current ? downloadTrace(current) : undefined;
          },
        });
      }
      actions.push(
        {
          label: 'Query (SQL)',
          icon: 'terminal',
          active: !sidePanelOpen && page === '/query',
          run: () => go('/query'),
        },
        {
          label: 'Trace details',
          icon: 'info',
          active: !sidePanelOpen && page === '/info',
          run: () => go('/info'),
        },
      );
    }
    actions.push(
      {
        label: 'Help',
        icon: 'help_outline',
        run: () => external('/blob/main/docs/investigating-agents.md'),
      },
      {
        label: 'Dark mode',
        icon: 'dark_mode',
        checked: theme?.get() === 'dark',
        run: () => theme?.set(theme.get() === 'dark' ? 'light' : 'dark'),
      },
      {
        label: 'Settings',
        icon: 'settings',
        active: !sidePanelOpen && page === '/settings',
        run: () => go('/settings'),
      },
      {label: 'GitHub', icon: 'code', run: () => external('')},
      {
        label: 'Report a bug',
        icon: 'bug_report',
        run: () => external('/issues/new'),
      },
    );
    // Each icon occupies 32px plus a 4px gap. Reserve a slot for the menu.
    const visible = Math.max(0, Math.floor((this.width - 32) / 36));
    const menuItem = (action: Action) =>
      m(MenuItem, {
        'label': action.label,
        'aria-label': action.label,
        'icon': action.checked || action.active ? 'check' : action.icon,
        'role': action.checked !== undefined ? 'menuitemcheckbox' : undefined,
        'aria-checked':
          action.checked !== undefined ? String(action.checked) : undefined,
        'onclick': action.run,
      });
    return m(
      '.ap-navigation-actions',
      ...actions.slice(0, visible).map((action) =>
        m(Button, {
          'key': action.label,
          'icon': action.icon,
          'title': action.label,
          'aria-label': action.label,
          'aria-pressed':
            action.checked !== undefined
              ? String(action.checked)
              : action.active
                ? 'true'
                : undefined,
          'active': action.checked ?? action.active,
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
        Object.values(EXAMPLES).map((example) =>
          menuItem({
            label: example.title,
            icon: example.icon,
            run: () => app.commands.runCommand(example.commandId),
          }),
        ),
        trace &&
          menuItem({
            label: 'Close recording',
            icon: 'close',
            run: () => {
              setOverviewCollapsed(false);
              app.closeCurrentTrace();
              navigateHome(app);
            },
          }),
      ),
    );
  }
}
