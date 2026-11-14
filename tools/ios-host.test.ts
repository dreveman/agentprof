// SPDX-License-Identifier: Apache-2.0
import {afterEach, expect, test} from 'bun:test';
import {
  HOST_CHANGE_EVENT,
  NATIVE_BAR_CLASS,
  NATIVE_BAR_WIDTH_PROPERTY,
  SEARCH_OPEN_CLASS,
  resetNativeBarForTesting,
  syncNativeBar,
  type NativeBarAction,
  type NativeBarActionPayload,
} from '../third_party/overlays/perfetto/ui/src/core/embedder/agentprof_native_bar.ts';
import {
  IOS_TRACE_FILE_ACCEPT,
  OPEN_TRACE_COMMAND,
  inIOSApp,
  openTraceFiles,
  shouldInstallServiceWorker,
} from '../third_party/overlays/perfetto/ui/src/core/embedder/agentprof_open_trace.ts';

function fakeDom() {
  const classes = new Set<string>();
  const styles = new Map<string, string>();
  const windowListeners = new Map<string, Set<() => void>>();
  const docListeners = new Map<string, Set<() => void>>();
  let acceptAttr: string | null = null;
  let activeInTopbar = false;

  const input = {
    setAttribute: (name: string, value: string) => {
      if (name === 'accept') acceptAttr = value;
    },
    getAttribute: (name: string) => (name === 'accept' ? acceptAttr : null),
  };
  const topbar = {
    contains: (el: unknown) => el === 'omnibox-input' && activeInTopbar,
  };

  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: () => void) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      windowListeners.get(type)?.delete(fn);
    },
    dispatch: (type: string) => {
      for (const fn of windowListeners.get(type) ?? []) fn();
    },
  };
  (globalThis as Record<string, unknown>).document = {
    activeElement: null as unknown,
    documentElement: {
      classList: {
        toggle: (cls: string, force: boolean) => {
          if (force) classes.add(cls);
          else classes.delete(cls);
        },
        contains: (cls: string) => classes.has(cls),
      },
      style: {
        setProperty: (k: string, v: string) => styles.set(k, v),
        removeProperty: (k: string) => styles.delete(k),
        getPropertyValue: (k: string) => styles.get(k) ?? '',
      },
    },
    querySelector: (selector: string) => {
      if (selector === 'input.trace_file') return input;
      if (selector === '.pf-ui-main > .pf-topbar') return topbar;
      return null;
    },
    addEventListener: (type: string, fn: () => void) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      docListeners.get(type)?.delete(fn);
    },
    dispatch: (type: string) => {
      for (const fn of docListeners.get(type) ?? []) fn();
    },
  };

  return {
    classes,
    styles,
    getAccept: () => acceptAttr,
    dispatchWindow: (type: string) =>
      ((globalThis as Record<string, unknown>).window as {dispatch(t: string): void}).dispatch(type),
    dispatchDocument: (type: string) =>
      ((globalThis as Record<string, unknown>).document as {dispatch(t: string): void}).dispatch(type),
    setFocusInTopbar: (focused: boolean) => {
      activeInTopbar = focused;
      ((globalThis as Record<string, unknown>).document as {activeElement: unknown}).activeElement =
        focused ? 'omnibox-input' : null;
    },
  };
}

afterEach(() => {
  resetNativeBarForTesting();
  delete (globalThis as {agentprofHost?: unknown}).agentprofHost;
  delete (globalThis as {window?: unknown}).window;
  delete (globalThis as {document?: unknown}).document;
  delete (globalThis as {location?: unknown}).location;
});

test('openTraceFiles asks for arbitrary data files in the iOS app and leaves web untouched', () => {
  const dom = fakeDom();
  const commands: string[] = [];
  const app = {
    commands: {
      runCommand: (id: string) => {
        commands.push(id);
        return dom.getAccept();
      },
    },
  };

  expect(inIOSApp()).toBe(false);
  expect(openTraceFiles(app)).toBeNull();
  expect(commands).toEqual([OPEN_TRACE_COMMAND]);

  (globalThis as {agentprofHost?: unknown}).agentprofHost = {platform: 'ios'};
  expect(inIOSApp()).toBe(true);
  expect(openTraceFiles(app)).toBe(IOS_TRACE_FILE_ACCEPT);
});

test('shouldInstallServiceWorker disables service workers on iOS and custom URL schemes', () => {
  (globalThis as {location?: unknown}).location = {protocol: 'https:'};
  expect(shouldInstallServiceWorker()).toBe(true);

  (globalThis as {location?: unknown}).location = {protocol: 'agentprof:'};
  expect(shouldInstallServiceWorker()).toBe(false);

  (globalThis as {location?: unknown}).location = {protocol: 'https:'};
  (globalThis as {agentprofHost?: unknown}).agentprofHost = {platform: 'ios'};
  expect(shouldInstallServiceWorker()).toBe(false);
});

test('syncNativeBar sends deduplicated actions, runs callbacks, and tracks nativeBarWidth', async () => {
  const dom = fakeDom();
  const calls: ReadonlyArray<NativeBarActionPayload>[] = [];
  const host: {
    nativeBar: boolean;
    nativeBarWidth?: number;
    setActions: (actions: ReadonlyArray<NativeBarActionPayload>) => void;
    onRunAction?: (id: string) => unknown;
  } = {
    nativeBar: false,
    setActions: (actions) => calls.push(actions),
  };
  (globalThis as {agentprofHost?: unknown}).agentprofHost = host;

  let redraws = 0;
  let timelineRuns = 0;
  let searchFocused = 0;
  const app = {
    raf: {
      scheduleFullRedraw: () => {
        redraws++;
      },
    },
  };
  const actions: NativeBarAction[] = [
    {id: 'home', label: 'Home', icon: 'home', run: () => {}},
    {
      id: 'timeline',
      label: 'Timeline',
      icon: 'line_style',
      checked: true,
      run: () => {
        timelineRuns++;
      },
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      group: 'more',
      run: () => {},
    },
  ];

  syncNativeBar(app, actions, () => {
    searchFocused++;
  });
  syncNativeBar(app, actions, () => {
    searchFocused++;
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.map((a) => [a.id, a.group, a.checked])).toEqual([
    ['home', 'main', false],
    ['search', 'main', false],
    ['timeline', 'main', true],
    ['settings', 'more', false],
  ]);
  expect(dom.classes.has(NATIVE_BAR_CLASS)).toBe(false);

  host.nativeBar = true;
  host.nativeBarWidth = 60;
  dom.dispatchWindow(HOST_CHANGE_EVENT);
  expect(dom.classes.has(NATIVE_BAR_CLASS)).toBe(true);
  expect(dom.styles.get(NATIVE_BAR_WIDTH_PROPERTY)).toBe('60px');

  await host.onRunAction?.('timeline');
  expect(timelineRuns).toBe(1);
  expect(redraws).toBeGreaterThanOrEqual(2);

  await host.onRunAction?.('search');
  expect(searchFocused).toBe(1);
  expect(dom.classes.has(SEARCH_OPEN_CLASS)).toBe(true);

  dom.setFocusInTopbar(false);
  dom.dispatchDocument('focusout');
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(dom.classes.has(SEARCH_OPEN_CLASS)).toBe(false);

  // Out-of-range widths are rejected cleanly.
  host.nativeBarWidth = 500;
  dom.dispatchWindow(HOST_CHANGE_EVENT);
  expect(dom.styles.has(NATIVE_BAR_WIDTH_PROPERTY)).toBe(false);
});
