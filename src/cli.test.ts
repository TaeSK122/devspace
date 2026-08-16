import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LiveSessionStore } from "./live-session-store.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const liveRoot = mkdtempSync(join(tmpdir(), "devspace-cli-live-test-"));
try {
  const configDir = join(liveRoot, ".devspace");
  const stateDir = join(liveRoot, ".state");
  const projectRoot = join(liveRoot, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    allowedRoots: [projectRoot],
    stateDir,
  }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));

  const liveStore = new LiveSessionStore(stateDir);
  const record = liveStore.update(
    liveStore.create({
      id: "live_cli123",
      workspaceId: "ws_live",
      workspaceRoot: projectRoot,
      name: "Codex Build",
      program: "codex",
      args: [],
      windowName: "ds-live_cli123",
    }).id,
    {
      status: "interrupted_by_user",
      interruptedAt: new Date().toISOString(),
      interruptedActor: "user",
    },
  );
  liveStore.close();

  const env = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
  const listed = execFileSync("node", ["--import", "tsx", "src/cli.ts", "live", "list"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
  assert.match(listed, new RegExp(`${record.id} interrupted_by_user unresolved Codex Build`));

  execFileSync("node", ["--import", "tsx", "src/cli.ts", "live", "resolve", record.id], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
  const reopened = new LiveSessionStore(stateDir);
  assert.ok(reopened.get(record.id)?.reconciledAt);
  reopened.close();

  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "liveSessions", "true"],
    { cwd: process.cwd(), encoding: "utf8", env },
  );
  assert.equal(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).liveSessions, true);
} finally {
  rmSync(liveRoot, { recursive: true, force: true });
}
