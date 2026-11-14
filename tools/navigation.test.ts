// SPDX-License-Identifier: Apache-2.0
import {afterEach, expect, test} from 'bun:test';
import type {Trace} from '../third_party/src/perfetto/ui/src/public/trace';
import {
  closeSecondaryPane,
  isOverviewCollapsed,
  markExample,
  navigate,
  overviewRoute,
  overviewSubpage,
  resetNavigationForTesting,
  setOverviewCollapsed,
  traceHref,
} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/navigation.ts';

function fakeTrace(options?: {
  engineId?: string;
  page?: string;
  subpage?: string;
  cacheKey?: string;
  cachedUuid?: string;
  split?: boolean;
}) {
  const navigated: string[] = [];
  let redraws = 0;
  let page = options?.page ?? '/agentprof';
  let subpage = options?.subpage ?? '';
  const trace = {
    engine: {engineId: options?.engineId ?? 'engine-1'},
    traceInfo: {
      cached: Boolean(options?.cachedUuid),
      uuid: options?.cachedUuid ?? 'uuid-1',
    },
    settings: {
      get: (id: string) =>
        id === 'splitSecondaryPages'
          ? {get: () => options?.split ?? true}
          : undefined,
    },
    raf: {
      scheduleFullRedraw: () => {
        redraws++;
      },
    },
    getCurrentRoute: () => ({
      page,
      subpage,
      args: options?.cacheKey ? {local_cache_key: options.cacheKey} : {},
    }),
    navigate: (href: string) => {
      navigated.push(href);
      const path = href.replace(/^#!/, '').split('?')[0] ?? '';
      const slash = path.indexOf('/', 1);
      page = slash > 0 ? path.slice(0, slash) : path;
      subpage = slash > 0 ? path.slice(slash) : '';
    },
  } as unknown as Trace;
  return {
    trace,
    navigated,
    getRedraws: () => redraws,
    setRoute: (nextPage: string, nextSubpage = '') => {
      page = nextPage;
      subpage = nextSubpage;
    },
  };
}

afterEach(() => {
  resetNavigationForTesting();
});

test('traceHref preserves example route IDs and cached trace keys without empty-key rewrites', () => {
  const {trace: exampleTrace} = fakeTrace({engineId: 'ex-1'});
  markExample(exampleTrace, 'codex');
  expect(traceHref(exampleTrace, '/viewer')).toBe(
    '#!/viewer?agentprof_example=codex',
  );

  const {trace: cachedTrace} = fakeTrace({
    engineId: 'cached-1',
    cachedUuid: 'abc-123',
  });
  expect(traceHref(cachedTrace, '/info')).toBe(
    '#!/info?local_cache_key=abc-123',
  );
});

test('overviewSubpage preserves the active tab across secondary-pane opens and closes', () => {
  const {trace, navigated, setRoute} = fakeTrace();
  expect(overviewSubpage(trace, '/turns')).toBe('/turns');
  expect(overviewRoute(trace)).toBe('/agentprof/turns');

  // Opening Timeline in the secondary pane keeps the Overview pane on /turns.
  setRoute('/viewer', '');
  expect(overviewSubpage(trace, '')).toBe('/turns');

  // Closing the secondary pane returns to the remembered Overview subpage.
  closeSecondaryPane(trace);
  expect(navigated.at(-1)).toBe('#!/agentprof/turns');
});

test('switching Overview tabs while a split secondary pane is open keeps the secondary pane open', () => {
  const {trace, navigated, getRedraws} = fakeTrace({page: '/viewer'});
  navigate(trace, '/agentprof/tools');

  expect(navigated).toEqual([]);
  expect(getRedraws()).toBe(1);
  expect(overviewRoute(trace)).toBe('/agentprof/tools');
  expect(isOverviewCollapsed()).toBe(false);
});

test('closeSecondaryPane returns to home when the Overview rail is collapsed', () => {
  const {trace, navigated} = fakeTrace({
    page: '/settings',
    cacheKey: 'trace-uuid',
  });
  setOverviewCollapsed(true);
  closeSecondaryPane(trace);

  expect(navigated).toEqual(['/#?'.startsWith('/') ? '#!/?local_cache_key=trace-uuid' : '']);
});
