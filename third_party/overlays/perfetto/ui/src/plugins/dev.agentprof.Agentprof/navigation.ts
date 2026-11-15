// SPDX-License-Identifier: Apache-2.0
import type {Trace} from '../../public/trace';

const OVERVIEW_BASE = '/agentprof';
const SPLIT_VIEWPORT_MIN_WIDTH = 721;

let exampleEngineId: string | undefined;
let exampleRouteId = '1';
let lastOverviewEngineId: string | undefined;
let lastOverviewRoute = OVERVIEW_BASE;
let secondaryPaneWasOpen = false;
let overviewCollapsed = false;

export function isOverviewCollapsed(): boolean {
  return overviewCollapsed;
}

export function setOverviewCollapsed(collapsed: boolean): void {
  overviewCollapsed = collapsed;
}

export function isWideSplitViewport(): boolean {
  return (
    typeof window === 'undefined' ||
    (window.innerWidth || 1024) >= SPLIT_VIEWPORT_MIN_WIDTH
  );
}

export function isSplitSecondaryEnabled(
  settings?: {get<T>(id: string): {get(): T} | undefined},
): boolean {
  return settings?.get<boolean>('splitSecondaryPages')?.get() ?? true;
}

export function markExample(trace: Trace, routeId = '1'): void {
  exampleEngineId = trace.engine.engineId;
  exampleRouteId = routeId;
}

export function exampleHref(route: string, routeId: string): string {
  return '#!' + route + '?agentprof_example=' + encodeURIComponent(routeId);
}

export function traceHref(trace: Trace | undefined, route: string): string {
  if (trace === undefined) return '#!' + route;
  if (trace.engine.engineId === exampleEngineId) {
    return exampleHref(route, exampleRouteId);
  }
  const key =
    trace.getCurrentRoute?.()?.args?.local_cache_key ||
    (trace.traceInfo.cached ? trace.traceInfo.uuid : undefined);
  return (
    '#!' + route + (key ? '?local_cache_key=' + encodeURIComponent(key) : '')
  );
}

export function overviewRoute(trace?: Trace): string {
  if (trace && trace.engine.engineId === lastOverviewEngineId) {
    return lastOverviewRoute;
  }
  return OVERVIEW_BASE;
}

export function overviewSubpage(
  trace: Trace,
  routeSubpage?: string,
): string | undefined {
  const currentPage = trace.getCurrentRoute?.()?.page;
  const isSecondaryOpen =
    currentPage !== undefined && currentPage !== OVERVIEW_BASE;
  if (isSecondaryOpen) {
    secondaryPaneWasOpen = true;
    if (trace.engine.engineId === lastOverviewEngineId) {
      const sub = lastOverviewRoute.slice(OVERVIEW_BASE.length);
      return sub || undefined;
    }
    return undefined;
  }
  if (
    secondaryPaneWasOpen &&
    !routeSubpage &&
    trace.engine.engineId === lastOverviewEngineId
  ) {
    secondaryPaneWasOpen = false;
    const sub = lastOverviewRoute.slice(OVERVIEW_BASE.length);
    return sub || undefined;
  }
  secondaryPaneWasOpen = false;
  if (routeSubpage !== undefined) {
    lastOverviewEngineId = trace.engine.engineId;
    lastOverviewRoute = `${OVERVIEW_BASE}${routeSubpage}`;
  }
  return routeSubpage;
}

export function closeSecondaryPane(trace: Trace): void {
  const currentPage = trace.getCurrentRoute?.()?.page;
  if (
    overviewCollapsed &&
    currentPage !== undefined &&
    currentPage !== '' &&
    currentPage !== '/' &&
    currentPage !== OVERVIEW_BASE &&
    currentPage !== '/viewer'
  ) {
    trace.navigate(traceHref(trace, '/viewer'));
    return;
  }
  overviewCollapsed = false;
  const target = overviewRoute(trace);
  trace.navigate(traceHref(trace, target));
}

export function navigate(trace: Trace, route: string): void {
  if (route === OVERVIEW_BASE || route.startsWith(`${OVERVIEW_BASE}/`)) {
    overviewCollapsed = false;
    lastOverviewEngineId = trace.engine.engineId;
    lastOverviewRoute = route;
    const currentPage = trace.getCurrentRoute?.()?.page;
    // Switching tabs inside the left Overview pane while a secondary pane is
    // open keeps the secondary pane open on wide split viewports.
    if (
      route.startsWith(`${OVERVIEW_BASE}/`) &&
      isSplitSecondaryEnabled(trace.settings) &&
      isWideSplitViewport() &&
      currentPage !== undefined &&
      currentPage !== OVERVIEW_BASE &&
      currentPage !== '/'
    ) {
      trace.raf?.scheduleFullRedraw?.();
      return;
    }
  }
  trace.navigate(traceHref(trace, route));
}

export function navigateHome(app: {navigate(uri: string): void}): void {
  if (typeof window !== 'undefined' && window.location.hash.includes('local_cache_key=')) {
    window.history.replaceState(null, '', '#!/');
  }
  app.navigate('#!/');
}

export function resetNavigationForTesting(): void {
  exampleEngineId = undefined;
  exampleRouteId = '1';
  lastOverviewEngineId = undefined;
  lastOverviewRoute = OVERVIEW_BASE;
  secondaryPaneWasOpen = false;
  overviewCollapsed = false;
}
