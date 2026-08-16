import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessionStore, type LiveSessionRecord } from "./live-session-store.js";
import {
  LiveSessionManager,
  type LivePaneInfo,
  type LiveProcessGroup,
  type LiveRuntime,
} from "./live-sessions.js";

class FakeRuntime implements LiveRuntime {
  readonly panes = new Map<string, LivePaneInfo>();
  readonly textWrites: Array<{ paneId: string; text: string }> = [];
  readonly controlWrites: Array<{ paneId: string; bytes: number[] }> = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly fingerprints = new Map<string, string>();
  readonly processGroupsByPid = new Map<number, LiveProcessGroup[]>();
  readonly monitorSnapshots: LiveSessionRecord[][] = [];
  private nextPane = 1;
  store?: LiveSessionStore;
  brakeTargetId?: string;
  monitorEnabled = false;
  watchDelayMs = 0;
  syncMonitorFailuresRemaining = 0;
  syncMonitorAttempts = 0;

  listPanes(): Map<string, LivePaneInfo> {
    return new Map(this.panes);
  }

  start(record: { id: string; windowName: string }, _cwd: string): { paneId: string } {
    const paneId = `%${this.nextPane}`;
    const pane: LivePaneInfo = {
      liveSessionId: record.id,
      paneId,
      dead: false,
      panePid: 1000 + this.nextPane,
      windowName: record.windowName,
    };
    this.nextPane += 1;
    this.panes.set(record.id, pane);
    this.fingerprints.set(paneId, "a".repeat(64));
    this.processGroupsByPid.set(pane.panePid, [{
      pgid: pane.panePid,
      members: [{ pid: pane.panePid, startedAt: `start-${pane.panePid}` }],
    }]);
    return { paneId };
  }

  capture(paneId: string): string {
    return `SCREEN ${paneId}`;
  }

  fingerprint(paneId: string): string {
    return this.fingerprints.get(paneId) ?? "f".repeat(64);
  }

  pasteText(paneId: string, text: string): void {
    this.textWrites.push({ paneId, text });
  }

  pasteControl(paneId: string, bytes: Buffer): void {
    this.controlWrites.push({ paneId, bytes: [...bytes] });
    if (bytes.length === 1 && bytes[0] === 0x03) {
      const liveId = [...this.panes.values()].find((pane) => pane.paneId === paneId)?.liveSessionId;
      assert.ok(liveId);
      const status = this.store?.get(liveId)?.status;
      assert.ok(status === "interrupted_by_user" || status === "interrupted_by_controller");
    }
  }

  async waitForDead(liveSessionId: string): Promise<LivePaneInfo | undefined> {
    return this.panes.get(liveSessionId);
  }

  processGroups(pid: number): LiveProcessGroup[] {
    return this.processGroupsByPid.get(pid) ?? [];
  }

  processGroupsAlive(groups: LiveProcessGroup[]): boolean {
    return groups.some((group) => group.members.some((member) => {
      const pane = [...this.panes.values()].find((candidate) => candidate.panePid === member.pid);
      return Boolean(pane && !pane.dead);
    }));
  }

  signalGroups(_groups: LiveProcessGroup[], signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (signal !== "SIGTERM" || !this.brakeTargetId) return;
    const running = this.panes.get(this.brakeTargetId);
    if (running) {
      running.dead = true;
      running.deadStatus = 143;
    }
  }

  monitorAvailable(): boolean {
    return this.monitorEnabled;
  }

  syncMonitor(records: LiveSessionRecord[]): number {
    this.syncMonitorAttempts += 1;
    if (this.syncMonitorFailuresRemaining > 0) {
      this.syncMonitorFailuresRemaining -= 1;
      throw new Error("monitor server disappeared during refresh");
    }
    this.monitorSnapshots.push(records.map((record) => ({ ...record, args: [...record.args] })));
    return records.length;
  }

