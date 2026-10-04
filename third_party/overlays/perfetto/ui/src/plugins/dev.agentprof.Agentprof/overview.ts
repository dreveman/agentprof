// SPDX-License-Identifier: Apache-2.0

import m from 'mithril';
import {Button, ButtonVariant} from '../../widgets/button';
import {Tabs} from '../../widgets/tabs';
import {Card} from '../../widgets/card';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {Icon} from '../../widgets/icon';
import {PopupMenu, MenuItem} from '../../widgets/menu';
import {navigate} from './navigation';
import type {Trace} from '../../public/trace';
import type {SqlValue} from '../../trace_processor/query_result';
import {OVERVIEW_QUERIES} from './overview_queries';
import {toolDescription} from './tool_description';
import './overview.scss';

type Row = Record<string, SqlValue>;
type Section = keyof typeof OVERVIEW_QUERIES;
type Tab = 'Summary' | 'Responses' | 'Tools' | 'Sessions';
interface State {rows?: Row[]; error?: string}
interface Attrs {trace: Trace}

function number(value: SqlValue | undefined): number {return Number(value ?? 0);}
function value(v: SqlValue | undefined): string {
  return v === null || v === undefined ? 'Not recorded' : String(v);
}
function duration(v: SqlValue | undefined): string {
  if (v === null || v === undefined) return 'Not recorded';
  const ms = Number(v);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}
