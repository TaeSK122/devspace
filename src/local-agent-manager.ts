import {
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentListScope,
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { assertAllowedPath } from "./roots.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
}

export interface RunOverrides {
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  logger?: LocalAgentManagerLogger;
}

export class LocalAgentConflictError extends Error {
  readonly code = "CONFLICT" as const;

  constructor(readonly agentId: string) {
    super(`Agent ${agentId} already has a running turn.`);
    this.name = "LocalAgentConflictError";
  }
}

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly logger?: LocalAgentManagerLogger;
  private readonly activeTurns = new Map<string, Promise<void>>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.logger = options.logger;
  }

  reconcileActiveRuns(message?: string): number {
    return this.store.reconcileActiveRuns(message);
  }

  async start(input: StartLocalAgentInput): Promise<LocalAgentRecord> {
    this.assertAccepting();
    const workspaceRoot = this.authorizeWorkspace(input.workspaceRoot);
    const profiles = await this.loadProfiles(workspaceRoot);
    const target = resolveLocalAgentTarget(input.target, profiles, input.model, input.thinking);
    if (!target) {
      throw new Error(`Unknown subagent profile or provider: ${input.target}`);
    }
    this.assertDriver(target.provider);

    const record = this.store.create({
      workspaceId: input.workspaceId,
      workspaceRoot,
      profileName: target.name,
      provider: target.provider,
      model: target.model,
      thinking: target.thinking,
    });
    return this.begin(record, input.prompt, {
      model: target.model,
      thinking: target.thinking,
      writeMode: input.writeMode,
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope?: LocalAgentWorkspaceScope,
  ): Promise<LocalAgentRecord> {
    this.assertAccepting();
    const record = this.store.getById(agentId);
    if (!record) throw new Error(`Unknown subagent id: ${agentId}`);
    if (scope) this.assertAgentWorkspace(record, scope);
    this.assertDriver(record.provider);
    return this.begin(record, prompt, overrides);
  }

  get(agentId: string, scope?: LocalAgentWorkspaceScope): LocalAgentRecord | undefined {
    const record = this.store.getById(agentId);
    if (record && scope) this.assertAgentWorkspace(record, scope);
    return record;
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    return this.store.list(scope.workspaceRoot
      ? { ...scope, workspaceRoot: this.authorizeWorkspace(scope.workspaceRoot) }
      : scope);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    const turns = Array.from(this.activeTurns.values());
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
  ): LocalAgentRecord {
    if (this.activeTurns.has(record.id)) {
      throw new LocalAgentConflictError(record.id);
    }

    const updated = this.store.update(record.id, {
      status: "running",
      model: overrides.model ?? record.model,
      thinking: overrides.thinking ?? record.thinking,
      latestResponse: undefined,
      error: undefined,
    });
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const turn = Promise.resolve().then(() => this.runTurn(updated, prompt, overrides));
    this.activeTurns.set(record.id, turn);
    void turn.catch(() => undefined);
    return updated;
  }

  private async runTurn(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const profiles = await this.loadProfiles(record.workspaceRoot);
      const profile = profiles.find((candidate) => candidate.name === record.profileName);
      const input = this.buildRunInput(record, profile, prompt, overrides);
      const driver = this.assertDriver(record.provider);
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.provider,
        workspaceRoot: record.workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.writeMode,
        model: input.model,
        thinking: input.thinking,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        onSessionId: (providerSessionId) => {
          const current = this.store.getById(record.id);
          if (!current || current.providerSessionId === providerSessionId) return;
          this.store.update(record.id, { providerSessionId });
        },
      };
      const result = await this.pool.run(driver, context, input, callbacks);
      const current = this.store.getById(record.id);
      if (!current) return;
      const updated = this.store.update(record.id, {
        providerSessionId: result.providerSessionId ?? current.providerSessionId,
        status: "idle",
        latestResponse: result.finalResponse,
        error: undefined,
      });
      this.log("info", "agent_run_completed", {
        provider: updated.provider,
        agentId: updated.id,
        providerSessionIdPrefix: updated.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      const current = this.store.getById(record.id);
      if (current) {
        this.store.update(record.id, {
          status: "error",
          error: errorMessage(error),
        });
      }
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: errorMessage(error),
      });
      throw error;
    } finally {
      this.activeTurns.delete(record.id);
    }
  }

  private buildRunInput(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): LocalAgentRunInput {
    const isRawProvider = record.profileName === record.provider;
    if (!profile && !isRawProvider) {
      throw new Error(`Subagent profile not found: ${record.profileName}`);
    }
    const body = profile?.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    return {
      prompt: fullPrompt,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: overrides.writeMode ?? "allowed",
      model: record.model ?? profile?.model,
      thinking: record.thinking ?? profile?.thinking,
    };
  }

  private assertDriver(provider: string): LocalAgentDriver {
    if (!isLocalAgentProvider(provider)) {
      throw new Error(`No local agent driver is configured for provider: ${provider}`);
    }
    const driver = this.drivers.get(provider);
    if (!driver) throw new Error(`No local agent driver is configured for provider: ${provider}`);
    return driver;
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error("Local agent manager is closed.");
  }

  private authorizeWorkspace(workspaceRoot: string): string {
    if (!this.allowedRoots) return workspaceRoot;
    return assertAllowedPath(workspaceRoot, [...this.allowedRoots]);
  }

  private assertAgentWorkspace(record: LocalAgentRecord, scope: LocalAgentWorkspaceScope): void {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot);
    if (workspaceRoot !== record.workspaceRoot) {
      throw new Error(`Subagent ${record.id} belongs to a different workspace.`);
    }
    if (record.workspaceId && record.workspaceId !== scope.workspaceId) {
      throw new Error(`Subagent ${record.id} belongs to a different workspace.`);
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
