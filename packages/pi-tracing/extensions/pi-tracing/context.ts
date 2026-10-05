// SPDX-License-Identifier: Apache-2.0
// Counts only; content stays in the harness and is never copied into snapshots.
export const CONTEXT_CATEGORIES = {
  system: 'System instructions', rules: 'Rules and memory', skills: 'Skills',
  tools: 'Tool definitions', environment: 'Environment', prompts: 'User prompts',
  assistant: 'Assistant history', results: 'Tool results', summaries: 'Compaction summaries',
  overhead: 'Harness overhead', messages: 'Conversation', unattributed: 'Unattributed',
} as const;
export type ContextCategory = keyof typeof CONTEXT_CATEGORIES;
export interface ContextItem {
  id: string; category: ContextCategory; tokens: number; chars?: number;
  source_id?: string; source_kind?: string; label?: string;
}
export interface ContextSnapshot {
  version: number; stage: string; item_stage?: string; basis: string; coverage: string; baseline: boolean;
  categories: Record<string, number>; estimated_tokens?: number; reported_tokens?: number;
  window_tokens?: number; compact_threshold_tokens?: number; effective_window_tokens?: number; model?: string;
  changes: (ContextItem & {change: string; delta_tokens: number})[];
  omitted_changes: number;
}
export const estimateContextTokens = (chars: number): number => Math.ceil(chars / 4);
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === 'string' ? v : '';
const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
export function instructionCategory(name: string): ContextCategory {
  if (/rule|memory|claude.?md|agents.?md|instruction.?file/i.test(name)) return 'rules';
  if (/skill/i.test(name)) return 'skills';
  if (/environment|date|workspace|session.?info|project|email/i.test(name)) return 'environment';
  if (/reminder|wrapper/i.test(name)) return 'overhead';
  if (/tool|agent|command/i.test(name)) return 'tools';
  return 'system';
}
function contentChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return 0;
  return value.reduce((n, raw) => {
    const b = obj(raw);
    // Binary images and encrypted reasoning have no locally countable text.
    return n + str(b.text ?? b.thinking).length + (b.type === 'toolCall' || b.type === 'tool_use'
      ? str(b.name).length + JSON.stringify(b.arguments ?? b.input ?? {}).length : 0);
  }, 0);
}
export function transcriptItems(messages: unknown): ContextItem[] {
  if (!Array.isArray(messages)) return [];
  const items: ContextItem[] = [];
  const sections = new Map<string, ContextItem>(), tools = new Map<string, ContextItem>();
  messages.forEach((raw, index) => {
    const m = obj(raw), role = str(m.role), id = str(m.id ?? m.uuid) || `message:${role}:${m.timestamp ?? index}`;
    const category: ContextCategory = role === 'system' ? 'system' : role === 'assistant' ? 'assistant'
      : role === 'toolResult' || role === 'tool' ? 'results' : /compaction|summary/i.test(role) ? 'summaries'
      : role === 'user' ? 'prompts' : 'unattributed';
    const chars = contentChars(m.content ?? m.text ?? m.summary);
    if (chars) items.push({id, category, chars, tokens: estimateContextTokens(chars),
      source_id: str(m.toolCallId ?? m.tool_use_id), source_kind: category === 'results' ? 'tool' : category === 'prompts' ? 'prompt' : 'response',
      label: category === 'results' ? str(m.toolName ?? m.name) || 'Tool result' : CONTEXT_CATEGORIES[category]});
    for (const [name, text] of Object.entries(obj(m.sections))) {
      if (text === null) sections.delete(name);
      else if (typeof text === 'string') sections.set(name, {id: `section:${name}`, category: instructionCategory(name), chars: text.length,
        tokens: estimateContextTokens(text.length), label: name.slice(0, 96)});
    }
    for (const [i, tool] of (Array.isArray(m.toolsAdded) ? m.toolsAdded : []).entries()) {
      const chars = JSON.stringify(tool).length;
      const name = str(obj(tool).name) || String(i);
      tools.set(name, {id: `tool:${name}`, category: 'tools', tokens: estimateContextTokens(chars), chars,
        label: name.slice(0, 96)});
    }
    for (const tool of Array.isArray(m.toolsRemoved) ? m.toolsRemoved : []) tools.delete(typeof tool === 'string' ? tool : str(obj(tool).name));
  });
  return [...items, ...sections.values(), ...tools.values()];
}
export class ContextTracker {
  private previous?: Map<string, ContextItem>;
  private model?: string;
  reset() {this.previous = undefined; this.model = undefined;}
  snapshot(items: ContextItem[], options: {stage: string; item_stage?: string; basis?: string; coverage?: string;
      categories?: Record<string, number>; reported_tokens?: number; window_tokens?: number;
      compact_threshold_tokens?: number; effective_window_tokens?: number; model?: string}): ContextSnapshot {
    const baseline = this.previous === undefined || options.model !== this.model;
    const previous = baseline ? new Map<string, ContextItem>() : this.previous!;
    const current = new Map(items.filter(i => count(i.tokens) !== undefined).map(i => {
      // Optional fields must remain absent in the typed annotation encoder.
      const item = Object.fromEntries(Object.entries(i).filter(([, value]) => value !== undefined)) as unknown as ContextItem;
      return [item.id, item] as const;
    }));
    const categories: Record<string, number> = {};
    for (const item of current.values()) categories[item.category] = (categories[item.category] ?? 0) + item.tokens;
    const changes: ContextSnapshot['changes'] = [];
    for (const item of current.values()) {
      const old = previous.get(item.id);
      if (!old || old.tokens !== item.tokens || old.category !== item.category) changes.push({...item,
        change: !old ? baseline ? 'baseline' : 'added' : 'replaced', delta_tokens: item.tokens - (old?.tokens ?? 0)});
    }
    for (const item of previous.values()) if (!current.has(item.id)) changes.push({...item, change: 'removed', delta_tokens: -item.tokens});
    changes.sort((a, b) => Math.abs(b.delta_tokens) - Math.abs(a.delta_tokens));
    this.previous = current; this.model = options.model;
    const measured = options.categories ?? categories;
    return {version: 1, stage: options.stage, basis: options.basis ?? 'chars/4', coverage: options.coverage ?? 'partial', baseline,
      ...(options.item_stage ? {item_stage: options.item_stage} : {}),
      categories: measured, ...(Object.keys(measured).length ? {estimated_tokens: Object.values(measured).reduce((a, b) => a + b, 0)} : {}),
      ...(count(options.reported_tokens) !== undefined ? {reported_tokens: options.reported_tokens} : {}),
      ...(count(options.window_tokens) !== undefined ? {window_tokens: options.window_tokens} : {}),
      ...(count(options.compact_threshold_tokens) !== undefined ? {compact_threshold_tokens: options.compact_threshold_tokens} : {}),
      ...(count(options.effective_window_tokens) !== undefined ? {effective_window_tokens: options.effective_window_tokens} : {}),
      ...(options.model ? {model: options.model} : {}), changes: changes.slice(0, 64), omitted_changes: Math.max(0, changes.length - 64)};
  }
}
