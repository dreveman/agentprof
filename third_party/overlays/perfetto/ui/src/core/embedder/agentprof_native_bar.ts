// SPDX-License-Identifier: Apache-2.0
// Native bar bridge for iOS hosting (`window.agentprofHost`).
//
// An iOS host app (such as a native vertical sidebar or navigation bar in
// landscape) can render the top bar's actions natively. While `host.nativeBar`
// is true, the web top bar stays hidden except while searching, and the
// collapsed Overview rail matches `host.nativeBarWidth` via
// `--ap-native-bar-width`. Outside the host app this module is a no-op.

export interface NativeBarAction {
  readonly id: string;
  readonly label: string;
  // Material Symbols glyph name matching the web top bar.
  readonly icon: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  // 'more' places the action inside the host's overflow menu.
  readonly group?: 'more';
  readonly run: () => unknown;
}

export interface NativeBarActionPayload {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly group: 'main' | 'more';
}

interface NativeBarHost {
  readonly nativeBar?: boolean;
  readonly nativeBarWidth?: number;
  readonly setActions?: (actions: ReadonlyArray<NativeBarActionPayload>) => void;
  onRunAction?: (id: string) => unknown;
}

export interface NativeBarApp {
  readonly raf: {scheduleFullRedraw(): void};
}

export const NATIVE_BAR_CLASS = 'ap-native-bar';
export const SEARCH_OPEN_CLASS = 'ap-search-open';
export const NATIVE_BAR_WIDTH_PROPERTY = '--ap-native-bar-width';
export const HOST_CHANGE_EVENT = 'agentprofhostchange';

const MAX_NATIVE_BAR_WIDTH = 200;
const TOPBAR_SELECTOR = '.pf-ui-main > .pf-topbar';

let sent = '';
let runners = new Map<string, () => unknown>();
let searchOpen = false;
let listening = false;
let hostChangeHandler: (() => void) | undefined;
let focusOutHandler: (() => void) | undefined;

function host(): NativeBarHost | undefined {
  return (globalThis as {agentprofHost?: NativeBarHost}).agentprofHost;
}

function updateFromHost(): void {
  if (typeof document === 'undefined') return;
  const h = host();
  const nativeBar = h?.nativeBar === true;
  const root = document.documentElement;
  if (!nativeBar) searchOpen = false;
  root.classList.toggle(NATIVE_BAR_CLASS, nativeBar);
  root.classList.toggle(SEARCH_OPEN_CLASS, nativeBar && searchOpen);
  const width = h?.nativeBarWidth;
  if (
    nativeBar &&
    typeof width === 'number' &&
    width > 0 &&
    width <= MAX_NATIVE_BAR_WIDTH
  ) {
    root.style.setProperty(NATIVE_BAR_WIDTH_PROPERTY, `${width}px`);
  } else {
    root.style.removeProperty(NATIVE_BAR_WIDTH_PROPERTY);
  }
}

function openSearch(app: NativeBarApp, focusOmnibox?: () => void): void {
  searchOpen = true;
  updateFromHost();
  if (focusOmnibox) {
    focusOmnibox();
  } else if (typeof document !== 'undefined') {
    document.querySelector<HTMLInputElement>('.pf-omnibox input')?.focus();
  }
  app.raf.scheduleFullRedraw();
}

function listen(app: NativeBarApp): void {
  if (listening || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  listening = true;
  hostChangeHandler = () => {
    updateFromHost();
    app.raf.scheduleFullRedraw();
  };
  window.addEventListener(HOST_CHANGE_EVENT, hostChangeHandler);
  // Hide the temporary search bar after focus leaves it, delayed slightly so a
  // tap on an omnibox suggestion registers first.
  focusOutHandler = () => {
    if (!searchOpen) return;
    setTimeout(() => {
      const topbar = document.querySelector(TOPBAR_SELECTOR);
      if (!searchOpen || topbar?.contains(document.activeElement)) return;
      searchOpen = false;
      updateFromHost();
      app.raf.scheduleFullRedraw();
    }, 150);
  };
  document.addEventListener('focusout', focusOutHandler);
}

export function syncNativeBar(
  app: NativeBarApp,
  actions: ReadonlyArray<NativeBarAction>,
  focusOmnibox?: () => void,
): void {
  const h = host();
  if (h === undefined || typeof h.setActions !== 'function') return;
  listen(app);
  updateFromHost();
  const [home, ...rest] = actions;
  const all: NativeBarAction[] = [
    ...(home !== undefined ? [home] : []),
    {
      id: 'search',
      label: 'Search',
      icon: 'search',
      run: () => openSearch(app, focusOmnibox),
    },
    ...rest,
  ];
  runners = new Map(all.map((action) => [action.id, action.run]));
  h.onRunAction = async (id: string) => {
    try {
      return await runners.get(id)?.();
    } finally {
      app.raf.scheduleFullRedraw();
    }
  };
  const payload: NativeBarActionPayload[] = all.map(
    ({id, label, icon, checked, disabled, group}) => ({
      id,
      label,
      icon,
      checked: checked ?? false,
      disabled: disabled ?? false,
      group: group ?? 'main',
    }),
  );
  const json = JSON.stringify(payload);
  if (json === sent) return;
  sent = json;
  h.setActions(payload);
}

export function resetNativeBarForTesting(): void {
  if (typeof window !== 'undefined' && hostChangeHandler) {
    window.removeEventListener(HOST_CHANGE_EVENT, hostChangeHandler);
  }
  if (typeof document !== 'undefined' && focusOutHandler) {
    document.removeEventListener('focusout', focusOutHandler);
  }
  hostChangeHandler = undefined;
  focusOutHandler = undefined;
  sent = '';
  runners = new Map();
  searchOpen = false;
  listening = false;
}
