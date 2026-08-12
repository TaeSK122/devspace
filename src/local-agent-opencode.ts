import type {
  ModelRef,
  OpencodeClient,
  PromptInput,
  PermissionConfig,
  SessionMessagesResponse,
  SessionV2Info,
} from "@opencode-ai/sdk/v2";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

export type OpencodeClientLike = Pick<OpencodeClient, "v2">;

export interface OpencodeServerLike {
  close(): void;
}

export type OpencodeFactory = (context?: LocalAgentRuntimeContext) => Promise<{
  client: OpencodeClientLike;
  server: OpencodeServerLike;
}>;

export class OpencodeRuntime implements LocalAgentRuntime {
  readonly provider = "opencode" as const;
  private alive = true;
  private closed = false;

  constructor(
    private readonly client: OpencodeClientLike,
    private readonly server: OpencodeServerLike,
  ) {}

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks): Promise<LocalAgentRunResult> {
    if (!this.alive) throw new Error("OpenCode runtime is not running.");
    try {
      await assertOpencodeHealthy(this.client);
      const resumed = Boolean(input.providerSessionId);
      const initialModel = input.model ? parseOpencodeModel(input.model, input.thinking) : undefined;
      const sessionId = input.providerSessionId ?? await createOpencodeSession(this.client, input, initialModel);
      await callbacks?.onSessionId?.(sessionId);
      await this.client.v2.session.switchAgent({
        sessionID: sessionId,
        agent: opencodeAgentFor(input.writeMode),
      }, { throwOnError: true });

      const model = initialModel ?? (input.thinking ? await modelWithThinking(this.client, sessionId, input.thinking) : undefined);
      if (model && (resumed || !initialModel)) {
        await this.client.v2.session.switchModel({ sessionID: sessionId, model }, { throwOnError: true });
      }
      const promptResult = await promptOpencodeSession(this.client, sessionId, input);
      await waitForOpencodeSession(this.client, sessionId);
      const messages = await readOpencodeMessages(this.client, sessionId);
      const finalResponse = requireFinalResponse(
        extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
      );
      return {
        provider: this.provider,
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult, messages],
      };
    } catch (error) {
      if (isOpenCodeTransportFailure(error)) this.alive = false;
      throw error;
    }
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // OpenCode keeps durable sessions independently of this process.
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.server.close();
  }
}

export class OpencodeLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "opencode" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  constructor(private readonly factory: OpencodeFactory = defaultOpencodeFactory) {}

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    return "opencode:default";
  }

  async createRuntime(_context: LocalAgentRuntimeContext): Promise<LocalAgentRuntime> {
    const { client, server } = await this.factory(_context);
    return new OpencodeRuntime(client, server);
  }
}

async function defaultOpencodeFactory(): Promise<{ client: OpencodeClientLike; server: OpencodeServerLike }> {
  const { createOpencode } = await import("@opencode-ai/sdk/v2");
  return createOpencode({ config: {
    agent: {
      devspace_read_only: { permission: opencodePermissionFor("read_only") },
      devspace_allowed: { permission: opencodePermissionFor("allowed") },
      devspace_full_access: { permission: opencodePermissionFor("full_access") },
    },
  } });
}

async function createOpencodeSession(
  client: OpencodeClientLike,
  input: LocalAgentRunInput,
  model?: ModelRef,
): Promise<string> {
  const result = await client.v2.session.create({
    location: { directory: input.workspace },
    agent: opencodeAgentFor(input.writeMode),
    ...(model ? { model } : {}),
  }, { throwOnError: true });
  return requireSessionId(result.data.data);
}

export function opencodeAgentFor(writeMode: LocalAgentRunInput["writeMode"]): string {
  switch (writeMode) {
    case "read_only": return "devspace_read_only";
    case "full_access": return "devspace_full_access";
    case "allowed":
    case undefined: return "devspace_allowed";
  }
}

export function opencodePermissionFor(writeMode: LocalAgentRunInput["writeMode"]): PermissionConfig {
  const allowed = writeMode !== "read_only";
  const unrestricted = writeMode === "full_access";
  return {
    read: "allow",
    edit: allowed ? "allow" : "deny",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: allowed ? "allow" : "deny",
    external_directory: unrestricted ? "allow" : "deny",
  };
}

async function assertOpencodeHealthy(client: OpencodeClientLike): Promise<void> {
  const health = client.v2.health;
  if (!health) return;
  try {
    await health.get({ throwOnError: true });
  } catch (error) {
    throw new OpencodeHealthError(errorMessage(error));
  }
}

function isOpenCodeTransportFailure(error: unknown): boolean {
  if (error instanceof OpencodeHealthError) return true;
  if (!(error instanceof Error)) return true;
  const message = error.message.toLowerCase();
  return message.includes("fetch") || message.includes("econn") || message.includes("socket") || message.includes("health") || message.includes("network") || message.includes("server");
}

class OpencodeHealthError extends Error {
  constructor(message: string) {
    super(`OpenCode server health check failed: ${message}`);
    this.name = "OpencodeHealthError";
  }
}

async function modelWithThinking(
  client: OpencodeClientLike,
  sessionId: string,
  thinking: string,
): Promise<ModelRef> {
  const result = await client.v2.session.get({ sessionID: sessionId }, { throwOnError: true });
  const model = result.data.data.model;
  if (!model) throw new Error("OpenCode did not return the current session model for a thinking override.");
  return { ...model, variant: thinking };
}

async function promptOpencodeSession(
  client: OpencodeClientLike,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  const prompt: PromptInput = { text: input.prompt };
  return client.v2.session.prompt({
    sessionID: sessionId,
    prompt,
  }, { throwOnError: true });
}

async function waitForOpencodeSession(client: OpencodeClientLike, sessionId: string): Promise<void> {
  await client.v2.session.wait({ sessionID: sessionId }, { throwOnError: true });
}

async function readOpencodeMessages(
  client: OpencodeClientLike,
  sessionId: string,
): Promise<SessionMessagesResponse> {
  const result = await client.v2.session.messages({ sessionID: sessionId, order: "asc", limit: 100 }, { throwOnError: true });
  return result.data;
}

function parseOpencodeModel(model: string, variant?: string): ModelRef {
  const separator = model.indexOf("/");
  const reference = separator === -1
    ? { providerID: "opencode", id: model }
    : { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
  return variant ? { ...reference, variant } : reference;
}

function requireSessionId(session: SessionV2Info): string {
  if (!session.id) throw new Error("OpenCode did not return a session id.");
  return session.id;
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";
  for (const key of ["content", "parts"] as const) {
    const parts = readArray(message, key);
    if (!parts) continue;
    const text = parts
      .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }
  const info = asRecord(message.info) ?? message;
  return stringifyStructuredMessage(info.structured);
}

function stringifyStructuredMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function unwrapProviderPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const record = asRecord(current);
    if (!record) return current;
    if (record.data !== undefined) {
      current = record.data;
      continue;
    }
    if (record.result !== undefined) {
      current = record.result;
      continue;
    }
    return current;
  }
  return current;
}

function readArray(value: unknown, key: string): unknown[] | undefined {
  const result = asRecord(value)?.[key];
  return Array.isArray(result) ? result : undefined;
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)?.[key];
  return typeof current === "string" ? current : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireFinalResponse(response: string): string {
  const trimmed = response.trim();
  if (!trimmed) throw new Error("OpenCode did not return a final assistant response.");
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
