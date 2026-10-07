// SPDX-License-Identifier: Apache-2.0
import m from 'mithril';
import {Button, ButtonVariant} from '../../widgets/button';
import type {Trace} from '../../public/trace';
import type {SqlValue} from '../../trace_processor/query_result';
import {navigate} from './navigation';

type Row = Record<string, SqlValue>;
interface Attrs {trace: Trace; latest?: Row[]; snapshots: Row[]; changes: Row[]; history: Row[]; compactions: Row[]; detailed?: boolean}
const CATEGORIES: Record<string, [string, string]> = {
  system: ['System instructions', '#639bdb'], rules: ['Rules and memory', '#9274ce'],
  skills: ['Skills', '#cd77af'], tools: ['Tool definitions', '#3da9a1'],
  environment: ['Environment', '#9a9d60'], prompts: ['User prompts', '#d6a043'],
  assistant: ['Assistant history', '#748bcc'], results: ['Tool results', '#56a67d'],
  summaries: ['Compaction summaries', '#bf7959'], overhead: ['Harness overhead', '#8c879f'],
  messages: ['Conversation', '#76959d'], unattributed: ['Unattributed', '#979a9e'],
};
const n = (v: SqlValue | undefined): number => Number(v ?? 0);
const format = (v: SqlValue | undefined) => v === null || v === undefined ? 'Not recorded' : n(v).toLocaleString('en-US');
const categories = (row: Row): Record<string, number> => typeof row.categories === 'string' ? JSON.parse(row.categories) : {};
function eventLink(trace: Trace, id: number, label: string): m.Children {
  return m(Button, {label, rightIcon: 'open_in_new', compact: true, shrink: true,
    className: 'ap-table-link', variant: ButtonVariant.Minimal, onclick: (e: MouseEvent) => {
      e.stopPropagation(); navigate(trace, '/viewer'); trace.selection.selectSqlEvent('slice', id, {scrollToSelection: true});
    }});
}

export function contextSummary(snapshots: Row[]): m.Children {
  const latest = new Map<number, Row>();
  for (const row of snapshots) {
    const id = n(row.capture_id), previous = latest.get(id);
    if (!previous || n(row.ts) >= n(previous.ts)) latest.set(id, row);
  }
  if (!latest.size) return m('p.ap-muted', 'Category breakdown not recorded. Explore Context for total usage.');
  const breakdown: Record<string, number> = {};
  for (const row of latest.values()) for (const [key, amount] of Object.entries(categories(row))) {
    breakdown[key] = (breakdown[key] ?? 0) + amount;
  }
  const sorted = Object.entries(breakdown).filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, amount]) => sum + amount, 0);
  if (!total) return m('p.ap-muted', 'No category estimates recorded.');
  return m('.ap-context.ap-context-summary',
    m('.ap-context-capacity', {role: 'img', 'aria-label': 'Aggregated estimated context composition'},
      sorted.map(([key, amount]) => m('span', {
        style: {width: `${amount / total * 100}%`, background: CATEGORIES[key]?.[1] ?? '#979a9e'},
        title: `${CATEGORIES[key]?.[0] ?? key}: ${format(amount)} estimated tokens`,
      }))),
    m('.ap-context-legend', sorted.map(([key, amount]) => m('.ap-context-category',
      m('i', {style: {background: CATEGORIES[key]?.[1] ?? '#979a9e'}}), m('span', CATEGORIES[key]?.[0] ?? key),
      m('strong', format(amount)), m('span.ap-muted', `${(amount / total * 100).toFixed(1)}%`)))),
    m('p.ap-muted', `Latest recorded estimates from ${latest.size} session${latest.size === 1 ? '' : 's'}. Percentages show the share of measured context.`),
  );
}

export class ContextView implements m.ClassComponent<Attrs> {
  private capture?: number;
  private selected?: number;
  private allChanges = false;
  private category = '';
  private selectedOnly = false;
  private sort = 'size';
  private readonly expanded = new Set<string>();

