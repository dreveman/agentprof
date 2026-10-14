// SPDX-License-Identifier: Apache-2.0
import type {OVERVIEW_QUERIES} from './overview_queries';

export type OverviewTab = 'Summary' | 'Turns' | 'Tools' | 'Sessions' | 'Context';
export type OverviewSection = keyof typeof OVERVIEW_QUERIES;
export interface QueryState<Row> {
  rows?: Row[];
  error?: string;
}
export interface TurnQueries<Row> {
  details: (id: number) => Promise<Row[]>;
  page: (offset: number) => Promise<Row[]>;
}

export const TAB_QUERIES: Record<OverviewTab, readonly OverviewSection[]> = {
  Summary: ['summary', 'headline', 'runs', 'session_activity', 'activity', 'context_latest',
    'models', 'tools', 'concurrency', 'health'],
  Turns: ['summary', 'models', 'responses', 'turns', 'turn_unassigned'],
  Tools: ['summary', 'tools', 'slow', 'scripts', 'script_calls'],
  Sessions: ['summary', 'sessions', 'capture_activity'],
  Context: ['summary', 'context_latest', 'context_snapshots', 'context_changes',
    'context_history', 'context_compactions'],
};

export function createTurnSetup(query: () => Promise<unknown>) {
  let pending: Promise<unknown> | undefined;
  return () => (pending ??= Promise.resolve().then(query).catch((error) => {
    pending = undefined;
    throw error;
  }));
}

export class OverviewLoader<Row> {
  private disposed = false;
  private turnGeneration = 0;
  readonly turnDetails = new Map<number, QueryState<Row>>();
  loadingMoreTurns = false;
  turnPageError?: string;

  constructor(
    private readonly query: (section: OverviewSection) => Promise<Row[]>,
    private readonly changed: () => void,
    readonly data: Partial<Record<OverviewSection, QueryState<Row>>> = {},
    private readonly turnQueries?: TurnQueries<Row>,
  ) {}

  private current(generation?: number) {
    return !this.disposed && (generation === undefined || generation === this.turnGeneration);
  }

  open(tab: OverviewTab) {
    if (this.disposed) return;
    for (const key of TAB_QUERIES[tab]) {
      const summary = this.data.summary?.rows?.[0] as {scripts?: unknown} | undefined;
      if (tab === 'Tools' && (key === 'scripts' || key === 'script_calls') && summary &&
          Number(summary.scripts ?? 0) === 0) continue;
      if (this.data[key] !== undefined) continue;
      this.data[key] = {};
      const generation = key === 'turns' || key === 'turn_unassigned' ? this.turnGeneration : undefined;
      void Promise.resolve()
        .then(() => this.current(generation) ? this.query(key) : [])
        .then((rows) => {if (this.current(generation)) this.data[key] = {rows};})
        .catch((error) => {if (this.current(generation)) this.data[key] = {error: String(error)};})
        .finally(() => {if (this.current(generation)) this.changed();});
    }
  }

  retryTurns() {
    if (this.disposed || !(this.data.turns?.error || this.data.turn_unassigned?.error)) return;
    this.turnGeneration++;
    delete this.data.turns;
    delete this.data.turn_unassigned;
    this.turnDetails.clear();
    this.turnPageError = undefined;
    this.loadingMoreTurns = false;
    this.open('Turns');
    this.changed();
  }

  openTurn(id: number) {
    if (this.disposed || !this.turnQueries || this.turnDetails.has(id)) return;
    this.turnDetails.set(id, {});
    const query = this.turnQueries;
    const generation = this.turnGeneration;
    void Promise.resolve()
      .then(() => this.current(generation) ? query.details(id) : [])
      .then((rows) => {if (this.current(generation)) this.turnDetails.set(id, {rows});})
      .catch((error) => {if (this.current(generation)) this.turnDetails.set(id, {error: String(error)});})
      .finally(() => {if (this.current(generation)) this.changed();});
  }

  retryTurn(id: number) {
    if (this.disposed || !this.turnDetails.get(id)?.error) return;
    this.turnDetails.delete(id);
    this.openTurn(id);
  }

  moreTurns() {
    const rows = this.data.turns?.rows;
    if (this.disposed || this.loadingMoreTurns || !rows || !this.turnQueries) return;
    const query = this.turnQueries;
    const generation = this.turnGeneration;
    this.loadingMoreTurns = true;
    this.turnPageError = undefined;
    this.changed();
    void Promise.resolve()
      .then(() => this.current(generation) ? query.page(rows.length) : [])
      .then((next) => {if (this.current(generation)) this.data.turns = {rows: [...rows, ...next]};})
      .catch((error) => {if (this.current(generation)) this.turnPageError = String(error);})
      .finally(() => {
        if (this.current(generation)) {
          this.loadingMoreTurns = false;
          this.changed();
        }
      });
  }

  dispose() {
    this.disposed = true;
    this.turnDetails.clear();
  }
}
