import assert from "node:assert/strict";
import {
  PiLocalAgentDriver,
  piToolsForWriteMode,
  type PiSessionFactory,
  type PiSessionLike,
} from "./local-agent-pi.js";
import { createPiSandboxConfig } from "./local-agent-pi-sandbox.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentRuntimeContext } from "./local-agent-runtime.js";

class FakePiSession implements PiSessionLike {
  readonly sessionId = "pi_session_1";
  readonly state = { messages: [] as unknown[] };
  readonly modelRegistry = { find: () => ({ id: "model" }) };
  private readonly listeners = new Set<(event: unknown) => void>();
  disposeCount = 0;
  model?: unknown;
  thinking?: unknown;
  activeTools: string[] = [];
  toolHistory: string[][] = [];

  async prompt(text: string): Promise<void> {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: `response:${text}` }],
    };
    this.state.messages.push(message);
    for (const listener of this.listeners) listener({ type: "agent_end" });
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setModel(model: unknown): Promise<void> {
    this.model = model;
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
    this.toolHistory.push([...toolNames]);
  }

  setThinkingLevel(level: unknown): void {
    this.thinking = level;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

const contexts: LocalAgentRuntimeContext[] = [];
const sessions: FakePiSession[] = [];
const factory: PiSessionFactory = async (context) => {
  contexts.push(context);
  const session = new FakePiSession();
  sessions.push(session);
  return session;
};
const driver = new PiLocalAgentDriver(factory);
const pool = new LocalAgentRuntimePool();
const context: LocalAgentRuntimeContext = {
  agentId: "agt_pi",
  provider: "pi",
  workspace: "/tmp/project",
};
const sessionIds: string[] = [];

const first = await pool.run(driver, context, {
  prompt: "first",
  workspace: "/tmp/project",
  model: "provider/model",
  thinking: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
const second = await pool.run(driver, context, {
  prompt: "second",
  workspace: "/tmp/project",
  writeMode: "allowed",
});
await pool.run(driver, context, {
  prompt: "third",
  workspace: "/tmp/project",
  writeMode: "full_access",
});
await pool.run(driver, context, {
  prompt: "fourth",
  workspace: "/tmp/project",
  writeMode: "read_only",
});
assert.equal(contexts.length, 1, "one warm Pi session serves successive turns");
assert.equal(first.providerSessionId, "pi_session_1");
assert.equal(second.finalResponse, "response:second");
assert.deepEqual(sessions[0]?.model, { id: "model" });
assert.equal(sessions[0]?.thinking, "high");
assert.deepEqual(sessionIds, ["pi_session_1"]);
assert.deepEqual(piToolsForWriteMode("allowed"), ["read", "grep", "find", "ls", "edit", "write", "bash"]);
assert.ok(createPiSandboxConfig().filesystem.denyRead.some((path) => path.endsWith("/.ssh")));
assert.deepEqual(sessions[0]?.activeTools, ["read", "grep", "find", "ls"]);
assert.deepEqual(sessions[0]?.toolHistory, [
  ["read", "grep", "find", "ls"],
  ["read", "grep", "find", "ls", "edit", "write", "bash"],
  ["read", "grep", "find", "ls", "edit", "write", "bash"],
  ["read", "grep", "find", "ls"],
]);

await pool.run(driver, { ...context, providerSessionId: "pi_session_1" }, {
  prompt: "fifth",
  workspace: "/tmp/project",
  providerSessionId: "pi_session_1",
  writeMode: "allowed",
});
assert.deepEqual(sessions[0]?.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);

await pool.evictIdle(Date.now() + 10 * 60_000);
assert.equal(sessions[0]?.disposeCount, 1, "idle eviction disposes the in-process session");

await pool.run(driver, { ...context, providerSessionId: "pi_session_1" }, {
  prompt: "resumed",
  workspace: "/tmp/project",
  providerSessionId: "pi_session_1",
});
assert.equal(contexts.length, 2, "cold continuation creates a new AgentSession");
assert.equal(contexts[1]?.providerSessionId, "pi_session_1");
assert.deepEqual(sessions[1]?.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
await pool.close();
