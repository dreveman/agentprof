// SPDX-License-Identifier: Apache-2.0

export type RecordingAgent = 'claude' | 'codex' | 'muse' | 'pi';

export const EXAMPLES = {
  claude: {
    routeId: 'claude',
    commandId: 'dev.agentprof.Agentprof.OpenClaudeExample',
    title: 'Open Claude Code example',
    traceName: 'claude-code-coding',
    description: 'Coding task fixing interval calculations, adding regression tests, and checking the results.',
    metadata: 'Claude Code · Anthropic Haiku 4.5 · Thinking off · 1 session',
    icon: 'smart_toy',
  },
  codex: {
    routeId: 'codex',
    commandId: 'dev.agentprof.Agentprof.OpenCodexExample',
    title: 'Open Codex example',
    traceName: 'codex-coding',
    description: 'Coding task using scripted tools to inspect files, fix interval calculations, and run regression tests.',
    metadata: 'Codex · OpenAI GPT-6-Luna · Low effort · 1 session',
    icon: 'smart_toy',
  },
  muse: {
    routeId: 'muse', commandId: 'dev.agentprof.Agentprof.OpenMuseExample',
    title: 'Open Muse Code example', traceName: 'muse-code-coding',
    description: 'Coding task fixing interval calculations, adding regression tests, and checking the results.',
    metadata: 'Muse Code · Meta Muse Spark 1.3 Contributor · Low effort · 3 sessions', icon: 'smart_toy',
  },
  comparison: {
    routeId: 'comparison',
    commandId: 'dev.agentprof.Agentprof.OpenComparisonExample',
    title: 'Open Pi vs Claude Code example',
    traceName: 'pi-vs-claude-code',
    description: 'Coding task run with Pi codemode and Claude Code using the same prompt and model.',
    metadata: 'Pi and Claude Code · Anthropic Haiku 4.5 · Thinking off · 2 sessions',
    icon: 'compare_arrows',
  },
  workflow: {
    routeId: '1',
    commandId: 'dev.agentprof.Agentprof.OpenExample',
    title: 'Open workflow example',
    traceName: 'pi-workflow',
    description: 'Coding task with a primary agent, parallel implementation and test workers, and a reviewer.',
    metadata: 'Pi · Anthropic Opus 5 · High effort · 4 sessions',
    icon: 'smart_toy',
  },
} as const;

export function exampleForAgent(agent: RecordingAgent) {
  return EXAMPLES[agent === 'pi' ? 'comparison' : agent];
}