  view({attrs}: m.CVnode<Attrs>): m.Children {
    const {trace, latest = [], snapshots, changes, history, compactions, detailed} = attrs;
    const sessions = new Map<number, Row>();
    for (const row of [...latest, ...history, ...snapshots]) sessions.set(n(row.capture_id), row);
    if (!sessions.size) return m('p.ap-muted', 'Context usage was not recorded.');
    if (this.capture === undefined || !sessions.has(this.capture)) {
      const primary = [...sessions.values()].find(r => n(r.capture_id) === n(r.root_capture_id));
      this.capture = primary ? n(primary.capture_id) : undefined;
      this.capture ??= sessions.keys().next().value;
    }
    const retained = snapshots.filter(s => n(s.capture_id) === this.capture);
    const samples = retained.length ? retained : latest.filter(s => n(s.capture_id) === this.capture);
    const totals = history.filter(s => n(s.capture_id) === this.capture);
    const compact = compactions.filter(s => n(s.capture_id) === this.capture);
    const selected = samples.find(s => n(s.event_id) === this.selected) ?? samples.at(-1);
    const points = samples.length ? samples : totals;
    const start = points.length ? Math.min(...[...points, ...totals].map(s => n(s.ts))) : 0, end = points.length ? Math.max(...[...points, ...totals].map(s => n(s.ts))) : 0;
    const peak = Math.max(1, ...[...points, ...totals].map(s => Math.max(n(s.estimated_tokens), n(s.reported_tokens), n(s.tokens))));
    const max = peak * 1.15;
    const x = (ts: SqlValue | undefined) => end > start ? 40 + (n(ts) - start) / (end - start) * 920 : 500;
    const y = (tokens: number) => 175 - tokens / max * 155;
    const steps = (rows: Row[], field: string) => rows.flatMap((s, i) => {
      const right = i + 1 < rows.length ? x(rows[i + 1].ts) : x(s.ts);
      return [`${x(s.ts)},${y(n(s[field]))}`, `${right},${y(n(s[field]))}`];
    }).join(' ');
    const keys = [...new Set(samples.flatMap(s => Object.keys(categories(s))))];
    const series = (key: string): string => {
      const upper: string[] = [], lower: string[] = [];
      for (const [i, s] of samples.entries()) {
        const values = categories(s), below = keys.slice(0, keys.indexOf(key)).reduce((sum, k) => sum + (values[k] ?? 0), 0);
        const left = samples.length === 1 ? 40 : x(s.ts);
        const right = samples.length === 1 ? 960 : i + 1 < samples.length ? x(samples[i + 1].ts) : x(s.ts);
        upper.push(`${left},${y(below + (values[key] ?? 0))}`, `${right},${y(below + (values[key] ?? 0))}`);
        lower.unshift(`${right},${y(below)}`, `${left},${y(below)}`);
      }
      return [...upper, ...lower].join(' ');
    };
    const breakdown = selected ? categories(selected) : {};
    const limit = n(selected?.window_tokens), estimate = n(selected?.estimated_tokens);
    const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    const additions = changes.filter(c => n(c.capture_id) === this.capture &&
      (!this.category || c.category === this.category) && (!this.selectedOnly || n(c.snapshot_id) === n(selected?.event_id)) &&
      (this.allChanges || (!n(c.baseline) && n(c.delta_tokens) > 0)))
      .sort((a, b) => this.sort === 'time' ? n(a.ts) - n(b.ts) : Math.abs(n(b.delta_tokens)) - Math.abs(n(a.delta_tokens)))
      .slice(0, detailed ? 100 : 5);
    const quality = selected?.basis === 'native-summary' ? 'Harness estimates' : selected?.basis === 'native-bytes/4' ? 'Request text estimates (bytes ÷ 4)' : 'Text estimates (characters ÷ 4)';
    const transcript = selected?.stage === 'transcript-observed';
    return m('.ap-context',
      m('.ap-context-controls',
        m('label', 'Session ', m('select', {value: this.capture, 'aria-label': 'Context session', onchange: (e: Event) => {
          this.capture = Number((e.target as HTMLSelectElement).value); this.selected = undefined;
        }}, [...sessions.entries()].map(([id, s]) => m('option', {value: id},
          `${s.harness ? `${s.harness} · ` : ''}${String(s.session).slice(0, 20)}${String(s.session).length > 20 ? '…' : ''}${n(s.root_capture_id) !== id ? ' · subagent' : ''}`)))),
        selected && m('span.ap-muted', `${quality} · ${selected.coverage === 'complete' ? 'Complete' : 'Partial attribution'}`)),
      !retained.length && samples.length > 0 && m('p.ap-muted', 'Only the latest sample is shown for this session; older detail is outside the bounded overview.'),
      samples.length === 0 && m('p.ap-muted', 'Category breakdown not recorded. Showing total context usage.'),
      transcript && m('p.ap-muted', 'Composition estimates use recorded transcript items; the final model request may differ.'),
      m('svg.ap-context-chart', {viewBox: '0 0 1000 210', role: 'img', 'aria-label': 'Context tokens over time. Select a request to inspect its composition.'},
        m('line', {x1: 40, x2: 960, y1: 175, y2: 175, stroke: 'currentColor', opacity: 0.2}),
        keys.map(k => m('polygon', {points: series(k), fill: CATEGORIES[k]?.[1] ?? '#979a9e', opacity: 0.85})),
        points.some(s => n(s.window_tokens) > 0 && n(s.window_tokens) <= max) && m('polyline', {points: points.map(s => `${x(s.ts)},${y(n(s.window_tokens))}`).join(' '), fill: 'none', stroke: 'currentColor', 'stroke-dasharray': '5 4', opacity: 0.45}),
        totals.length > 0 && m('polyline', {points: steps(totals, 'tokens'), fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
          opacity: 0.7}),
        compact.filter(c => n(c.ts) >= start && n(c.ts) <= end).map(c => m('line', {x1: x(c.ts), x2: x(c.ts), y1: 20, y2: 175,
          stroke: 'currentColor', 'stroke-dasharray': '2 4'}, m('title', 'Compaction'))),
        samples.map(s => m('g', {onclick: () => {this.selected = n(s.event_id);}, role: 'button', tabindex: 0,
          'aria-label': `Inspect context at ${((n(s.ts) - start) / 1e9).toFixed(2)} seconds`,
          onkeydown: (e: KeyboardEvent) => {if (e.key === 'Enter' || e.key === ' ') {e.preventDefault(); this.selected = n(s.event_id);}}},
          m('circle', {cx: x(s.ts), cy: y(n(s.estimated_tokens)), r: selected === s ? 5 : 3, fill: 'currentColor'}),
          m('circle', {cx: x(s.ts), cy: y(n(s.estimated_tokens)), r: 12, fill: 'transparent'},
            m('title', `${format(s.estimated_tokens)} estimated tokens · ${((n(s.ts) - start) / 1e9).toFixed(2)} s`)))),
        m('text', {x: 40, y: 200, fill: 'currentColor'}, '0 s'),
        m('text', {x: 960, y: 200, 'text-anchor': 'end', fill: 'currentColor'}, `${((end - start) / 1e9).toFixed(2)} s`),
        m('text', {x: 40, y: 14, fill: 'currentColor'}, `${Math.round(max).toLocaleString('en-US')} tokens`)),
      m('p.ap-muted', 'Line: recorded total context. Colors: estimated composition. Chart scaled to observed usage.'),
      selected && [
        m('.ap-context-heading', m('strong', `${format(selected.estimated_tokens)} estimated tokens${limit ? ` of ${format(limit)} (${(estimate / limit * 100).toFixed(1)}%)` : ''}`),
          eventLink(trace, n(selected.event_id), selected.stage === 'capture-start' ? 'Capture' : selected.stage === 'post-compaction' ? 'Compaction' : selected.stage === 'transcript-observed' ? 'Response' : 'Request')),
        selected.reported_tokens !== null && selected.reported_tokens !== undefined && m('p.ap-muted', `${format(selected.reported_tokens)} reported request input tokens. Category estimates may differ.`),
        selected.effective_window_tokens !== null && selected.effective_window_tokens !== undefined && n(selected.effective_window_tokens) !== limit && m('p.ap-muted', `Effective compaction window: ${format(selected.effective_window_tokens)} tokens.`),
        selected.compact_threshold_tokens !== null && selected.compact_threshold_tokens !== undefined && m('p.ap-muted', `Compaction threshold: ${format(selected.compact_threshold_tokens)} tokens.`),
        m('.ap-context-capacity', {role: 'img', 'aria-label': 'Estimated context composition'}, sorted.map(([k, amount]) => m('span', {
          style: {width: `${amount / Math.max(1, limit, estimate) * 100}%`, background: CATEGORIES[k]?.[1] ?? '#979a9e'},
          title: `${CATEGORIES[k]?.[0] ?? k}: ${format(amount)} estimated tokens` }))),
        m('.ap-context-legend', sorted.map(([k, amount]) => m('.ap-context-category',
          m('i', {style: {background: CATEGORIES[k]?.[1] ?? '#979a9e'}}), m('span', CATEGORIES[k]?.[0] ?? k),
          m('strong', format(amount)), m('span.ap-muted', limit ? `${(amount / limit * 100).toFixed(1)}%` : '')))),
        n(selected.omitted_changes) > 0 && m('p.ap-muted', `${format(selected.omitted_changes)} smaller item changes omitted; category totals include them.`),
      ],
      m('.ap-context-heading', m('h3', this.allChanges ? 'Recorded changes' : 'Largest additions'), detailed &&
        m('label', m('input', {type: 'checkbox', checked: this.allChanges, onchange: (e: Event) => {
          this.allChanges = (e.target as HTMLInputElement).checked;
        }}), ' Include baseline and removals')),
      detailed && m('.ap-context-controls',
        m('label', 'Category ', m('select', {value: this.category, 'aria-label': 'Context category', onchange: (e: Event) => {this.category = (e.target as HTMLSelectElement).value;}},
          m('option', {value: ''}, 'All categories'), Object.entries(CATEGORIES).map(([key, [label]]) => m('option', {value: key}, label)))),
        m('label', 'Order ', m('select', {value: this.sort, 'aria-label': 'Context order', onchange: (e: Event) => {this.sort = (e.target as HTMLSelectElement).value;}},
          m('option', {value: 'size'}, 'Largest change'), m('option', {value: 'time'}, 'Time'))),
        m('label', m('input', {type: 'checkbox', checked: this.selectedOnly, onchange: (e: Event) => {this.selectedOnly = (e.target as HTMLInputElement).checked;}}), ' Selected observation only')),
      !additions.length ? m('p.ap-muted',
        'No attributed additions in the retained 500 largest changes for this selection. Older or smaller changes may exist in the timeline.') :
        m('table.ap-context-table', m('thead', m('tr', (detailed ? ['Source', 'Category', 'Estimated change', 'Estimated context', 'Time'] : ['Source', 'Category', 'Estimated change', 'Time']).map(t => m('th', t)))),
          m('tbody', additions.map(c => {
            const key = `${c.snapshot_id}:${c.item_id}`, expanded = this.expanded.has(key);
            const toggle = () => {expanded ? this.expanded.delete(key) : this.expanded.add(key);};
            return [m('tr', {onclick: toggle, tabindex: 0, 'aria-expanded': expanded,
              onkeydown: (e: KeyboardEvent) => {if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {e.preventDefault(); toggle();}},
              className: expanded ? 'ap-context-row--expanded' : undefined},
              m('td', eventLink(trace, n(c.event_id), String(c.tool ?? c.label ?? 'Context item'))),
              m('td', CATEGORIES[String(c.category)]?.[0] ?? String(c.category)),
              m('td', `${n(c.delta_tokens) > 0 ? '+' : ''}${format(c.delta_tokens)}`),
              detailed && m('td', `${format(c.previous_estimated_tokens)} → ${format(c.estimated_tokens)}`),
              m('td', `${((n(c.ts) - start) / 1e9).toFixed(2)} s`)), expanded && m('tr.ap-context-detail', m('td', {colspan: detailed ? 5 : 4},
                `${c.change} · ${format(c.tokens)} estimated tokens${c.chars !== null && c.chars !== undefined ? ` · ${format(c.chars)} characters` : ''}. `,
                c.stage === 'transcript-observed' ? 'Observed in the transcript; final request inclusion is unverified.' : 'Observed context item.',
                m('div.ap-muted', `Source: ${c.source_id || c.item_id}`)))];
          }))),
    );
  }
}
