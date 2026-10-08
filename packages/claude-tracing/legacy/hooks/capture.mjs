// SPDX-License-Identifier: Apache-2.0
// Observational hook: never return context, permissions, or model instructions.
if (process.env.AGENTPROF_CAPTURE_ENDPOINT) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const event = {};
    for (const key of ['session_id', 'prompt_id', 'hook_event_name', 'agent_id', 'agent_type', 'tool_use_id',
      'tool_name', 'tool_input', 'prompt', 'source', 'reason', 'trigger', 'error', 'model']) {
      if (input[key] !== undefined && (!['prompt', 'tool_input'].includes(key) || !['0', 'false'].includes(String(process.env.AGENTPROF_CAPTURE_CONTENTS).toLowerCase()))) event[key] = input[key];
    }
    if (typeof input.prompt === 'string') event.prompt_length = input.prompt.length;
    await fetch(`${process.env.AGENTPROF_CAPTURE_ENDPOINT}/hook`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AGENTPROF_CAPTURE_TOKEN}`},
      body: JSON.stringify({timestamp: String(BigInt(Date.now()) * 1_000_000n), event}),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Capture failure must not change the agent's tool execution or response.
  }
}