function metric(label: string, v: string): m.Children {
  return m(Card, {className: 'ap-metric'}, m('.ap-label', label), m('strong', v));
}
function headlineMetric(label: string, v: string, explanation: string, detail?: m.Children): m.Children {
  return m(Card, {className: 'ap-headline-metric', title: explanation},
    m('.ap-headline-label', label), m('strong', v), detail);
}
function shareBar(fraction: SqlValue | undefined, title?: string, stacked = false): m.Children {
  if (fraction === null || fraction === undefined) return 'Not recorded';
  const share = Number(fraction);
  const percentage = m('span.ap-cellbar__pct', `${(share * 100).toFixed(1)}%`);
  const track = m('.ap-cellbar__track', m('.ap-cellbar__fill', {
      style: `width:${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%`,
    }));
  return m(stacked ? '.ap-cellbar.ap-cellbar--stacked' : '.ap-cellbar',
    {title, role: 'img', 'aria-label': `${(share * 100).toFixed(1)}%`},
    stacked ? [percentage, track] : [track, percentage]);
}
function rateMarker(rate: SqlValue | undefined, fastest: number | undefined): m.Children {
  if (rate === null || rate === undefined) return 'Not recorded';
  const value = Number(rate);
  const label = value.toLocaleString('en-US', {maximumFractionDigits: 1});
  if (fastest === undefined || !Number.isFinite(value)) return label;
  const position = Math.min(100, Math.max(0, value / fastest * 100));
  return m('.ap-rate', {
    role: 'img',
    'aria-label': `${label} output tokens per second; fastest measured session: ${fastest.toLocaleString('en-US', {maximumFractionDigits: 1})}`,
    title: `${label} output tokens/s · shared scale: 0 to ${fastest.toLocaleString('en-US', {maximumFractionDigits: 1})}`,
  },
    m('span.ap-rate__value', label),
    m('.ap-rate__axis', m('span.ap-rate__dot', {style: {left: `${position.toFixed(1)}%`}})));
}
function recordedWindow(windowMs: SqlValue | undefined, fractions: (number | null)[] | undefined,
                        clockAligned: boolean): m.Children {
  if (windowMs === null || windowMs === undefined) return 'Not recorded';
  return m('.ap-window-cell', m('span', duration(windowMs)),
    !clockAligned ? m('span.ap-muted', 'Unavailable') :
      !fractions?.some(f => f !== null) ? m('span.ap-muted', 'Not recorded') :
        m('.ap-spark', {role: 'img', 'aria-label': 'Measured model and tool activity across 48 equal time buckets'},
          fractions.map(f => m('.ap-spark__bar', {
            style: {height: `${Math.max(3, Math.min(1, Math.max(0, f ?? 0)) * 100)}%`},
          }))));
}
function tokens(v: SqlValue | undefined): string {
  return v === null || v === undefined ? 'Not recorded' : Number(v).toLocaleString('en-US');
}
function sessionExcerpt(prompt: SqlValue | undefined, session: SqlValue | undefined): string {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    const id = value(session);
    return id.length > 16 ? `${id.slice(0, 16).trimEnd()}...` : id;
  }
  const line = prompt.split(/\r?\n/).map(text => text.trim()
    .replace(/^#{1,6}\s+|^(?:[-*]|\d+[.)])\s+/, ''))
    .find(text => text.length > 0 && !/^(?:task|instructions|context|goal|request):?$/i.test(text));
  if (!line) return sessionExcerpt(null, session);
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  const start = sentence.slice(0, 96);
  const boundary = start.lastIndexOf(' ');
  const excerpt = sentence.length > 96 && boundary > 60 ? start.slice(0, boundary) : start;
  const shortened = sentence.length > excerpt.length || prompt.trim().length > sentence.length;
  return shortened ? `${excerpt.replace(/[\s.!?]+$/, '')}...` : excerpt;
}
function sessionLabels(row: Row): string[] {
  return typeof row.session_labels === 'string' ? JSON.parse(row.session_labels) : [];
}
function invocationDescription(row: Row): m.Children {
  const intent = typeof row.intent === 'string' ? row.intent : undefined;
  const isScript = row.kind === 'script';
  const description = toolDescription(intent, typeof row.arguments === 'string' ? row.arguments : undefined,
    isScript ? {
      language: typeof row.language === 'string' ? row.language : undefined,
      lineCount: row.line_count === null || row.line_count === undefined ? undefined : Number(row.line_count),
      truncated: number(row.args_truncated) !== 0,
    } : undefined);
  if (description === undefined) return m('span.ap-description-missing', 'Not recorded');
  const partial = !intent?.trim() && !isScript && number(row.args_truncated) !== 0;
  return m('.ap-tool-description', {
    className: intent?.trim() || isScript ? undefined : 'ap-tool-description--arguments',
    title: description + (partial ? '\n(Some arguments were omitted from the recording.)' : ''),
  }, description);
}
function sessionName(row: Row, trace: Trace): m.Children {
  const name = sessionExcerpt(row.prompt_text, row.session);
  const labels = sessionLabels(row);
  const subtitle = labels.length > 0 && m('span.ap-session-labels',
    labels.map(label => m('span.ap-session-label', label)));
  if (row.prompt_id === null || row.prompt_id === undefined) {
    return m('.ap-session-name', m('span.ap-prompt-fallback', name), subtitle);
  }
  return m('.ap-session-name', m(Button, {
    label: name, rightIcon: 'open_in_new', compact: true, shrink: true,
    variant: ButtonVariant.Minimal, className: 'ap-prompt-link',
    title: `Session ${value(row.session)} · Open the full recorded prompt in the timeline`,
    'aria-label': `Open prompt: ${name}`,
    onclick: (event: MouseEvent) => {
      event.stopPropagation();
      navigate(trace, '/viewer');
      trace.selection.selectSqlEvent('slice', number(row.prompt_id), {scrollToSelection: true});
    },
  }), subtitle);
}
function activitySeries(rows: Row[]): Map<number, (number | null)[]> {
  const byCapture = new Map<number, (number | null)[]>();
  for (const point of rows) {
    const id = number(point.capture_id);
    let series = byCapture.get(id);
    if (series === undefined) {
      series = new Array<number | null>(48).fill(null);
      byCapture.set(id, series);
    }
    series[number(point.bin)] = point.busy_fraction === null ? null : number(point.busy_fraction);
  }
  return byCapture;
}
function sessionFact(label: string, contents: m.Children, title?: string): m.Children {
  return m('.ap-session-fact', {title}, m('.ap-label', label), m('.ap-session-fact__value', contents));
}
function answer(text: string): m.Children {return m(Callout, {icon: 'lightbulb', intent: Intent.Primary}, text);}

function harnessIcons(v: SqlValue | undefined): m.Children {
  return m('.ap-harness-icons', value(v).split(',').map(harness => {
    const id = harness.trim().toLowerCase().replace(/[ _]+/g, '-');
    const isClaudeCode = id === 'claude-code' || id === 'claude';
    const isCodex = id === 'codex' || id === 'codex-cli';
    const name = id === 'pi' ? 'Pi' : isClaudeCode ? 'Claude Code' : isCodex ? 'Codex' : harness;
    return m('span.ap-harness-icon', {role: 'img', 'aria-label': name, title: name},
      id === 'pi' ? m('svg', {viewBox: '0 0 800 800', 'aria-hidden': 'true'},
        m('path', {fill: 'currentColor', d: 'M165.29 165.29H517.36V400H400V282.65H165.29Z'}),
        m('path', {fill: 'currentColor', d: 'M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z'}),
        m('path', {fill: 'currentColor', d: 'M517.36 400H634.72V634.72H517.36Z'}))
        : isClaudeCode ? m('svg', {viewBox: '0 0 24 24', 'aria-hidden': 'true'},
          m('path', {fill: 'currentColor', d: 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z'}))
        : isCodex ? m('svg', {viewBox: '0 0 512 509.639', 'aria-hidden': 'true',
          'shape-rendering': 'geometricPrecision', 'text-rendering': 'geometricPrecision',
          'image-rendering': 'optimizeQuality', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd'},
          m('path', {fill: 'currentColor', 'fill-rule': 'nonzero', d: 'M412.037 221.764a90.834 90.834 0 004.648-28.67 90.79 90.79 0 00-12.443-45.87c-16.37-28.496-46.738-46.089-79.605-46.089-6.466 0-12.943.683-19.264 2.04a90.765 90.765 0 00-67.881-30.515h-.576c-.059.002-.149.002-.216.002-39.807 0-75.108 25.686-87.346 63.554-25.626 5.239-47.748 21.31-60.682 44.03a91.873 91.873 0 00-12.407 46.077 91.833 91.833 0 0023.694 61.553 90.802 90.802 0 00-4.649 28.67 90.804 90.804 0 0012.442 45.87c16.369 28.504 46.74 46.087 79.61 46.087a91.81 91.81 0 0019.253-2.04 90.783 90.783 0 0067.887 30.516h.576l.234-.001c39.829 0 75.119-25.686 87.357-63.588 25.626-5.242 47.748-21.312 60.682-44.033a91.718 91.718 0 0012.383-46.035 91.83 91.83 0 00-23.693-61.553l-.004-.005zM275.102 413.161h-.094a68.146 68.146 0 01-43.611-15.8 56.936 56.936 0 002.155-1.221l72.54-41.901a11.799 11.799 0 005.962-10.251V241.651l30.661 17.704c.326.163.55.479.596.84v84.693c-.042 37.653-30.554 68.198-68.21 68.273h.001zm-146.689-62.649a68.128 68.128 0 01-9.152-34.085c0-3.904.341-7.817 1.005-11.663.539.323 1.48.897 2.155 1.285l72.54 41.901a11.832 11.832 0 0011.918-.002l88.563-51.137v35.408a1.1 1.1 0 01-.438.94l-73.33 42.339a68.43 68.43 0 01-34.11 9.12 68.359 68.359 0 01-59.15-34.11l-.001.004zm-19.083-158.36a68.044 68.044 0 0135.538-29.934c0 .625-.036 1.731-.036 2.5v83.801l-.001.07a11.79 11.79 0 005.954 10.242l88.564 51.13-30.661 17.704a1.096 1.096 0 01-1.034.093l-73.337-42.375a68.36 68.36 0 01-34.095-59.143 68.412 68.412 0 019.112-34.085l-.004-.003zm251.907 58.621l-88.563-51.137 30.661-17.697a1.097 1.097 0 011.034-.094l73.337 42.339c21.109 12.195 34.132 34.746 34.132 59.132 0 28.604-17.849 54.199-44.686 64.078v-86.308c.004-.032.004-.065.004-.096 0-4.219-2.261-8.119-5.919-10.217zm30.518-45.93c-.539-.331-1.48-.898-2.155-1.286l-72.54-41.901a11.842 11.842 0 00-5.958-1.611c-2.092 0-4.15.558-5.957 1.611l-88.564 51.137v-35.408l-.001-.061a1.1 1.1 0 01.44-.88l73.33-42.303a68.301 68.301 0 0134.108-9.129c37.704 0 68.281 30.577 68.281 68.281a68.69 68.69 0 01-.984 11.545v.005zm-191.843 63.109l-30.668-17.704a1.09 1.09 0 01-.596-.84v-84.692c.016-37.685 30.593-68.236 68.281-68.236a68.332 68.332 0 0143.689 15.804 63.09 63.09 0 00-2.155 1.222l-72.54 41.9a11.794 11.794 0 00-5.961 10.248v.068l-.05 102.23zm16.655-35.91l39.445-22.782 39.444 22.767v45.55l-39.444 22.767-39.445-22.767v-45.535z'}))
        : m(Icon, {icon: harness === 'Not recorded' ? 'help_outline' : 'terminal'}));
  }));
}

function modelIdentity(row: Row): m.Children {
  // Keep provider/model pairs intact when a capture includes different agents
  // or changes configuration. Separate concatenated lists lose that association.
  const identities: {provider: SqlValue; model: SqlValue}[] = typeof row.model_identities === 'string'
    ? JSON.parse(row.model_identities) : [{provider: row.provider ?? null, model: row.model ?? null}];
  return m('.ap-model-identities', identities.map(identity => {
    const model = value(identity.model);
    const provider = value(identity.provider);
    // Keep the exact model ID for grouping and inspection; omit Claude's
    // dated snapshot suffix from the visible label.
    const label = model.replace(/^(claude-.+)-\d{8}$/, '$1');
    return m('.ap-model-identity', {title: `${provider} / ${model}`},
      m('span.ap-model-name', label),
      provider !== 'Not recorded' && m('span.ap-model-provider', provider));
  }));
}

export class Overview implements m.ClassComponent<Attrs> {
  private tab: Tab = 'Summary';
  private readonly data: Partial<Record<Section, State>> = {};
  private readonly expandedSessions = new Set<number>();
  private readonly expandedScripts = new Set<number>();
  private disposed = false;

  oninit({attrs}: m.Vnode<Attrs>) {
    for (const [section, sql] of Object.entries(OVERVIEW_QUERIES)) {
      const key = section as Section;
      this.data[key] = {};
      void attrs.trace.engine.query(sql).then(result => {
        const rows: Row[] = [];
        for (const it = result.iter({}); it.valid(); it.next()) {
          rows.push(Object.fromEntries(result.columns().map(c => [c, it.get(c)])));
        }
        if (!this.disposed) this.data[key] = {rows};
      }).catch(error => {
        if (!this.disposed) this.data[key] = {error: String(error)};
      }).finally(() => {if (!this.disposed) m.redraw();});
    }
  }
  onremove() {this.disposed = true;}

  private section(key: Section, render: (rows: Row[]) => m.Children, allowEmpty = false): m.Children {
    const state = this.data[key];
    if (state?.error) return m('.ap-error', {role: 'alert'}, `Could not read this section: ${state.error}`);
    if (!state?.rows) return m('.ap-muted', {role: 'status'}, 'Reading the trace…');
    if (!allowEmpty && state.rows.length === 0) return m('.ap-muted', 'Not recorded in this trace.');
    return render(state.rows);
  }

  private card(title: string, description: string, body: m.Children, tab?: Tab): m.Children {
    return m(Card, {className: 'ap-card'},
      m('.ap-card-header', m('h2', title), tab && m(Button, {
        label: `Explore ${tab.toLowerCase()}`, rightIcon: 'arrow_forward',
        variant: ButtonVariant.Minimal, onclick: () => {this.tab = tab;},
      })),
      m('p.ap-muted', description), body);
  }

  private scriptTable(rows: Row[], children: Row[], trace: Trace): m.Children {
    return m('.ap-table-scroll', m('table.ap-script-table',
      m('thead', m('tr', ['', 'Script', 'Description', 'Wall time', 'Nested calls', 'Status'].map(label => m('th', label)))),
      m('tbody', rows.map(row => {
        const id = number(row.id);
        const expanded = this.expandedScripts.has(id);
        const toggle = () => expanded ? this.expandedScripts.delete(id) : this.expandedScripts.add(id);
        return [m('tr.ap-script-row', {onclick: toggle},
          m('td', m(Button, {icon: expanded ? 'expand_more' : 'chevron_right',
            'aria-label': `${expanded ? 'Collapse' : 'Expand'} script`, 'aria-expanded': expanded,
            variant: ButtonVariant.Minimal, compact: true})),
          m('td', {'data-label': 'Script'}, m(Button, {label: value(row.script), rightIcon: 'open_in_new', compact: true,
            shrink: true, className: 'ap-table-link',
            variant: ButtonVariant.Minimal, onclick: (event: MouseEvent) => {
              event.stopPropagation(); navigate(trace, '/viewer');
              trace.selection.selectSqlEvent('slice', id, {scrollToSelection: true});
            }})),
          m('td.ap-description-cell', {'data-label': 'Description'}, invocationDescription(row)),
          m('td', {'data-label': 'Wall time'}, duration(row.duration_ms)),
          m('td', {'data-label': 'Nested calls'}, value(row.calls)),
          m('td', {'data-label': 'Status'}, number(row.incomplete) ? 'Incomplete' :
            row.is_error === null ? 'Not recorded' : number(row.is_error) ? 'Error' : 'Complete')),
          expanded && m('tr.ap-script-expanded', m('td', {colspan: 6}, number(row.calls) === 0 ?
            m('p.ap-muted', 'No nested calls were recorded.') :
            this.table(children.filter(child => number(child.script_id) === id), [
              ['tool', 'Call'], ['description', 'Description'], ['duration_ms', 'Observed duration'], ['is_error', 'Error'],
              ['incomplete', 'Incomplete'],
            ], trace))),
        ];
      })),
    ));
  }

  private table(rows: Row[], columns: [string, string][], trace?: Trace, clockAligned = true,
                seriesByCapture?: Map<number, (number | null)[]>): m.Children {
    const rates = columns.some(([key]) => key === 'tokens_per_s') ? rows
      .map(row => row.tokens_per_s).filter(rate => rate !== null && rate !== undefined)
      .map(rate => Number(rate)).filter(rate => Number.isFinite(rate) && rate >= 0) : [];
    const fastestRate = rates.length > 1 && Math.max(...rates) > 0 ? Math.max(...rates) : undefined;
    const cellClass = (key: string) => key === 'model' ? 'ap-model-cell' :
      key === 'prompt_text' ? 'ap-prompt-cell' : key === 'description' ? 'ap-description-cell' : undefined;
    return m('.ap-table-scroll', m('table', {className: columns.some(([key]) => key === 'description') ? 'ap-invocation-table' : undefined},
      m('thead', m('tr', columns.map(([key, label]) => m('th', {
        className: cellClass(key),
        title: key === 'peak_model_responses' ?
          'Maximum simultaneous measured model-response spans in this session and its subagent sessions' :
          key === 'tokens_per_s' && fastestRate !== undefined ?
            'Output tokens per measured model-response second; dots share a 0-to-fastest-session scale' : undefined,
      }, label)))),
      m('tbody', rows.map(row => m('tr', columns.map(([key, label], index) => m('td', {
        'data-label': label,
        className: cellClass(key),
        title: key === 'prompt_text' ? row.prompt_id === null || row.prompt_id === undefined ? value(row.session) : undefined :
          key === 'model' || key === 'harness' || key === 'description' ? undefined : value(row[key])},
        key === 'description' ? invocationDescription(row) :
        key === 'prompt_text' ? trace ? sessionName(row, trace) :
          m('span.ap-prompt-fallback', sessionExcerpt(row.prompt_text, row.session)) :
          index === 0 && trace && row.id !== undefined ? m(Button, {
          label: value(row[key]), 'aria-label': value(row[key]), title: value(row[key]),
          rightIcon: 'open_in_new', compact: true, shrink: true,
          variant: ButtonVariant.Minimal, className: 'ap-table-link',
          onclick: () => {
            navigate(trace, '/viewer');
            trace.selection.selectSqlEvent('slice', number(row.id), {scrollToSelection: true});
          },
        }) : key === 'context_share' ? shareBar(row[key],
          `Highest recorded context share in this session and its subagent sessions`, true) :
          key === 'tokens_per_s' ? rateMarker(row[key], fastestRate) :
          key === 'model_busy_ms' ? !clockAligned ? 'Unavailable' :
            row[key] === null || row[key] === undefined ? 'Not recorded' :
              number(row.duration_ms) > 0 ? shareBar(number(row[key]) / number(row.duration_ms),
                'Share of this session’s recorded window', true) : 'Not recorded' :
          key === 'peak_model_responses' && !clockAligned ? 'Unavailable' :
          key === 'duration_ms' && seriesByCapture ? recordedWindow(row[key],
            seriesByCapture.get(number(row.capture_id)), clockAligned) :
          key.endsWith('_ms') ? duration(row[key]) :
          key.endsWith('_tokens') || key === 'peak_context' ? tokens(row[key]) :
          key === 'harness' ? harnessIcons(row[key]) :
          key === 'model' ? modelIdentity(row) :
          key === 'effort' && typeof row[key] === 'string' ? row[key].split(',').map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(', ') :
          (key === 'is_error' || key === 'incomplete') && trace && row.id !== undefined && row[key] !== null
            ? (number(row[key]) ? 'Yes' : 'No') :
            key === 'session' && value(row[key]).length > 20 ? `${value(row[key]).slice(0, 12)}…` : value(row[key]),
      ))))),
    ));
  }

  private sessionDetails(row: Row, clockAligned: boolean,
                         fastestRate: number | undefined, nested: boolean): m.Children {
    return m('.ap-session-details',
      sessionFact('Session ID', m('code', value(row.session))),
      sessionFact('Role', value(row.role)),
      sessionFact('Capture', value(row.capture)),
      sessionFact('Effort', typeof row.effort === 'string' ? row.effort.split(',').map(v =>
        v.charAt(0).toUpperCase() + v.slice(1)).join(', ') : value(row.effort)),
      sessionFact('Input tokens', tokens(row.input_tokens)),
      sessionFact('Output tokens', tokens(row.output_tokens)),
      nested && sessionFact('Tokens/s', rateMarker(row.tokens_per_s, fastestRate)),
      nested && sessionFact('Context usage', shareBar(row.context_share,
        'Highest recorded context share in this capture', true)),
      sessionFact('Peak context', tokens(row.peak_context)),
      sessionFact('Max context window', tokens(row.context_window_tokens)),
      sessionFact('Model busy', !clockAligned ? 'Unavailable' :
        row.model_busy_ms === null || row.model_busy_ms === undefined ? 'Not recorded' :
          number(row.duration_ms) > 0 ? shareBar(number(row.model_busy_ms) / number(row.duration_ms),
            'Share of this capture’s recorded window', true) : 'Not recorded'),
      sessionFact('Peak responses', !clockAligned ? 'Unavailable' : value(row.peak_model_responses)),
      sessionFact('Responses', value(row.responses)),
      sessionFact('Tool calls', value(row.tools)),
      number(row.incomplete) > 0 && sessionFact('Incomplete operations', value(row.incomplete)));
  }

  private sessionTable(rows: Row[], allRows: Row[], trace: Trace, clockAligned: boolean,
                       seriesByCapture: Map<number, (number | null)[]>, nested = false): m.Children {
    const rates = allRows.map(row => row.tokens_per_s).filter(rate => rate !== null && rate !== undefined)
      .map(rate => Number(rate)).filter(rate => Number.isFinite(rate) && rate >= 0);
    const fastestRate = rates.length > 1 && Math.max(...rates) > 0 ? Math.max(...rates) : undefined;
    const columns: [string, string][] = nested ? [
      ['harness', 'Agent'], ['model', 'Model'], ['prompt_text', 'Session'],
      ['role', 'Role'], ['duration_ms', 'Recorded window'], ['turns', 'Turns'],
      ['expand', ''],
    ] : [
      ['harness', 'Agent'], ['model', 'Model'], ['prompt_text', 'Session'],
      ['tokens_per_s', 'Tokens/s'], ['context_share', 'Context usage'],
      ['duration_ms', 'Recorded window'], ['turns', 'Turns'],
      ['subagents', 'Subagents'], ['expand', ''],
    ];
    return m('table.ap-session-table', {className: nested ? 'ap-session-table--subagents' : undefined},
      m('thead', m('tr', columns.map(([key, label]) => m('th',
        key === 'expand' ? {'aria-label': 'Expand session'} : {}, label)))),
      m('tbody', rows.flatMap(row => {
        const id = number(row.capture_id);
        const expanded = this.expandedSessions.has(id);
        const toggle = () => {
          if (this.expandedSessions.has(id)) this.expandedSessions.delete(id);
          else this.expandedSessions.add(id);
        };
        const children = nested ? [] : allRows.filter(child =>
          number(child.root_capture_id) === id && number(child.capture_id) !== id);
        const cells = columns.map(([key, label]) => m('td', {'data-label': label},
          key === 'harness' ? harnessIcons(row.harness) :
          key === 'model' ? modelIdentity(row) :
          key === 'prompt_text' ? sessionName(row, trace) :
          key === 'tokens_per_s' ? rateMarker(row.tokens_per_s, fastestRate) :
          key === 'context_share' ? shareBar(row.context_share,
            'Highest recorded context share in this capture', true) :
          key === 'duration_ms' ? recordedWindow(row.duration_ms,
            seriesByCapture.get(id), clockAligned) :
          key === 'subagents' ? String(children.length) :
          key === 'expand' ? m(Button, {
            icon: expanded ? 'expand_less' : 'expand_more',
            'aria-label': `${expanded ? 'Hide' : 'Show'} details for session ${value(row.session)}`,
            'aria-expanded': expanded ? 'true' : 'false',
            'aria-controls': `ap-session-details-${id}`,
            title: expanded ? 'Hide session details' : 'Show session details',
            compact: true, variant: ButtonVariant.Minimal,
            onclick: (event: MouseEvent) => {
              event.stopPropagation();
              toggle();
            },
          }) : value(row[key])));
        return [m('tr.ap-session-row', {onclick: toggle,
          className: expanded ? 'ap-session-row--expanded' : undefined}, cells),
          expanded && m('tr.ap-session-expanded',
            m('td', {colSpan: columns.length, id: `ap-session-details-${id}`},
              this.sessionDetails(row, clockAligned, fastestRate, nested),
              children.length > 0 && [
                m('h3.ap-subheading', 'Subagent sessions'),
                this.sessionTable(children, allRows, trace, clockAligned, seriesByCapture, true),
              ]))];
      })));
  }

  view({attrs: {trace}}: m.CVnode<Attrs>): m.Children {
    const summary = this.data.summary?.rows?.[0];
    const aligned = summary !== undefined && number(summary.clock_errors) === 0;
    const singleSession = summary !== undefined && number(summary.sessions) === 1;
    const singleModel = singleSession && number(summary?.single_model) === 1;
    const scope = singleSession ? (number(summary?.subagents) > 0 ? 'this session and its subagents' : 'this session') : 'all captured sessions';
    const models = () => this.section('models', rows => this.table(rows, [
      ['model', 'Model'], ['responses', 'Responses'],
      ['first_content_ms', 'Avg first content'], ['duration_ms', 'Avg message'],
      ['latency_samples', 'With first content'],
      ['input_tokens', 'Input tokens'], ['output_tokens', 'Output tokens'],
      ['cache_read_tokens', 'Cache read'], ['input_samples', 'With input usage'],
      ['output_samples', 'With output usage'],
    ]));
    const tools = () => this.section('tools', rows => this.table(rows, [
      ['tool', 'Tool'], ['calls', 'Calls'], ['work_ms', 'Completed work'],
      ['longest_ms', 'Longest completed'], ['errors', 'Errors'], ['outcomes', 'Known outcomes'], ['incomplete', 'Incomplete'],
    ]));
    const content = m('.ap-content',
        m('h1', this.tab === 'Summary' ? 'What your trace says about agent activity' : this.tab),
        m('p.ap-intro', 'Explore the recorded work, then follow an operation into the timeline.'),
        this.tab === 'Summary' ? [
          this.card('What happened in this recording?', 'Recording totals and a performance comparison of sessions.', [
            this.section('headline', ([headline]) => m('.ap-headline-row',
              headlineMetric('TOKENS/S', headline.output_tokens_per_s === null ? 'Not recorded' :
                number(headline.output_tokens_per_s).toLocaleString('en-US', {maximumFractionDigits: 1}),
              'Reported output tokens divided by the summed durations of responses with output usage.'),
              headlineMetric('WALL WINDOW', aligned ? duration(headline.wall_window_ms) : 'Unavailable',
                'Elapsed time from the first recorded event to the last, including gaps between sessions.'),
              headlineMetric('MODEL BUSY', aligned ? duration(headline.model_busy_ms) : 'Unavailable',
                'Time when at least one measured model response was active; overlapping responses count once.',
                aligned && headline.model_busy_ms !== null && number(headline.wall_window_ms) > 0 ?
                  shareBar(number(headline.model_busy_ms) / number(headline.wall_window_ms),
                    'Share of the recording wall window') : undefined),
              headlineMetric('PEAK RESPONSES', aligned ? value(headline.peak_model_responses) : 'Unavailable',
                'Maximum simultaneous measured model-response spans across the recording.'))),
            m('h3.ap-subheading', 'Sessions'),
            m('.ap-session-summary', this.section('runs', rows => this.section('session_activity', seriesRows => {
              const seriesByCapture = activitySeries(seriesRows);
              const columns: [string, string][] = [
                ['harness', 'Agent'], ['model', 'Model'], ['prompt_text', 'Session'],
                ['input_tokens', 'Input tokens'], ['output_tokens', 'Output tokens'],
                ['tokens_per_s', 'Tokens/s'], ['context_share', 'Context usage'],
                ['duration_ms', 'Recorded window'], ['model_busy_ms', 'Model busy'],
              ];
              return this.table(rows, columns, trace, aligned, seriesByCapture);
            }))),
            m('p.ap-muted', 'Session totals include subagents. Tokens/s uses measured responses with output tokens; dots share one scale.'),
          ], 'Sessions'),
          this.card('Where was time spent?', `Measured model-response and completed tool intervals across ${scope}. Concurrent work is counted once.`,
            this.section('activity', ([a]) => {
              if (!summary) return m('p', 'Reading clock information…');
              if (!aligned) return answer('Clock conversion errors were reported; combined time metrics are unavailable.');
              const segments: [string, number, string][] = [
                ['Model responses only', number(a.models_only_ms), 'model'],
                ['Tools only', number(a.tools_only_ms), 'tool'],
                ['Model responses + tools', number(a.overlap_ms), 'overlap'],
              ];
              if (number(summary.scripts) > 0) segments.push(['Scripts only', number(a.scripts_only_ms), 'script']);
              const total = segments.reduce((n, [, ms]) => n + ms, 0);
              return [answer(`${duration(total)} of measured activity. Uncovered time is not classified as waiting.`),
                m(Card, {className: 'ap-meter-card'},
                m('.ap-label', 'Measured activity split'),
                m('strong.ap-meter-value', duration(total)),
                total > 0 ? m('.ap-meter', {role: 'img', 'aria-label': segments.map(([name, ms]) => `${name}: ${duration(ms)}`).join(', ')},
                  segments.map(([name, ms, cls]) => m(`span.ap-${cls}`, {style: {width: `${ms / total * 100}%`}, title: `${name}: ${duration(ms)}`}))) : null,
                m('.ap-legend', segments.map(([name, ms, cls]) => m('span', m(`i.ap-${cls}`), `${name}: ${duration(ms)}`)))),
                m('p.ap-muted', 'Provider response-header time is not full request latency. Missing model durations and unfinished tools are excluded.')];
            })),
          this.card(singleModel ? 'How responsive was the model?' : 'How responsive were model responses?', `Responses grouped by provider and model across ${scope}. First content is measured from message start and may include thinking or tool-call content.`, models(), 'Responses'),
          this.card('Which tools took the most time?', `Completed tool work across ${scope}. Work can overlap; its sum is not elapsed wall time.`, tools(), 'Tools'),
          this.card('Was work happening in parallel?', `Concurrency of completed tools across ${scope}, over their measured active time.`,
            this.section('activity', ([a]) => !aligned ? answer('Combined concurrency is unavailable because clock conversion errors were reported.') : [
              answer(number(a.peak_tools) > 1 ? `Up to ${value(a.peak_tools)} tools ran at once.` : 'No overlap was observed among completed tools.'),
              m('.ap-metrics', metric('Peak concurrent tools', value(a.peak_tools)),
                metric('Time with 2+ tools', duration(a.parallel_ms)), metric('Tool-active time', duration(a.tool_active_ms))),
              this.section('concurrency', rows => [
                m('.ap-concurrency', {role: 'img', 'aria-label': 'Peak concurrent completed tools across 40 equal time windows'},
                  rows.map(row => m('span', {style: {height: `${number(row.tools) / Math.max(1, number(a.peak_tools)) * 100}%`},
                    title: `${duration(row.offset_ms)} from first measured activity: ${value(row.tools)} tools`}))),
                m('p.ap-muted', 'Peak concurrent tools in each of 40 equal windows, from first to last measured activity.'),
              ]),
            ])),
          this.card('Is the recording complete?', `Capture health across ${scope}. Missing measurements remain unknown; incomplete operations are separate from observed errors.`, [
            summary && number(summary.machines) > 1 && m('p.ap-muted', 'Cross-machine timing uses recorded wall clocks and depends on the hosts’ clock synchronization.'),
            summary && answer(`${value(summary.incomplete)} incomplete operations recorded.${aligned ? '' : ' Clock conversion errors were reported.'}`),
            this.section('health', rows => [
              rows.some(row => row.metric === 'Lane overflows' && number(row.value) > 0) &&
                answer('Some concurrent calls could not be recorded because the tool lane limit was reached. Tool counts and timings are incomplete.'),
              this.table(rows, [['metric', 'Capture metric'], ['value', 'Maximum recorded value']]),
            ]),
            m('p.ap-muted', 'Approval waits, queue delays, retries, and full child execution are not yet summarized. Absence of capture counters does not establish a clean capture.'),
          ]),
        ] : this.tab === 'Responses' ? [
          this.card('Responses by provider and model', `Responses across ${scope}. Token sums cover reported values only. Coverage counts show responses with usage.`, models()),
          this.card('Recorded responses', 'First 200 responses. Select a session to reveal the message event in the timeline.',
            m('.ap-recorded-responses', this.section('responses', rows => this.table(rows,
              [['session', 'Session'], ['model', 'Model'], ['first_content_ms', 'First content'],
                ['duration_ms', 'Message duration'], ['input_tokens', 'Input tokens'],
                ['output_tokens', 'Output tokens']], trace)))),
        ] : this.tab === 'Tools' ? [
          this.card('Tool summary', 'Incomplete operations and script wall time are excluded from completed tool durations.', tools()),
          number(summary?.scripts) > 0 && this.card('Scripted tool use',
            'Agent-written scripts and the tool calls they execute.',
            this.section('scripts', rows => this.section('script_calls', children => [
              this.scriptTable(rows, children, trace),
              children.some(child => child.kind === 'model-call') && m('p.ap-muted',
                'Model-call intervals may include queue time; they are excluded from model-response speed and busy metrics.'),
            ], true))),
          this.card('Slow and incomplete calls', 'Up to 100 calls. Incomplete durations show only the observed interval.',
            this.section('slow', rows => this.table(rows, [['tool', 'Tool'], ['description', 'Description'],
              ['duration_ms', 'Observed duration'], ['is_error', 'Error'], ['incomplete', 'Incomplete']], trace))),
        ] : this.card('Captured sessions', 'Expand a session for its details and subagent sessions. The Overview combines their activity.',
          this.section('sessions', rows => this.section('capture_activity', seriesRows =>
            this.sessionTable(rows.filter(row => number(row.capture_id) === number(row.root_capture_id)),
              rows, trace, aligned, activitySeries(seriesRows))))),
      );
    const tabs: [Tab, string][] = [
      ['Summary', 'dashboard'], ['Responses', 'forum'],
      ['Tools', 'build'], ['Sessions', 'account_tree'],
    ];
    return m('.ap-page', m('.ap-inner',
      m('header.ap-header',
        m('.ap-toolbar',
          m('.ap-selectors',
            m('.ap-selector', m('span.ap-label', 'Analysing'),
              m(PopupMenu, {trigger: m(Button, {
                label: `Agent activity · ${this.tab}`, icon: 'analytics',
                rightIcon: 'arrow_drop_down', variant: ButtonVariant.Outlined,
              })}, tabs.map(([tab, icon]) => m(MenuItem, {
                label: tab, icon, onclick: () => {this.tab = tab;},
              })))),
            m('.ap-selector', m('span.ap-label', 'Region of interest'),
              m(PopupMenu, {trigger: m(Button, {
                label: 'Full recording', icon: 'crop_free', rightIcon: 'arrow_drop_down',
                variant: ButtonVariant.Outlined,
                title: 'Analysis covers the full recording',
              })}, m(MenuItem, {label: 'Full recording', icon: 'check', onclick: () => {}})))),
          m(Button, {label: 'Open timeline', icon: 'timeline',
            variant: ButtonVariant.Filled, onclick: () => navigate(trace, '/viewer')})),
        m('.ap-banner', m(Icon, {icon: 'smart_toy'}), `Recording ${trace.traceInfo.traceTitle || 'multiple traces'}`)),
      m(Tabs, {className: 'ap-tabs', activeTabKey: this.tab,
        onTabChange: key => {this.tab = key as Tab;},
        tabs: tabs.map(([tab, icon]) => ({key: tab, title: tab, leftIcon: icon,
          content: tab === this.tab ? content : undefined})),
      }),
    ));
  }
}
