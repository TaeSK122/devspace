import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { terminateProcessTree } from "./process-platform.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

export type AcpProvider = "cursor" | "copilot";

const MAX_ACP_QUEUE_ITEMS = 10_000;
const MAX_ACP_STDERR_BYTES = 32 * 1024;

const ACP_COMMANDS: Record<AcpProvider, [string, ...string[]]> = {
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp"],
};

interface AcpConnectionLike {
  agent: {
    request(method: string, params?: unknown): Promise<unknown>;
  };
  close(error?: unknown): void;
  closed: Promise<void>;
}

interface AcpSessionQueue {
  values: unknown[];
}

export interface AcpRuntimeOptions {
  provider: AcpProvider;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child?: ChildProcessWithoutNullStreams;
  capabilities?: { resume: boolean; close: boolean };
  queues?: Map<string, AcpSessionQueue>;
  liveSessions?: Set<string>;
  sessionWriteModes?: Map<string, LocalAgentWriteMode>;
  sessionMetadata?: Map<string, unknown>;
}

export class AcpRuntime implements LocalAgentRuntime {
  readonly provider: AcpProvider;
  private readonly child?: ChildProcessWithoutNullStreams;
  private readonly connection: AcpConnectionLike;
  private readonly capabilities: { resume: boolean; close: boolean };
  private readonly queues: Map<string, AcpSessionQueue>;
  private readonly liveSessions: Set<string>;
  private readonly sessionWriteModes: Map<string, LocalAgentWriteMode>;
  private readonly sessionMetadata: Map<string, unknown>;
  private alive = true;
  private closed = false;

  constructor(options: AcpRuntimeOptions, connection: AcpConnectionLike) {
    this.provider = options.provider;
    this.child = options.child;
    this.connection = connection;
    this.capabilities = options.capabilities ?? { resume: false, close: false };
    this.queues = options.queues ?? new Map();
    this.liveSessions = options.liveSessions ?? new Set();
    this.sessionWriteModes = options.sessionWriteModes ?? new Map();
    this.sessionMetadata = options.sessionMetadata ?? new Map();
    void this.connection.closed.then(() => {
      if (!this.closed) this.alive = false;
    }).catch(() => {
      if (!this.closed) this.alive = false;
    });
    this.child?.once("exit", () => {
      this.alive = false;
      this.connection.close(new Error(`${this.provider} ACP process exited.`));
    });
    this.child?.once("error", (error) => {
      this.alive = false;
      this.connection.close(error);
    });
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult> {
    if (!this.isAlive()) throw new Error(`${this.provider} ACP runtime is not running.`);
    const sessionId = await this.openSession(input, callbacks);
    const queue = this.queues.get(sessionId) ?? { values: [] };
    this.queues.set(sessionId, queue);
    queue.values.length = 0;
    const response = await this.connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    });
    const updates = queue.values.splice(0);
    const finalResponse = extractAcpText(updates);
    if (!finalResponse) {
      const stopReason = readString(response, "stopReason");
      throw new Error(`${this.provider} ACP did not return a final assistant response${stopReason ? ` (${stopReason})` : ""}.`);
    }
    return {
      provider: this.provider,
      providerSessionId: sessionId,
      finalResponse,
      items: updates,
    };
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    this.queues.delete(providerSessionId);
    this.liveSessions.delete(providerSessionId);
    this.sessionWriteModes.delete(providerSessionId);
    this.sessionMetadata.delete(providerSessionId);
    if (!this.capabilities.close || !this.capabilities.resume || !this.isAlive()) return;
    await this.connection.agent.request("session/close", { sessionId: providerSessionId });
  }

  isAlive(): boolean {
    return this.alive && !this.closed && (!this.child || (this.child.exitCode === null && !this.child.killed));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.queues.clear();
    this.liveSessions.clear();
    this.sessionWriteModes.clear();
    this.sessionMetadata.clear();
    this.connection.close(new Error(`${this.provider} ACP runtime closed.`));
    if (this.child && this.child.exitCode === null) {
      const detached = process.platform !== "win32";
      terminateProcessTree(this.child, "SIGTERM", detached);
      if (!await waitForProcessExit(this.child, 1_000)) {
        terminateProcessTree(this.child, "SIGKILL", detached);
      }
    }
  }

  private async openSession(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<string> {
    if (input.providerSessionId) {
      if (this.liveSessions.has(input.providerSessionId)) {
        this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
        await callbacks?.onSessionId?.(input.providerSessionId);
        await this.configureSession(
          input.providerSessionId,
          input,
          this.sessionMetadata.get(input.providerSessionId),
          false,
        );
        return input.providerSessionId;
      }
      if (!this.capabilities.resume) {
        throw new Error(`${this.provider} ACP does not advertise session resume support.`);
      }
      const response = await this.connection.agent.request("session/resume", {
        sessionId: input.providerSessionId,
        cwd: input.workspace,
        mcpServers: [],
      });
      this.cacheSessionMetadata(input.providerSessionId, response);
      this.queues.set(input.providerSessionId, { values: [] });
      this.liveSessions.add(input.providerSessionId);
      this.sessionWriteModes.set(input.providerSessionId, input.writeMode ?? "allowed");
      await callbacks?.onSessionId?.(input.providerSessionId);
      await this.configureSession(input.providerSessionId, input, response, false);
      return input.providerSessionId;
    }

    const response = await this.connection.agent.request("session/new", {
      cwd: input.workspace,
      mcpServers: [],
    });
    const sessionId = readString(response, "sessionId");
    if (!sessionId) throw new Error(`${this.provider} ACP did not return a session id.`);
    this.cacheSessionMetadata(sessionId, response);
    this.queues.set(sessionId, { values: [] });
    this.liveSessions.add(sessionId);
    this.sessionWriteModes.set(sessionId, input.writeMode ?? "allowed");
    await callbacks?.onSessionId?.(sessionId);
    await this.configureSession(sessionId, input, response, true);
    return sessionId;
  }

  private cacheSessionMetadata(sessionId: string, response: unknown): void {
    if (hasAcpConfigOptions(response)) this.sessionMetadata.set(sessionId, response);
  }

  private async configureSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response?: unknown,
    isNewSession = false,
  ): Promise<void> {
    const metadata = response ?? this.sessionMetadata.get(sessionId);
    const canConfigure = isNewSession || hasAcpConfigOptions(metadata);
    if (input.model) {
      if (canConfigure) {
        const config = resolveAcpModelConfigUpdate(metadata, input.model, this.provider, sessionId);
        await this.connection.agent.request("session/set_config_option", config);
      }
    }
    if (input.thinking) {
      if (canConfigure) {
        const config = resolveAcpThinkingConfigUpdate(metadata, input.thinking, this.provider, sessionId);
        await this.connection.agent.request("session/set_config_option", config);
      }
    }
  }
}

