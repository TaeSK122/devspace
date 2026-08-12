import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentConflictError, LocalAgentManager } from "./local-agent-manager.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-manager-test-"));
const stateDir = join(root, "state");
const profile: LocalAgentProfile = {
  name: "reviewer",
  description: "Test reviewer",
  provider: "codex",
  filePath: join(root, "reviewer.md"),
  body: "Review only.",
  disabled: false,
};

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  readonly inputs: LocalAgentRunInput[] = [];
  closed = false;
  private releaseHold: (() => void) | undefined;

  async run(input: LocalAgentRunInput, callbacks?: { onSessionId?: (id: string) => void | Promise<void> }): Promise<LocalAgentRunResult> {
    this.inputs.push(input);
    if (input.prompt.includes("early-fail")) {
      await callbacks?.onSessionId?.("thread_early");
      throw new Error("provider failed after session creation");
    }
    if (input.prompt.includes("fail")) throw new Error("provider failed");
    if (input.prompt.includes("hold")) {
      await new Promise<void>((resolve) => { this.releaseHold = resolve; });
    }
    return {
      provider: this.provider,
      providerSessionId: "thread_test",
      finalResponse: `response:${input.prompt}`,
      items: [],
    };
  }

  release(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release();
  }
}

const runtimes = new Map<string, FakeRuntime>();
const driver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new FakeRuntime();
    runtimes.set(context.agentId, runtime);
    return runtime;
  },
};

const store = new LocalAgentStore(stateDir);
const stale = store.create({
  workspaceRoot: root,
  profileName: "reviewer",
  provider: "codex",
});
store.update(stale.id, { status: "running", latestResponse: "previous response" });

const manager = new LocalAgentManager({
  store,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile],
  allowedRoots: [root],
});

await assert.rejects(
  manager.start({ target: "reviewer", prompt: "outside", workspaceRoot: join(tmpdir(), "outside") }),
  /outside allowed roots/,
);

assert.equal(manager.get(stale.id)?.status, "running");
assert.throws(
  () => manager.list(),
  /workspace scope is required/,
);
assert.throws(
  () => manager.get(stale.id, { workspaceId: "ws_current", workspaceRoot: root }),
  /different workspace/,
  "legacy root-only agents must not be controlled with an unrelated workspace id",
);
manager.reconcileActiveRuns();
assert.equal(manager.get(stale.id)?.status, "error");
assert.equal(manager.get(stale.id)?.latestResponse, "previous response");
assert.equal(
  manager.get(stale.id)?.error,
  "DevSpace restarted while this agent turn was running.",
);

const first = await manager.start({
  target: "reviewer",
  prompt: "hold",
  workspaceRoot: root,
});
assert.equal(first.status, "running");
await waitFor(() => runtimes.get(first.id)?.inputs.length === 1);
await assert.rejects(
  () => manager.continue(first.id, "another prompt"),
  (error: unknown) => error instanceof LocalAgentConflictError && error.agentId === first.id,
);

runtimes.get(first.id)!.release();
await waitFor(() => manager.get(first.id)?.status === "idle");
assert.equal(manager.get(first.id)?.providerSessionId, "thread_test");
assert.match(manager.get(first.id)?.latestResponse ?? "", /Task:\nhold/);

const continued = await manager.continue(first.id, "continue");
assert.equal(continued.status, "running");
await waitFor(() => manager.get(first.id)?.status === "idle");

const second = await manager.start({
  target: "reviewer",
  prompt: "second agent",
  workspaceRoot: root,
});
await waitFor(() => manager.get(second.id)?.status === "idle");
assert.notEqual(first.id, second.id);
assert.equal(runtimes.size, 2, "different agents receive independent logical runtimes");

const failed = await manager.start({
  target: "reviewer",
  prompt: "fail",
  workspaceRoot: root,
});
await waitFor(() => manager.get(failed.id)?.status === "error");
assert.equal(manager.get(failed.id)?.error, "provider failed");

const earlyFailure = await manager.start({
  target: "reviewer",
  prompt: "early-fail",
  workspaceRoot: root,
});
await waitFor(() => manager.get(earlyFailure.id)?.status === "error");
assert.equal(manager.get(earlyFailure.id)?.providerSessionId, "thread_early");

await assert.rejects(
  () => manager.continue(first.id, "wrong workspace", {}, { workspaceRoot: join(root, "other") }),
  /different workspace/,
);

const shuttingDown = await manager.start({
  target: "reviewer",
  prompt: "hold during shutdown",
  workspaceRoot: root,
});
await waitFor(() => runtimes.get(shuttingDown.id)?.inputs.length === 1);
const closing = manager.close();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(runtimes.get(shuttingDown.id)?.closed, true);
await closing;

await manager.close();
await rm(root, { recursive: true, force: true });

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
