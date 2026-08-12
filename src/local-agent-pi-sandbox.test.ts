import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createPiSandboxExtension,
  createPiSandboxModeRef,
  registerPiSandboxSession,
  releasePiSandboxSession,
} from "./local-agent-pi-sandbox.js";

const dependencies = await SandboxManager.checkDependenciesAsync();
if (SandboxManager.isSupportedPlatform() && dependencies.errors.length === 0) {
  const root = await mkdtemp(join(tmpdir(), "devspace-pi-sandbox-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const outside = join(root, "outside.txt");
  const session = {};
  const modeRef = createPiSandboxModeRef("allowed");
  const tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();

  try {
    createPiSandboxExtension(workspace, modeRef)({
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
    } as never);
    await registerPiSandboxSession(session, workspace, modeRef, "allowed");

    const bash = tools.get("bash");
    assert.ok(bash, "Pi sandbox extension registers a bash tool");
    await assert.rejects(
      bash.execute("bash-test", {
        command: `touch ${join(workspace, "inside.txt")}; touch ${outside}`,
      }),
      /Read-only file system|Command exited with code/,
    );
    assert.equal(existsSync(join(workspace, "inside.txt")), true);
    assert.equal(existsSync(outside), false, "sandboxed Pi bash cannot write outside the workspace");

    const read = tools.get("read");
    assert.ok(read, "Pi sandbox extension registers a read tool");
    await assert.rejects(
      read.execute("read-test", { path: outside }),
      /outside the allowed root|outside allowed roots|outside the workspace|not allowed/i,
    );
  } finally {
    await releasePiSandboxSession(session);
    await rm(root, { recursive: true, force: true });
  }
} else {
  console.log("Pi sandbox integration test skipped: sandbox-runtime dependencies are unavailable.");
}
