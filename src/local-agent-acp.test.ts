import assert from "node:assert/strict";
import {
  AcpRuntime,
  selectAcpPermissionOption,
} from "./local-agent-acp.js";

const requests: Array<{ method: string; params?: unknown }> = [];
const queues = new Map<string, { values: unknown[] }>();
const connection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        const sessionId = "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return {
          sessionId,
          configOptions: [
            { type: "select", category: "model", id: "model", options: [{ value: "model-a" }] },
            { type: "select", category: "thought_level", id: "thinking", options: [{ value: "high" }] },
          ],
        };
      }
      if (method === "session/resume") {
        const sessionId = input?.sessionId ?? "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return { sessionId };
      }
      if (method === "session/prompt") {
        const queue = queues.get(input?.sessionId ?? "");
        queue?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};

const sessionIds: string[] = [];
const runtime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: true },
  queues,
}, connection);

const first = await runtime.run({
  prompt: "first",
  workspace: "/tmp/project",
  model: "model-a",
  thinking: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
const warm = await runtime.run({
  prompt: "warm",
  workspace: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-a",
  thinking: "high",
  writeMode: "full_access",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});

assert.equal(first.providerSessionId, "cursor_session_1");
assert.equal(warm.finalResponse, "ACP response");
assert.deepEqual(sessionIds, ["cursor_session_1", "cursor_session_1"]);
assert.equal(requests.filter(({ method }) => method === "session/new").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 0);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);

await runtime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);
assert.equal(runtime.isAlive(), true);

const resumedRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: false },
  queues,
}, connection);
const resumed = await resumedRuntime.run({
  prompt: "resumed",
  workspace: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-that-is-not-advertised-after-resume",
});
assert.equal(resumed.finalResponse, "ACP response");
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
await resumedRuntime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);

assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed"),
  { optionId: "allow" },
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "read_only"),
  { optionId: "reject" },
);

await resumedRuntime.close();
await resumedRuntime.close();
assert.equal(resumedRuntime.isAlive(), false);
