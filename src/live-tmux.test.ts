import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessionManager, TmuxLiveRuntime } from "./live-sessions.js";

const tmuxProbe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
if (tmuxProbe.status === 0) {
  const root = mkdtempSync(join(tmpdir(), "devspace-live-tmux-test-"));
  const stateDir = join(root, ".state");
  const runtime = new TmuxLiveRuntime({ stateDir, tmuxBin: "tmux" });
  const manager = new LiveSessionManager({
    stateDir,
    runtime,
    cliPath: "/tmp/devspace-live-test-cli.js",
  });

  const killServers = () => {
    spawnSync("tmux", ["-L", runtime.monitorSocketName, "kill-server"], { encoding: "utf8" });
    spawnSync("tmux", ["-L", runtime.workerSocketName, "kill-server"], { encoding: "utf8" });
  };

  try {
    killServers();
    const workerScript = [
      "console.log('READY')",
      "process.stdin.on('data', d => console.log('DATA ' + d.toString('base64')))",
      "process.on('SIGINT', () => { console.log('INTERRUPTED'); process.exit(130) })",
      "setInterval(() => {}, 1000)",
    ].join(";");

    const session = manager.start({
      workspaceId: "ws_tmux",
      workspaceRoot: root,
      cwd: root,
      name: "native-test",
      program: process.execPath,
      args: ["-e", workerScript],
    });
    await waitFor(() => manager.read(session.id).output.includes("READY"));

    const monitorCount = runtime.syncMonitor(manager.list(), "/bin/true", true);
    assert.equal(monitorCount, 1);
    await sleep(150);

    const clients = spawnSync(
      "tmux",
      ["-L", runtime.workerSocketName, "list-clients", "-F", "#{client_readonly}:#{client_session}"],
      { encoding: "utf8" },
    );
    assert.equal(clients.status, 0, clients.stderr);
    assert.match(clients.stdout, /^1:/m);

    const closeLabel = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "show-options", "-v", "-t", "ds-watch", "status-right"],
      { encoding: "utf8" },
    );
    assert.equal(closeLabel.status, 0, closeLabel.stderr);
    assert.match(closeLabel.stdout, /fg=green/);
    assert.match(closeLabel.stdout, /bg=black/);
    assert.match(closeLabel.stdout, /Close Monitor/);

    const windowFormat = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "show-options", "-v", "-t", "ds-watch", "window-status-format"],
      { encoding: "utf8" },
    );
    assert.equal(windowFormat.status, 0, windowFormat.stderr);
    assert.match(windowFormat.stdout, /bg=green/);
    assert.match(windowFormat.stdout, /bg=red/);
    const currentWindowFormat = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "show-options", "-v", "-t", "ds-watch", "window-status-current-format"],
      { encoding: "utf8" },
    );
    assert.equal(currentWindowFormat.status, 0, currentWindowFormat.stderr);
    assert.match(currentWindowFormat.stdout, /bold/);
    const monitorWindowState = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "list-windows", "-t", "ds-watch", "-F", "#{@devspace_live_status}"],
      { encoding: "utf8" },
    );
    assert.equal(monitorWindowState.status, 0, monitorWindowState.stderr);
    assert.match(monitorWindowState.stdout, /^running$/m);

    const monitorKeys = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "list-keys", "-T", "root"],
      { encoding: "utf8" },
    );
    assert.equal(monitorKeys.status, 0, monitorKeys.stderr);
    assert.match(monitorKeys.stdout, /MouseDown1Control0\s+kill-server/);

    const beforeSend = manager.read(session.id);
    const payload = "MONITOR_CONCURRENT ภาษาไทย 🙂";
    manager.send({
      sessionId: session.id,
      text: payload,
      expectedFingerprint: beforeSend.fingerprint,
    });
    await waitFor(() => {
      const output = manager.read(session.id, { lines: 80 }).output;
      const match = output.match(/DATA ([A-Za-z0-9+/=]+)/);
      return Boolean(match && Buffer.from(match[1]!, "base64").toString("utf8").startsWith(payload));
    });

    const stale = manager.read(session.id);
    runtime.pasteText(session.paneId!, "screen-change");
    runtime.pasteControl(session.paneId!, Buffer.from([0x0d]));
    await waitFor(() => manager.read(session.id).fingerprint !== stale.fingerprint);
    assert.throws(
      () => manager.send({
        sessionId: session.id,
        text: "must-not-send",
        expectedFingerprint: stale.fingerprint,
      }),
      /screen changed before input/,
    );

    const closeMonitor = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "kill-server"],
      { encoding: "utf8" },
    );
    assert.equal(closeMonitor.status, 0, closeMonitor.stderr);
    await waitFor(() => !runtime.monitorAvailable());
    const paneAfterMonitorClose = runtime.listPanes().get(session.id);
    assert.ok(paneAfterMonitorClose);
    assert.equal(paneAfterMonitorClose.dead, false);
    const clientsAfterMonitorClose = spawnSync(
      "tmux",
      ["-L", runtime.workerSocketName, "list-clients", "-F", "#{client_session}"],
      { encoding: "utf8" },
    );
    assert.equal(clientsAfterMonitorClose.stdout.trim(), "");

    assert.equal(runtime.syncMonitor(manager.list(), "/bin/true", true), 1);
    await sleep(150);
    const braked = await manager.brake(session.id, "user");
    assert.equal(braked.status, "interrupted_by_user");
    assert.equal(braked.interruptedActor, "user");
    assert.ok(braked.interruptedAt);
    assert.equal(manager.list().find((record) => record.id === session.id)?.status, "interrupted_by_user");
    assert.equal(runtime.syncMonitor(manager.list(), "/bin/true", false), 1);
    const brakedMonitorState = spawnSync(
      "tmux",
      ["-L", runtime.monitorSocketName, "list-windows", "-t", "ds-watch", "-F", "#{@devspace_live_status}"],
      { encoding: "utf8" },
    );
    assert.equal(brakedMonitorState.status, 0, brakedMonitorState.stderr);
    assert.match(brakedMonitorState.stdout, /^interrupted_by_user$/m);
    assert.ok(manager.resolve(session.id).reconciledAt);

    const detachedScript = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn('/bin/sleep', ['1000'], { detached: true, stdio: 'inherit' })",
      "console.log('DETACHED=' + child.pid)",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const detachedSession = manager.start({
      workspaceId: "ws_tmux",
      workspaceRoot: root,
      cwd: root,
      name: "detached-child-test",
      program: process.execPath,
      args: ["-e", detachedScript],
      allowConcurrent: true,
    });
    let detachedPid = 0;
    await waitFor(() => {
      const output = manager.read(detachedSession.id, { lines: 40 }).output;
      const match = output.match(/DETACHED=(\d+)/);
      if (match) detachedPid = Number(match[1]);
      return detachedPid > 1;
    });
    await manager.brake(detachedSession.id, "user");
    await waitFor(() => !processExists(detachedPid));
    assert.ok(manager.resolve(detachedSession.id).reconciledAt);

    const serverLossSession = manager.start({
      workspaceId: "ws_tmux",
      workspaceRoot: root,
      cwd: root,
      name: "worker-server-loss-test",
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      allowConcurrent: true,
    });
    assert.equal(runtime.syncMonitor(manager.list(), "/bin/true", true) >= 1, true);
    const killWorkerServer = spawnSync(
      "tmux",
      ["-L", runtime.workerSocketName, "kill-server"],
      { encoding: "utf8" },
    );
    assert.equal(killWorkerServer.status, 0, killWorkerServer.stderr);
    const afterWorkerServerLoss = manager.list().find((record) => record.id === serverLossSession.id);
    assert.equal(afterWorkerServerLoss?.status, "unavailable");
  } finally {
    manager.close();
    killServers();
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  assert.fail("Timed out waiting for live tmux condition.");
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