  async watch(): Promise<void> {
    if (this.watchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.watchDelayMs));
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "devspace-live-manager-test-"));
try {
  const stateDir = join(root, ".state");
  const store = new LiveSessionStore(stateDir);
  const runtime = new FakeRuntime();
  runtime.store = store;
  const manager = new LiveSessionManager({ stateDir, store, runtime, cliPath: "/tmp/devspace-cli.js" });

  const first = manager.start({
    workspaceId: "ws_test",
    workspaceRoot: root,
    cwd: root,
    name: "first",
    program: "fake",
  });
  assert.equal(first.status, "running");

  const initial = manager.read(first.id);
  assert.equal(initial.output, `SCREEN ${first.paneId}`);
  assert.equal(initial.fingerprint, "a".repeat(64));

  runtime.fingerprints.set(first.paneId!, "b".repeat(64));
  assert.throws(
    () => manager.send({
      sessionId: first.id,
      text: "stale",
      expectedFingerprint: initial.fingerprint,
    }),
    /screen changed before input/,
  );
  assert.equal(runtime.textWrites.length, 0);

  const freshFingerprint = "b".repeat(64);
  manager.send({
    sessionId: first.id,
    text: "ภาษาไทย 🙂",
    expectedFingerprint: freshFingerprint,
  });
  assert.deepEqual(runtime.textWrites.at(-1), { paneId: first.paneId, text: "ภาษาไทย 🙂" });
  assert.deepEqual(runtime.controlWrites.at(-1), { paneId: first.paneId, bytes: [0x0d] });

  assert.throws(
    () => manager.start({
      workspaceId: "ws_new_conversation",
      workspaceRoot: root,
      cwd: root,
      name: "second",
      program: "fake",
    }),
    /already running/,
  );

  const brake = manager.start({
    workspaceId: "ws_test",
    workspaceRoot: root,
    cwd: root,
    name: "brake",
    program: "fake",
    allowConcurrent: true,
  });
  runtime.brakeTargetId = brake.id;
  const braked = await manager.brake(brake.id, "user");
  assert.equal(braked.status, "interrupted_by_user");
  assert.equal(braked.interruptedActor, "user");
  assert.deepEqual(runtime.signals, ["SIGINT", "SIGTERM"]);
  assert.equal(manager.list({ workspaceId: "ws_test" }).find((session) => session.id === first.id)?.status, "running");

  assert.throws(
    () => manager.start({
      workspaceId: "ws_new_conversation",
      workspaceRoot: root,
      cwd: root,
      name: "blocked",
      program: "fake",
      allowConcurrent: true,
    }),
    /unresolved live session/,
  );

  const resolvedBrake = manager.resolve(brake.id);
  assert.ok(resolvedBrake.reconciledAt);

  runtime.signals.length = 0;
  const controllerBrake = manager.start({
    workspaceId: "ws_test",
    workspaceRoot: root,
    cwd: root,
    name: "controller-brake",
    program: "fake",
    allowConcurrent: true,
  });
  runtime.brakeTargetId = controllerBrake.id;
  const controllerBraked = await manager.brake(controllerBrake.id, "controller");
  assert.equal(controllerBraked.status, "interrupted_by_controller");
  assert.equal(controllerBraked.interruptedActor, "controller");
  assert.deepEqual(runtime.signals, ["SIGINT", "SIGTERM"]);
  assert.throws(
    () => manager.start({
      workspaceId: "ws_test",
      workspaceRoot: root,
      cwd: root,
      name: "blocked-by-controller-brake",
      program: "fake",
      allowConcurrent: true,
    }),
    /unresolved live session/,
  );
  assert.ok(manager.resolve(controllerBrake.id).reconciledAt);

  runtime.monitorEnabled = true;
  runtime.syncMonitorFailuresRemaining = 1;
  const attemptsBeforeStart = runtime.syncMonitorAttempts;
  const third = manager.start({
    workspaceId: "ws_test",
    workspaceRoot: root,
    cwd: root,
    name: "third",
    program: "fake",
    allowConcurrent: true,
  });
  assert.equal(third.status, "running");
  assert.equal(runtime.syncMonitorAttempts, attemptsBeforeStart + 1);
  assert.equal(store.get(third.id)?.status, "running");
  runtime.monitorEnabled = false;

  runtime.panes.delete(first.id);
  const unavailable = manager.list({ workspaceId: "ws_test" }).find((session) => session.id === first.id);
  assert.equal(unavailable?.status, "unavailable");
  assert.equal(unavailable?.reconciledAt, undefined);
  assert.throws(
    () => manager.start({
      workspaceId: "ws_test",
      workspaceRoot: root,
      cwd: root,
      name: "blocked-by-unavailable",
      program: "fake",
      allowConcurrent: true,
    }),
    /unresolved live session/,
  );
  assert.ok(manager.resolve(first.id).reconciledAt);

  const thirdPane = runtime.panes.get(third.id);
  assert.ok(thirdPane);
  thirdPane.dead = true;
  thirdPane.deadStatus = 0;
  runtime.monitorEnabled = true;
  runtime.syncMonitorFailuresRemaining = 1;
  runtime.watchDelayMs = 1_700;
  const attemptsBeforeWatch = runtime.syncMonitorAttempts;
  await manager.watch();
  assert.ok(runtime.syncMonitorAttempts >= attemptsBeforeWatch + 2);
  assert.ok(runtime.monitorSnapshots.length >= 1);
  assert.equal(
    runtime.monitorSnapshots.at(-1)?.find((record) => record.id === third.id)?.status,
    "completed",
  );

  manager.close();
  store.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
