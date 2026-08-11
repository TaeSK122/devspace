import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

export interface OpencodeClientLike {
  session: {
    create(parameters?: unknown, options?: unknown): Promise<unknown>;
    switchModel?(parameters?: unknown, options?: unknown): Promise<unknown>;
    prompt(parameters?: unknown, options?: unknown): Promise<unknown>;
    wait?(parameters?: unknown, options?: unknown): Promise<unknown>;
    messages?(parameters?: unknown, options?: unknown): Promise<unknown>;
  };
}

export interface OpencodeServerLike {
  close(): void;
}

export type OpencodeFactory = () => Promise<{
  client: OpencodeClientLike;
  server: OpencodeServerLike;
}>;

export class OpencodeRuntime implements LocalAgentRuntime {
  readonly provider = "opencode" as const;
  private readonly models = new Map<string, OpencodeModelRef>();
  private alive = true;
  private closed = false;

  constructor(
    private readonly client: OpencodeClientLike,
    private readonly server: OpencodeServerLike,
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    if (!this.alive) throw new Error("OpenCode runtime is not running.");
    const model = input.model
      ? parseOpencodeModel(input.model, input.thinking)
      : input.thinking && input.providerSessionId
        ? updateOpencodeModelVariant(this.models.get(input.providerSessionId), input.thinking)
        : undefined;
    const sessionId = input.providerSessionId ?? await createOpencodeSession(this.client, input, model);
    if (model) {
      if (input.providerSessionId && this.client.session.switchModel) {
        await this.client.session.switchModel({ sessionID: sessionId, model }, { throwOnError: true });
      }
      this.models.set(sessionId, model);
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
    const { client, server } = await this.factory();
    return new OpencodeRuntime(client, server);
  }
}

async function defaultOpencodeFactory(): Promise<{
  client: OpencodeClientLike;
  server: OpencodeServerLike;
}> {
  const { createOpencode } = await import("@opencode-ai/sdk/v2");
  return createOpencode();
}

interface OpencodeModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

async function createOpencodeSession(
  client: OpencodeClientLike,
  input: LocalAgentRunInput,
  model?: OpencodeModelRef,
): Promise<string> {
  const result = await client.session.create({
    location: { directory: input.workspace },
    ...(model ? { model } : {}),
  }, { throwOnError: true });
  const id = readNestedString(result, ["id"])
    ?? readNestedString(result, ["data", "id"])
    ?? readNestedString(result, ["session", "id"])
    ?? readNestedString(result, ["data", "session", "id"]);
  if (!id) throw new Error("OpenCode did not return a session id.");
  return id;
}

async function promptOpencodeSession(
  client: OpencodeClientLike,
  sessionId: string,
  input: LocalAgentRunInput,
): Promise<unknown> {
  return client.session.prompt({
    sessionID: sessionId,
    prompt: { text: input.prompt },
  }, { throwOnError: true });
}

async function waitForOpencodeSession(client: OpencodeClientLike, sessionId: string): Promise<void> {
  if (!client.session.wait) return;
  await client.session.wait({ sessionID: sessionId }, { throwOnError: true });
}

async function readOpencodeMessages(client: OpencodeClientLike, sessionId: string): Promise<unknown> {
  if (!client.session.messages) return undefined;
  return client.session.messages({ sessionID: sessionId, order: "asc", limit: 100 }, { throwOnError: true });
}

function parseOpencodeModel(model: string, variant?: string): OpencodeModelRef {
  const separator = model.indexOf("/");
  const reference = separator === -1
    ? { providerID: "opencode", modelID: model }
    : { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
  return variant ? { ...reference, variant } : reference;
}

function updateOpencodeModelVariant(
  model: OpencodeModelRef | undefined,
  variant: string,
): OpencodeModelRef | undefined {
  return model ? { ...model, variant } : undefined;
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
  const record = asRecord(value);
  return record ? record.data ?? record.result ?? value : value;
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
