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
const first = await runtime.run({
  prompt: "first",
  workspace: "/tmp/project",
  model: "sonnet",
  thinking: "high",
});
const second = await runtime.run({
  prompt: "second",
  workspace: "/tmp/project",
});
assert.equal(factoryCalls, 1, "successive turns reuse one Claude query");
assert.equal(first.providerSessionId, "claude_session_1");
assert.equal(second.finalResponse, "response:second");
assert.equal(query?.model, "sonnet");
assert.equal(lastOptions?.resume, undefined);

await runtime.close();
await runtime.close();
assert.equal(query?.closeCount, 1);

await driver.createRuntime({ ...context, providerSessionId: "cold_session" });
assert.equal(lastOptions?.resume, "cold_session");
