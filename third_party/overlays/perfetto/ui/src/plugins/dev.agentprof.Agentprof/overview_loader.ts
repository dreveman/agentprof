// SPDX-License-Identifier: Apache-2.0
import type {OVERVIEW_QUERIES} from './overview_queries';

export type OverviewTab = 'Summary' | 'Responses' | 'Tools' | 'Sessions' | 'Context';
export type OverviewSection = keyof typeof OVERVIEW_QUERIES;
export interface QueryState<Row> {rows?: Row[]; error?: string}

// Load only the visible tab. The lightweight latest-per-capture query feeds
// Summary; the bounded context timeline is deferred until Context is opened.
export const TAB_QUERIES: Record<OverviewTab, readonly OverviewSection[]> = {
  Summary: ['summary', 'headline', 'runs', 'session_activity', 'activity', 'context_latest',
    'models', 'tools', 'concurrency', 'health'],
  Responses: ['summary', 'models', 'responses'],
  Tools: ['summary', 'tools', 'slow', 'scripts', 'script_calls'],
  Sessions: ['summary', 'sessions', 'capture_activity'],
  Context: ['summary', 'context_latest', 'context_snapshots', 'context_changes', 'context_history', 'context_compactions'],
};

export class OverviewLoader<Row> {
  private disposed = false;
  constructor(private readonly query: (section: OverviewSection) => Promise<Row[]>,
              private readonly changed: () => void,
              readonly data: Partial<Record<OverviewSection, QueryState<Row>>> = {}) {}

  open(tab: OverviewTab) {
    if (this.disposed) return;
    for (const key of TAB_QUERIES[tab]) {
      const summary = this.data.summary?.rows?.[0] as {scripts?: unknown} | undefined;
      if (tab === 'Tools' && (key === 'scripts' || key === 'script_calls') &&
          summary && Number(summary.scripts ?? 0) === 0) continue;
      if (this.data[key] !== undefined) continue; // cached, including in flight or failed
      this.data[key] = {};
      void Promise.resolve().then(() => this.disposed ? [] : this.query(key)).then(rows => {
        if (!this.disposed) this.data[key] = {rows};
      }).catch(error => {
        if (!this.disposed) this.data[key] = {error: String(error)};
      }).finally(() => {if (!this.disposed) this.changed();});
    }
  }

  dispose() {this.disposed = true;}
}
