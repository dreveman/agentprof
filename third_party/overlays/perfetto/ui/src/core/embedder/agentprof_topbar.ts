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
import {navigate} from '../../plugins/dev.agentprof.Agentprof/navigation';
import './agentprof_topbar.scss';

const REPO = 'https://github.com/dreveman/agentprof';
const OVERVIEW_COMMAND = 'dev.agentprof.Agentprof.OpenOverview';

export class AgentprofNavigation implements m.ClassComponent<{app: App}> {
  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const trace = app.trace;
    const page = app.getCurrentRoute().page;
    const link = (label: string, route: string, icon: string) =>
      m(
        'a.ap-navigation__link',
        {
          'href': `#!${route}`,
          'title': label,
          'aria-label': label,
          'aria-current': page === route ? 'page' : undefined,
          'onclick': (event: MouseEvent) => {
            if (
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            if (trace) navigate(trace, route);
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
            )
              return;
            event.preventDefault();
            app.navigate('#!/?local_cache_key=');
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
      trace?.commands.hasCommand(OVERVIEW_COMMAND) &&
        link('Overview', '/agentprof', 'dashboard'),
      trace && link('Timeline', '/viewer', 'line_style'),
    );
  }
}

interface Action {
  label: string;
  icon: string;
  run: () => unknown;
  checked?: boolean;
}

export class AgentprofActions implements m.ClassComponent<{app: App}> {
  private width = 0;
  private observer?: ResizeObserver;

  oncreate({dom, attrs: {app}}: m.CVnodeDOM<{app: App}>) {
    this.observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      if (width !== this.width) {
        this.width = width;
        app.raf.scheduleFullRedraw();
      }
    });
    this.observer.observe(dom);
  }

  onremove() {
    this.observer?.disconnect();
  }

  view({attrs: {app}}: m.CVnode<{app: App}>) {
    const trace = app.trace;
    const theme = app.settings.get<string>('theme');
    const go = (route: string) =>
      trace ? navigate(trace, route) : app.navigate(`#!${route}`);
    const external = (path: string) =>
      window.open(`${REPO}${path}`, '_blank', 'noopener');
    const actions: Action[] = [];
    if (trace) {
      if (trace.traceInfo.downloadable)
        actions.push({
          label: 'Download recording',
          icon: 'download',
          run: () => {
            const current = AppImpl.instance.trace;
            return current ? downloadTrace(current) : undefined;
          },
        });
      actions.push(
        {label: 'Query (SQL)', icon: 'terminal', run: () => go('/query')},
        {label: 'Trace details', icon: 'info', run: () => go('/info')},
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
      {label: 'Settings', icon: 'settings', run: () => go('/settings')},
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
        'icon': action.checked ? 'check' : action.icon,
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
        menuItem({
          label: 'Open workflow example',
          icon: 'smart_toy',
          run: () =>
            app.commands.runCommand('dev.agentprof.Agentprof.OpenExample'),
        }),
        menuItem({
          label: 'Open direct vs codemode example', icon: 'code',
          run: () => app.commands.runCommand('dev.agentprof.Agentprof.OpenCodemodeExample'),
        }),
        trace &&
          menuItem({
            label: 'Close recording',
            icon: 'close',
            run: () => {
              app.closeCurrentTrace();
              app.navigate('#!/?local_cache_key=');
            },
          }),
      ),
    );
  }
}
