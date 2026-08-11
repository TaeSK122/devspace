import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

export type AcpProvider = "cursor" | "copilot";

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
}

export class AcpRuntime implements LocalAgentRuntime {
  readonly provider: AcpProvider;
  private readonly child?: ChildProcessWithoutNullStreams;
  private readonly connection: AcpConnectionLike;
  private readonly capabilities: { resume: boolean; close: boolean };
  private readonly queues: Map<string, AcpSessionQueue>;
  private alive = true;
  private closed = false;

  constructor(options: AcpRuntimeOptions, connection: AcpConnectionLike) {
    this.provider = options.provider;
    this.child = options.child;
    this.connection = connection;
    this.capabilities = options.capabilities ?? { resume: false, close: false };
    this.queues = options.queues ?? new Map();
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

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (!this.isAlive()) throw new Error(`${this.provider} ACP runtime is not running.`);
    const sessionId = await this.openSession(input);
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
    if (!this.capabilities.close || !this.isAlive()) return;
    await this.connection.agent.request("session/close", { sessionId: providerSessionId });
    this.queues.delete(providerSessionId);
  }

  isAlive(): boolean {
    return this.alive && !this.closed && (!this.child || (this.child.exitCode === null && !this.child.killed));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.connection.close(new Error(`${this.provider} ACP runtime closed.`));
    if (this.child && !this.child.killed && this.child.exitCode === null) this.child.kill();
  }

  private async openSession(input: LocalAgentRunInput): Promise<string> {
    if (input.providerSessionId) {
      if (!this.capabilities.resume) {
        throw new Error(`${this.provider} ACP does not advertise session resume support.`);
      }
      const response = await this.connection.agent.request("session/resume", {
        sessionId: input.providerSessionId,
        cwd: input.workspace,
        mcpServers: [],
      });
      this.queues.set(input.providerSessionId, { values: [] });
      await this.configureSession(input.providerSessionId, input, response);
      return input.providerSessionId;
    }

    const response = await this.connection.agent.request("session/new", {
      cwd: input.workspace,
      mcpServers: [],
    });
    const sessionId = readString(response, "sessionId");
    if (!sessionId) throw new Error(`${this.provider} ACP did not return a session id.`);
    this.queues.set(sessionId, { values: [] });
    await this.configureSession(sessionId, input, response);
    return sessionId;
  }

  private async configureSession(
    sessionId: string,
    input: LocalAgentRunInput,
    response?: unknown,
  ): Promise<void> {
    if (input.model) {
      const config = resolveAcpModelConfigUpdate(response, input.model, this.provider, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
    if (input.thinking) {
      const config = resolveAcpThinkingConfigUpdate(response, input.thinking, this.provider, sessionId);
      await this.connection.agent.request("session/set_config_option", config);
    }
  }
}

export class AcpLocalAgentDriver implements LocalAgentDriver {
  readonly provider: AcpProvider;
  readonly idleTimeoutMs = Number.POSITIVE_INFINITY;

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
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`${this.provider} ACP process did not expose stdio pipes.`);
    }

    let connection: AcpConnectionLike | undefined;
    try {
      const { client, methods, ndJsonStream } = await import("@agentclientprotocol/sdk");
      const queues = new Map<string, AcpSessionQueue>();
      const app = client({ name: "DevSpace" })
        .onRequest(methods.client.session.requestPermission, (context) => {
          const selected = selectAcpAllowPermissionOption(context.params.options);
          return selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } };
        })
        .onNotification(methods.client.session.update, (context) => {
          const sessionId = context.params.sessionId;
          const queue = queues.get(sessionId);
          if (queue) queue.values.push(context.params);
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
      }, connection);
    } catch (error) {
      try {
        connection?.close(error);
      } catch {
        // The child still needs to be terminated if the protocol failed early.
      }
      if (!child.killed && child.exitCode === null) child.kill();
      throw error;
    }
  }
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
  return options.find((option) => option.kind === "allow_once")
    ?? options.find((option) => option.kind === "allow_always");
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

function executableExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
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