export class AcpLocalAgentDriver implements LocalAgentDriver {
  readonly provider: AcpProvider;
  // Keep ACP warm briefly, then let the generic pool close the process so the
  // daemon can reach its own idle shutdown state.
  readonly idleTimeoutMs = 5 * 60_000;

  constructor(
    provider: AcpProvider,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.provider = provider;
  }

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    const command = resolveAcpCommand(this.provider, this.env);
    return `acp:${this.provider}:${command ?? ACP_COMMANDS[this.provider][0]}`;
  }

  async createRuntime(_context: LocalAgentRuntimeContext): Promise<LocalAgentRuntime> {
    const command = resolveAcpCommand(this.provider, this.env);
    if (!command) throw new Error(`${this.provider} provider is not available: executable not found.`);
    const child = spawn(command, ACP_COMMANDS[this.provider].slice(1), {
      cwd: process.cwd(),
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: process.platform === "win32" && isWindowsShellCommand(command),
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`${this.provider} ACP process did not expose stdio pipes.`);
    }

    let connection: AcpConnectionLike | undefined;
    child.stderr.setEncoding("utf8");
    let stderrTail = "";
    child.stderr.on("data", (chunk: string) => {
      stderrTail = appendTail(stderrTail, chunk, MAX_ACP_STDERR_BYTES);
    });
    try {
      const { client, methods, ndJsonStream } = await import("@agentclientprotocol/sdk");
      const queues = new Map<string, AcpSessionQueue>();
      const sessionWriteModes = new Map<string, LocalAgentWriteMode>();
      const app = client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const writeMode = queuesWriteMode(context.params.sessionId, sessionWriteModes);
          const selected = selectAcpPermissionOption(context.params.options, writeMode);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .onNotification(methods.client.session.update, (context) => {
          const sessionId = context.params.sessionId;
          const queue = queues.get(sessionId);
          if (queue) appendAcpQueueValue(queue, context.params);
        });
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      connection = app.connect(stream) as unknown as AcpConnectionLike;
      const init = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: "DevSpace", version: "1.0.7" },
        clientCapabilities: {},
      });
      const capabilities = readAcpCapabilities(init);
      return new AcpRuntime({
        provider: this.provider,
        command,
        args: ACP_COMMANDS[this.provider].slice(1),
        env: this.env,
        child,
        capabilities,
        queues,
        sessionWriteModes,
      }, connection);
    } catch (error) {
      try {
        connection?.close(error);
      } catch {
        // The child still needs to be terminated if the protocol failed early.
      }
      if (child.exitCode === null) {
        const detached = process.platform !== "win32";
        terminateProcessTree(child, "SIGTERM", detached);
        if (!await waitForProcessExit(child, 1_000)) {
          terminateProcessTree(child, "SIGKILL", detached);
        }
      }
      if (stderrTail.trim() && error instanceof Error && !error.message.includes(stderrTail.trim())) {
        throw new Error(`${error.message}\n${stderrTail.trim()}`, { cause: error });
      }
      throw error;
    }
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export function resolveAcpCommand(
  provider: AcpProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = provider === "cursor" ? env.CURSOR_COMMAND : env.COPILOT_COMMAND;
  const command = configured ?? ACP_COMMANDS[provider][0];
  if (command.includes("/") || command.includes("\\")) return executableExists(command, env) ? command : undefined;
  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (executableExists(candidate, env)) return candidate;
    }
  }
  return undefined;
}

