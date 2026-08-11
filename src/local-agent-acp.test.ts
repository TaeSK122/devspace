import assert from "node:assert/strict";
import { AcpRuntime } from "./local-agent-acp.js";

const requests: string[] = [];
const queues = new Map<string, { values: unknown[] }>();
const connection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push(method);
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        const sessionId = "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return { sessionId };
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
const runtime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: true },
  queues,
}, connection);

const first = await runtime.run({ prompt: "first", workspace: "/tmp/project" });
const resumed = await runtime.run({
  prompt: "resumed",
  workspace: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
});
assert.equal(first.providerSessionId, "cursor_session_1");
assert.equal(resumed.finalResponse, "ACP response");
assert.deepEqual(requests.filter((method) => method === "session/new"), ["session/new"]);
assert.deepEqual(requests.filter((method) => method === "session/resume"), ["session/resume"]);

await runtime.releaseSession("cursor_session_1");
assert.equal(runtime.isAlive(), true);
await runtime.close();
await runtime.close();
assert.equal(runtime.isAlive(), false);
