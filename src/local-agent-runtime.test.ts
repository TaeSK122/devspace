import assert from "node:assert/strict";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const context: LocalAgentRuntimeContext = {
  agentId: "agt_test",
  provider: "codex",
  workspaceRoot: "/tmp/project",
};
const input: LocalAgentRunInput = { prompt: "inspect", workspaceRoot: "/tmp/project" };

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  alive = true;
  closeCount = 0;
  runCount = 0;
  readonly releasedSessions: string[] = [];
  private readonly pending: Array<() => void> = [];
  releaseBlocked = false;
  releaseStarted = false;
  releaseInFlight = false;
  private releaseResolve?: () => void;

  releaseWait(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  finishSessionRelease(): void {
    this.releaseResolve?.();
    this.releaseResolve = undefined;
  }

  async run(runInput: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    assert.equal(this.releaseInFlight, false, "a session turn must not overlap session release");
    this.runCount += 1;
    if (runInput.prompt === "wait") await new Promise<void>((resolve) => this.pending.push(resolve));
    return {
      provider: this.provider,
      providerSessionId: "thread_1",
      finalResponse: `done:${runInput.prompt}`,
      items: [],
    };
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    this.releaseInFlight = true;
    this.releaseStarted = true;
    this.releasedSessions.push(providerSessionId);
    if (this.releaseBlocked) {
      await new Promise<void>((resolve) => { this.releaseResolve = resolve; });
    }
    this.releaseInFlight = false;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.alive = false;
    this.releaseWait();
  }
}

const runtime = new FakeRuntime();
let createCount = 0;
const driver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "shared",
  createRuntime: async () => {
    createCount += 1;
    await Promise.resolve();
    return runtime;
  },
};

const pool = new LocalAgentRuntimePool();
const [first, second] = await Promise.all([
  pool.run(driver, context, input),
  pool.run(driver, { ...context, agentId: "agt_other" }, { ...input, prompt: "second" }),
]);
assert.equal(createCount, 1, "runtime creation is single-flight per runtime key");
assert.equal(first.finalResponse, "done:inspect");
assert.equal(second.finalResponse, "done:second");
assert.equal(runtime.runCount, 2);

const running = pool.run(driver, context, { ...input, prompt: "wait", providerSessionId: "thread_1" });
await new Promise<void>((resolve) => setImmediate(resolve));
await pool.evictIdle(Date.now() + 10_000_000);
assert.equal(runtime.closeCount, 0, "active runtimes are not evicted");
runtime.releaseWait();
await running;

await pool.close();
await pool.close();
assert.equal(runtime.closeCount, 1, "runtime close is idempotent");
assert.deepEqual(runtime.releasedSessions, [], "shutdown closes the runtime without racing session release");
assert.equal(pool.size, 0);

let clock = 0;
const sessionRuntime = new FakeRuntime();
const sessionPool = new LocalAgentRuntimePool({
  now: () => clock,
  sessionIdleTimeoutMs: 10,
});
const sessionDriver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "session-runtime",
  createRuntime: async () => sessionRuntime,
};
await sessionPool.run(sessionDriver, context, input);
clock = 11;
sessionRuntime.releaseBlocked = true;
const releasing = sessionPool.evictIdle();
await waitFor(() => sessionRuntime.releaseStarted);
const reused = sessionPool.run(sessionDriver, context, { ...input, providerSessionId: "thread_1", prompt: "reuse" });
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(sessionRuntime.runCount, 1, "reuse waits for the in-flight session release");
sessionRuntime.finishSessionRelease();
await releasing;
await reused;
sessionRuntime.releaseBlocked = false;
assert.equal(sessionRuntime.releaseInFlight, false);
assert.deepEqual(sessionRuntime.releasedSessions, ["thread_1"]);
assert.equal(sessionPool.size, 1, "releasing an idle session does not close the runtime");
await sessionPool.close();

const shutdownReleaseRuntime = new FakeRuntime();
const shutdownReleasePool = new LocalAgentRuntimePool({
  now: () => clock,
  sessionIdleTimeoutMs: 10,
});
const shutdownReleaseDriver: LocalAgentDriver = {
  provider: "codex",
  idleTimeoutMs: Number.POSITIVE_INFINITY,
  runtimeKey: () => "shutdown-release-runtime",
  createRuntime: async () => shutdownReleaseRuntime,
};
await shutdownReleasePool.run(shutdownReleaseDriver, context, input);
shutdownReleaseRuntime.releaseBlocked = true;
const shutdownRelease = shutdownReleasePool.evictIdle(30);
await waitFor(() => shutdownReleaseRuntime.releaseStarted);
const shutdown = shutdownReleasePool.close();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(shutdownReleaseRuntime.closeCount, 0, "shutdown waits for an in-flight session release");
shutdownReleaseRuntime.finishSessionRelease();
await shutdownRelease;
await shutdown;
assert.equal(shutdownReleaseRuntime.closeCount, 1);

class CleanupFailureRuntime extends FakeRuntime {
  override async close(): Promise<void> {
    throw new Error("cleanup failed");
  }

  override async run(): Promise<LocalAgentRunResult> {
    this.alive = false;
    throw new Error("provider failed");
  }
}

const cleanupPool = new LocalAgentRuntimePool();
const cleanupRuntime = new CleanupFailureRuntime();
const cleanupDriver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: () => "cleanup-runtime",
  createRuntime: async () => cleanupRuntime,
};
await assert.rejects(
  cleanupPool.run(cleanupDriver, context, input),
  /provider failed/,
  "runtime cleanup must not replace the provider error",
);

let resolveCreation!: (runtime: LocalAgentRuntime) => void;
const creating = new Promise<LocalAgentRuntime>((resolve) => { resolveCreation = resolve; });
const raceRuntime = new FakeRuntime();
const racePool = new LocalAgentRuntimePool();
const raceDriver: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: () => "creation-race",
  createRuntime: async () => creating,
};
const pendingRun = racePool.run(raceDriver, context, input);
await new Promise<void>((resolve) => setImmediate(resolve));
const pendingClose = racePool.close();
resolveCreation(raceRuntime);
await pendingClose;
await assert.rejects(pendingRun, /closed/);
assert.equal(raceRuntime.closeCount, 1, "a runtime created during shutdown is closed");

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
