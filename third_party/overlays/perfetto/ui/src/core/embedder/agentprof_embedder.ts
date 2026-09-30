// SPDX-License-Identifier: Apache-2.0
import type {Embedder} from './embedder';
import {AgentprofHomePage} from './agentprof_home_page';

import {AGENTPROF_BRAND} from './agentprof_brand';
import {AgentprofNavigation, AgentprofActions} from './agentprof_topbar';

export class AgentprofEmbedder implements Embedder {
  readonly title = 'Agent Profiler';
  readonly analyticsId = undefined;
  readonly extensionServer = undefined;
  readonly brandingBadge = undefined;
  readonly brandLogo = AGENTPROF_BRAND;
  readonly topbar = {
    navigation: AgentprofNavigation,
    actions: AgentprofActions,
  };
  readonly homePage = AgentprofHomePage;
  // Dependencies bring in SQL results and generic trace-event tracks.
  readonly defaultPlugins = [
    'dev.perfetto.CoreCommands',
    'dev.perfetto.MultiTraceOpen',
    'dev.perfetto.Timeline',
    'dev.perfetto.FlowEventsPanel',
    'dev.perfetto.TraceInfoPage',
    'dev.perfetto.SettingsPage',
    'dev.agentprof.Agentprof',
  ];
}