export function resolveAcpModelConfigUpdate(
  session: unknown,
  model: string,
  provider: string,
  sessionIdOverride?: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "model",
    label: "model",
    provider,
    value: model,
    sessionIdOverride,
  });
}

export function resolveAcpThinkingConfigUpdate(
  session: unknown,
  thinking: string,
  provider: string,
  sessionIdOverride?: string,
): { sessionId: string; configId: string; value: string } {
  return resolveAcpSelectConfigUpdate(session, {
    category: "thought_level",
    label: "thinking option",
    provider,
    value: thinking,
    sessionIdOverride,
  });
}

function resolveAcpSelectConfigUpdate(
  session: unknown,
  options: {
    category: string;
    label: string;
    provider: string;
    value: string;
    sessionIdOverride?: string;
  },
): { sessionId: string; configId: string; value: string } {
  const record = asRecord(session);
  if (!record) throw new Error(`${options.provider} ACP session metadata is missing.`);
  const sessionId = options.sessionIdOverride ?? directString(record?.sessionId);
  if (!sessionId) throw new Error(`${options.provider} ACP session did not return a session id.`);
  const response = asRecord(record?.newSessionResponse) ?? record;
  const configOptions = readArray(response, "configOptions") ?? [];
  const config = configOptions
    .map(asRecord)
    .find((option) => option?.type === "select" && option.category === options.category);
  if (!config) throw new Error(`${options.provider} ACP server does not expose a ${options.label}.`);
  const configId = directString(config.id);
  if (!configId) throw new Error(`${options.provider} ACP ${options.label} is missing an id.`);
  const available = flattenAcpSelectValues(config);
  if (!available.includes(options.value)) {
    const suffix = available.length > 0 ? ` Available values: ${available.join(", ")}.` : "";
    throw new Error(`${options.provider} ACP ${options.label} does not support '${options.value}'.${suffix}`);
  }
  return { sessionId, configId, value: options.value };
}

export function flattenAcpSelectValues(option: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const item of readArray(option, "options") ?? []) {
    const record = asRecord(item);
    const value = directString(record?.value);
    if (value) {
      values.push(value);
      continue;
    }
    for (const nested of readArray(record, "options") ?? []) {
      const nestedValue = directString(asRecord(nested)?.value);
      if (nestedValue) values.push(nestedValue);
    }
  }
  return values;
}

export function selectAcpAllowPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
): { optionId: string } | undefined {
  return selectAcpPermissionOption(options, "allowed");
}

export function selectAcpPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
  writeMode: LocalAgentWriteMode | undefined,
): { optionId: string } | undefined {
  const selected = writeMode === "read_only"
    ? options.find((option) => option.kind === "reject_once")
      ?? options.find((option) => option.kind === "reject_always")
    : options.find((option) => option.kind === "allow_once")
      ?? options.find((option) => option.kind === "allow_always");
  return selected ? { optionId: selected.optionId } : undefined;
}

function queuesWriteMode(
  sessionId: string,
  sessionWriteModes: Map<string, LocalAgentWriteMode>,
): LocalAgentWriteMode {
  return sessionWriteModes.get(sessionId) ?? "allowed";
}

function readAcpCapabilities(value: unknown): { resume: boolean; close: boolean } {
  const capabilities = asRecord(asRecord(value)?.agentCapabilities);
  const sessions = asRecord(capabilities?.sessionCapabilities);
  return {
    resume: Boolean(sessions?.resume),
    close: Boolean(sessions?.close),
  };
}

function extractAcpText(updates: unknown[]): string {
  return updates
    .map((value) => {
      const update = asRecord(asRecord(value)?.update);
      const content = asRecord(update?.content);
      return update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string"
        ? content.text
        : "";
    })
    .join("")
    .trim();
}

function hasAcpConfigOptions(value: unknown): boolean {
  const record = asRecord(value);
  const response = asRecord(record?.newSessionResponse) ?? record;
  return Array.isArray(response?.configOptions);
}

function appendAcpQueueValue(queue: AcpSessionQueue, value: unknown): void {
  if (queue.values.length >= MAX_ACP_QUEUE_ITEMS) queue.values.shift();
  queue.values.push(value);
}

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return Buffer.from(next, "utf8").subarray(-maxBytes).toString("utf8");
}

function isWindowsShellCommand(command: string): boolean {
  return /\.(?:bat|cmd)$/i.test(command);
}

function executableExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
    shell: process.platform === "win32" && isWindowsShellCommand(command),
    windowsHide: true,
    timeout: 5_000,
  });
  const code = result.error && "code" in result.error ? result.error.code : undefined;
  return code !== "ENOENT" && !result.error;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
