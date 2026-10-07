// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";

import {
  childPromptFlowId,
  describeChildLaunch,
  detectChildRole,
  extractChildSessionId,
  mergeExtensionPath,
  randomCorrelationId,
} from "./workflow.ts";

describe("pi-tracing workflow helpers", () => {
  test("rig_launch description keeps identifiers, drops bodies", () => {
    const info = describeChildLaunch("rig_launch", {
      namespace: "ns",
      root_id: "root-1",
      task_id: "task-7",
      mode: "spawn",
      expected_session_id: "019ffdb0-3e55-713c-a283-1373113797d5",
      confirmed: true,
    });
    expect(info.label).toBe("launch");
    expect(info.annotations["task_id"]).toBe("task-7");
    expect(info.annotations["expected_session"]).toBe("019ffdb0-3e55-713c-a283-1373113797d5");
    expect(typeof info.annotations["correlation"]).toBe("string");
  });

  test("subagent description records lengths, not task text", () => {
    const info = describeChildLaunch("subagent", { task: "do something secret", type: "code-search" });
    expect(info.label).toBe("delegate");
    expect(info.annotations["task_bytes"]).toBeGreaterThan(0);
    expect(JSON.stringify(info.annotations)).not.toContain("do something secret");
  });

  test('content-disabled child metadata and result linkage never serialize large arguments', () => {
    let inspected = 0;
    const args = {type: 'code-search', toJSON() {inspected++; throw new Error('serialized disabled args');},
      get task() {inspected++; throw new Error('inspected disabled task');}};
    const info = describeChildLaunch('subagent', args, false);
    expect(info.label).toBe('delegate');
    expect(info.annotations.subagent_type).toBe('code-search');
    expect(info.annotations.task_bytes).toBeUndefined();
    const id = '019ffdb0-3e55-713c-a283-1373113797d5';
    const result = {content: [{text: `Spawned detached Pi session ${id}`, toJSON() {
      inspected++; throw new Error('serialized disabled result');}}]};
    expect(extractChildSessionId('subagent', result, false)).toBe(id);
    expect(inspected).toBe(0);
  });

  test("extension path merge dedupes and preserves user entries", () => {
    expect(mergeExtensionPath(undefined, "/a/index.ts")).toBe("/a/index.ts");
    expect(mergeExtensionPath("", "/a/index.ts")).toBe("/a/index.ts");
    expect(mergeExtensionPath("/b/x.ts", "/a/index.ts")).toBe("/b/x.ts,/a/index.ts");
    expect(mergeExtensionPath("/a/index.ts,/b/x.ts", "/a/index.ts")).toBe("/a/index.ts,/b/x.ts");
    expect(mergeExtensionPath(" /b/x.ts ,, ", "/a/index.ts")).toBe("/b/x.ts,/a/index.ts");
  });

  test("correlation ids are unique hex", () => {
    const ids = new Set([randomCorrelationId(), randomCorrelationId(), randomCorrelationId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(/^[0-9a-f]{8}$/.test(id)).toBe(true);
  });

  test("child session extraction finds rig session uuid", () => {
    const id = extractChildSessionId("rig_launch", {
      content: [{ type: "text", text: "Spawned detached Pi session 019ffdb0-3e55-713c-a283-1373113797d5. Remote output monitored." }],
    });
    expect(id).toBe("019ffdb0-3e55-713c-a283-1373113797d5");
    expect(extractChildSessionId("rig_launch", { content: [] })).toBeNull();
  });

  test("rig worker role detection", () => {
    const role = detectChildRole({
      WORKFLOW_RIG_PROCESS: "worker",
      DEVMATE_PARENT_SESSION_ID: "019ffdb0-3e55-713c-a283-1373113797d5",
      WORKFLOW_RIG_OWNER_PID: "4242",
    });
    expect(role?.role).toBe("rig-worker");
    expect(role?.parentSession).toBe("019ffdb0-3e55-713c-a283-1373113797d5");
    expect(role?.ownerPid).toBe(4242);
  });

  test("subagent role detection ignores malformed parent", () => {
    const role = detectChildRole({
      PI_SUBAGENT_TYPE: "code-search",
      DEVMATE_PARENT_SESSION_ID: "not-a-uuid",
      PI_SUBAGENT_SESSION_KEY: "some-key",
    });
    expect(role?.role).toBe("subagent");
    expect(role?.parentSession).toBeUndefined();
    expect(role?.sessionKeyBytes).toBeGreaterThan(0);
  });

  test("plain orchestrator has no child role", () => {
    expect(detectChildRole({})).toBeNull();
    expect(detectChildRole({ WORKFLOW_RIG_PROCESS: "orchestrator" })).toBeNull();
  });
});


test('first-prompt IDs are deterministic, case insensitive, and reject missing identity', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  expect(childPromptFlowId(id)).toBe(childPromptFlowId(id.toUpperCase()));
  expect(childPromptFlowId(id)).not.toBe(0n);
  expect(childPromptFlowId(id)).not.toBe(childPromptFlowId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'));
  expect(childPromptFlowId('unknown')).toBeUndefined();
});
