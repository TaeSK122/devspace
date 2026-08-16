import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessionStore } from "./live-session-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-live-store-test-"));
try {
  const stateDir = join(root, ".state");
  const first = new LiveSessionStore(stateDir);
  const created = first.create({
    id: "live_test123",
    workspaceId: "ws_test",
    workspaceRoot: root,
    name: "Codex Build",
    program: "codex",
    args: ["-C", root],
    windowName: "ds-live_test123",
  });
  assert.equal(created.status, "unavailable");
  assert.ok(created.unavailableAt);

  const running = first.update(created.id, {
    status: "running",
    paneId: "%7",
    unavailableAt: undefined,
  });
  assert.equal(running.status, "running");
  assert.equal(running.paneId, "%7");
  assert.equal(running.unavailableAt, undefined);
  first.close();

  const reopened = new LiveSessionStore(stateDir);
  const restored = reopened.get("live_test");
  assert.ok(restored);
  assert.equal(restored.id, created.id);
  assert.deepEqual(restored.args, ["-C", root]);
  assert.equal(restored.status, "running");
  assert.equal(restored.paneId, "%7");

  const interrupted = reopened.update(created.id, {
    status: "interrupted_by_user",
    interruptedAt: new Date().toISOString(),
    interruptedActor: "user",
    reconciledAt: undefined,
  });
  assert.equal(interrupted.status, "interrupted_by_user");
  assert.equal(interrupted.interruptedActor, "user");
  assert.equal(interrupted.reconciledAt, undefined);

  assert.deepEqual(
    reopened.list({ workspaceId: "ws_test" }).map((session) => session.id),
    [created.id],
  );
  reopened.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
