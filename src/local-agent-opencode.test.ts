import assert from "node:assert/strict";
import {
  OpencodeLocalAgentDriver,
  type OpencodeClientLike,
  type OpencodeFactory,
} from "./local-agent-opencode.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";

let sessionNumber = 0;
const createInputs: unknown[] = [];
const promptInputs: unknown[] = [];
const switchInputs: unknown[] = [];
const client = {
  v2: {
    session: {
    async create(input: unknown) {
      createInputs.push(input);
      sessionNumber += 1;
      return { data: { data: { id: `session_${sessionNumber}` } } };
    },
    async prompt(input: unknown) {
      promptInputs.push(input);
      return input;
    },
    async wait() {},
    async messages(input: unknown) {
      const sessionId = (input as { sessionID: string }).sessionID;
      return {
        data: { data: [{
          info: { role: "assistant" },
          parts: [{ type: "text", text: `response:${sessionId}` }],
        }] },
      };
    },
    async get() {
      return { data: { data: { model: { providerID: "anthropic", id: "sonnet" } } } };
    },
    async switchModel(input: unknown) { switchInputs.push(input); },
    },
  },
} as unknown as OpencodeClientLike;
let factoryCalls = 0;
let closeCalls = 0;
const factory: OpencodeFactory = async () => {
  factoryCalls += 1;
  return {
    client,
    server: { close: () => { closeCalls += 1; } },
  };
};
const driver = new OpencodeLocalAgentDriver(factory);
const pool = new LocalAgentRuntimePool();

const first = await pool.run(driver, {
  agentId: "agt_one",
  provider: "opencode",
  workspace: "/tmp/project",
  }, {
    prompt: "first",
    workspace: "/tmp/project",
    model: "anthropic/sonnet",
    thinking: "high",
  });
const second = await pool.run(driver, {
  agentId: "agt_two",
  provider: "opencode",
  workspace: "/tmp/project",
}, {
  prompt: "second",
  workspace: "/tmp/project",
});

assert.equal(factoryCalls, 1, "OpenCode agents share one server runtime");
assert.equal(first.providerSessionId, "session_1");
assert.equal(second.providerSessionId, "session_2");
assert.equal(second.finalResponse, "response:session_2");
assert.deepEqual(createInputs[0], {
  location: { directory: "/tmp/project" },
  model: { providerID: "anthropic", id: "sonnet", variant: "high" },
});
assert.deepEqual(promptInputs[0], {
  sessionID: "session_1",
  prompt: { text: "first" },
});

let callbackSessionId: string | undefined;
await pool.run(driver, {
  agentId: "agt_one",
  provider: "opencode",
  workspace: "/tmp/project",
}, {
  prompt: "thinking override",
  workspace: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  thinking: "low",
}, {
  onSessionId: (id) => { callbackSessionId = id; },
});
assert.equal(callbackSessionId, first.providerSessionId);
assert.deepEqual(switchInputs[0], {
  sessionID: "session_1",
  model: { providerID: "anthropic", id: "sonnet", variant: "low" },
});

await pool.close();
await pool.close();
assert.equal(closeCalls, 1, "shared OpenCode server closes once");
