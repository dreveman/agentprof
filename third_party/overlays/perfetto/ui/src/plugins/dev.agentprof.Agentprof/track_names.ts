// SPDX-License-Identifier: Apache-2.0

const TRACK_NAMES: Record<string, string> = {
  'agent.lifecycle': 'Agent',
  'provider.activity': 'Requests',
  'llm.responses': 'Responses',
  'Model responses': 'Responses',
  'tools': 'Tools',
  'workflow': 'Workflow',
  'session.activity': 'Session',
  'llm.tokens.input': 'Input tokens',
  'llm.tokens.output': 'Output tokens',
  'llm.context.estimated_tokens': 'Context size',
  'llm.context.window_tokens': 'Context window',
  'runtime.rss': 'Resident memory',
  'runtime.heap': 'JS heap',
  'runtime.cpu': 'CPU time (interval)',
  'tracing.droppedEvents': 'Dropped events',
  'tracing.queueDepth': 'Queue depth',
  'tracing.laneOverflows': 'Lane overflows',
};

export function trackDisplayName(name: string): string {
  if (/^workflow\.child\.\d+$/.test(name)) return 'Child workflows';
  return TRACK_NAMES[name] ?? name;
}
