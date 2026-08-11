import assert from "node:assert/strict";
import {
  ClaudeLocalAgentDriver,
  type ClaudeQueryLike,
  type ClaudeUserMessage,
} from "./local-agent-claude.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

class FakeClaudeQuery implements ClaudeQueryLike, AsyncIterator<unknown> {
  private readonly iterator: AsyncIterator<ClaudeUserMessage>;
  closeCount = 0;
  model?: string;
  permissionModes: string[] = [];
  flagSettings: Array<Record<string, unknown>> = [];

  constructor(prompt: AsyncIterable<ClaudeUserMessage>) {
    this.iterator = prompt[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    const next = await this.iterator.next();
    if (next.done) return { done: true, value: undefined };
    return {
      done: false,
      value: {
        type: "result",
        session_id: "claude_session_1",
        result: `response:${next.value.message.content}`,
      },
    };
  }

  close(): void {
    this.closeCount += 1;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.permissionModes.push(mode);
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.flagSettings.push({ ...settings });
  }

  async setModel(model?: string): Promise<void> {
    this.model = model;
  }
}

const context: LocalAgentRuntimeContext = {
  agentId: "agt_claude",
  provider: "claude",
  workspace: "/tmp/project",
  model: "sonnet",
  thinking: "high",
  writeMode: "read_only",
};
let factoryCalls = 0;
let lastOptions: Record<string, unknown> | undefined;
let query: FakeClaudeQuery | undefined;
const driver = new ClaudeLocalAgentDriver(({ prompt, options }) => {
  factoryCalls += 1;
  lastOptions = options;
  query = new FakeClaudeQuery(prompt);
  return query;
}, { PATH: "/usr/bin" });

const runtime = await driver.createRuntime(context);
const sessionIds: string[] = [];
const first = await runtime.run({
  prompt: "first",
  workspace: "/tmp/project",
  model: "sonnet",
  thinking: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
const second = await runtime.run({
  prompt: "second",
  workspace: "/tmp/project",
  thinking: "low",
  writeMode: "allowed",
});
await runtime.run({
  prompt: "third",
  workspace: "/tmp/project",
  thinking: "high",
  writeMode: "full_access",
});
assert.equal(factoryCalls, 1, "successive turns reuse one Claude query");
assert.equal(first.providerSessionId, "claude_session_1");
assert.equal(second.finalResponse, "response:second");
assert.equal(query?.model, "sonnet");
assert.equal(lastOptions?.resume, undefined);
assert.equal(lastOptions?.permissionMode, "plan");
assert.equal(lastOptions?.allowDangerouslySkipPermissions, true);
assert.deepEqual(sessionIds, ["claude_session_1"]);
assert.deepEqual(query?.permissionModes, ["plan", "acceptEdits", "bypassPermissions"]);
assert.deepEqual(query?.flagSettings, [
  { alwaysThinkingEnabled: true, effortLevel: "high" },
  { alwaysThinkingEnabled: true, effortLevel: "low" },
  { alwaysThinkingEnabled: true, effortLevel: "high" },
]);

await runtime.close();
await runtime.close();
assert.equal(query?.closeCount, 1);

await driver.createRuntime({ ...context, providerSessionId: "cold_session" });
assert.equal(lastOptions?.resume, "cold_session");
