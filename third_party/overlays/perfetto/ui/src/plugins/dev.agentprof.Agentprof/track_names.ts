// SPDX-License-Identifier: Apache-2.0

const TRACK_NAMES: Record<string, string> = {
  "agent.lifecycle": "Agent",
  "provider.activity": "Requests",
  "llm.responses": "Responses",
  "Model responses": "Responses",
  "tools": "Tools",
  "workflow": "Workflow",
  "session.activity": "Session",
  "llm.tokens.input": "Input tokens",
  "llm.tokens.output": "Output tokens",
  "llm.context.estimated_tokens": "Context size",
  "llm.context.window_tokens": "Context window",
  "runtime.rss": "Resident memory",
  "runtime.heap": "JS heap",
  "runtime.cpu": "CPU time (interval)",
  "tracing.droppedEvents": "Dropped events",
  "tracing.queueDepth": "Queue depth",
  "tracing.laneOverflows": "Lane overflows"
};

export function trackDisplayName(name: string): string {
  if (/^workflow\.child\.\d+$/.test(name)) return 'Child workflows';
  return TRACK_NAMES[name] ?? name;
}

// Counter names in old recordings are internal metric keys. Normalize both
// generations once so analysis and grouping share the same interpretation.
export const COUNTER_TRACKS_SQL = `
CREATE PERFETTO TABLE agentprof_counter_tracks AS
WITH names(metric, display_name, group_name) AS (VALUES
  ('llm.tokens.input', 'Input tokens', NULL),
  ('llm.tokens.output', 'Output tokens', NULL),
  ('llm.context.estimated_tokens', 'Context size', NULL),
  ('llm.context.window_tokens', 'Context window', NULL),
  ('runtime.rss', 'Resident memory', 'Runtime'),
  ('runtime.heap', 'JS heap', 'Runtime'),
  ('runtime.cpu', 'CPU time (interval)', 'Runtime'),
  ('tracing.droppedEvents', 'Dropped events', 'Tracing'),
  ('tracing.queueDepth', 'Queue depth', 'Tracing'),
  ('tracing.laneOverflows', 'Lane overflows', 'Tracing')
)
SELECT t.id, n.metric AS name, n.display_name, n.group_name, m.capture_id
FROM counter_track t JOIN names n ON t.name IN (n.metric, n.display_name)
  OR (n.metric = 'llm.context.estimated_tokens' AND t.name = 'Context size (est.)')
JOIN agentprof_track_process m ON m.track_id = t.id;
`;
