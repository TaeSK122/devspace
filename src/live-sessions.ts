import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  LiveSessionStore,
  type LiveSessionRecord,
  type LiveSessionStatus,
} from "./live-session-store.js";

const DEFAULT_READ_LINES = 40;
const DEFAULT_READ_CHARACTERS = 12_000;
const MAX_READ_LINES = 500;
const MAX_READ_CHARACTERS = 100_000;
const WORKER_SESSION_NAME = "ds-live";
const MONITOR_SESSION_NAME = "ds-watch";

export interface LivePaneInfo {
  liveSessionId: string;
  paneId: string;
  dead: boolean;
  deadStatus?: number;
  panePid: number;
  windowName: string;
}

export interface LiveProcessIdentity {
  pid: number;
  startedAt: string;
}

export interface LiveProcessGroup {
  pgid: number;
  members: LiveProcessIdentity[];
}

export interface LiveReadResult {
  session: LiveSessionRecord;
  output: string;
  fingerprint: string;
}

export interface StartLiveSessionInput {
  workspaceId: string;
  workspaceRoot: string;
  cwd: string;
  name?: string;
  program: string;
  args?: string[];
  allowConcurrent?: boolean;
}

export interface SendLiveInput {
  sessionId: string;
  text: string;
  expectedFingerprint: string;
  submit?: boolean;
}

export interface LiveRuntime {
  listPanes(): Map<string, LivePaneInfo>;
  start(record: LiveSessionRecord, cwd: string): { paneId: string };
  capture(paneId: string, lines: number, maxCharacters: number): string;
  fingerprint(paneId: string): string;
  pasteText(paneId: string, text: string): void;
  pasteControl(paneId: string, bytes: Buffer): void;
  waitForDead(liveSessionId: string, timeoutMs: number): Promise<LivePaneInfo | undefined>;
  processGroups(rootPid: number): LiveProcessGroup[];
  processGroupsAlive(groups: LiveProcessGroup[]): boolean;
  signalGroups(groups: LiveProcessGroup[], signal: NodeJS.Signals): void;
  monitorAvailable(): boolean;
  syncMonitor(records: LiveSessionRecord[], brakeCommand: string, createIfMissing: boolean): number;
  watch(records: LiveSessionRecord[], brakeCommand: string): Promise<void>;
}

export interface LiveSessionManagerOptions {
  stateDir: string;
  store?: LiveSessionStore;
  runtime?: LiveRuntime;
  tmuxBin?: string;
  cliPath?: string;
}

export class LiveSessionManager {
  private readonly store: LiveSessionStore;
  private readonly runtime: LiveRuntime;
  private readonly ownsStore: boolean;
  private readonly brakeCommand: string;

  constructor(options: LiveSessionManagerOptions) {
    this.store = options.store ?? new LiveSessionStore(options.stateDir);
    this.ownsStore = !options.store;
    this.runtime = options.runtime ?? new TmuxLiveRuntime({
      stateDir: options.stateDir,
      tmuxBin: options.tmuxBin,
    });
    const cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
    this.brakeCommand = buildBrakeCommand(options.stateDir, cliPath);
  }

  list(scope: { workspaceId?: string; workspaceRoot?: string } = {}): LiveSessionRecord[] {
    this.reconcile();
    return this.store.list(scope);
  }

  start(input: StartLiveSessionInput): LiveSessionRecord {
    const program = input.program.trim();
    if (!program) throw new Error("Live session program is required.");
    const workspaceRoot = resolve(input.workspaceRoot);
    const cwd = resolve(input.cwd);
    if (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}/`)) {
      throw new Error(`Live session working directory escapes workspace root: ${cwd}`);
    }

    this.reconcile();
    const workspaceSessions = this.store.list({ workspaceRoot });
    const blockers = workspaceSessions.filter(
      (session) =>
        (session.status === "interrupted_by_user"
          || session.status === "interrupted_by_controller"
          || session.status === "unavailable")
        && !session.reconciledAt,
    );
    if (blockers.length > 0) {
      throw new Error(
        `Execution gate blocked by unresolved live session(s): ${blockers.map(formatSessionRef).join(", ")}`,
      );
    }

    const running = workspaceSessions.filter((session) => session.status === "running");
    if (running.length > 0 && input.allowConcurrent !== true) {
      throw new Error(
        `Live session(s) already running in this workspace: ${running.map(formatSessionRef).join(", ")}. `
        + "Set allowConcurrent=true only after deciding the new session is intentionally independent.",
      );
    }

    const id = `live_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const args = [...(input.args ?? [])];
    const name = normalizeDisplayName(input.name ?? basename(program) ?? "worker");
    const windowName = `ds-${id}`;
    let record = this.store.create({
      id,
      workspaceId: input.workspaceId,
      workspaceRoot,
      name,
      program,
      args,
      windowName,
    });

    try {
      const started = this.runtime.start(record, cwd);
      record = this.store.update(id, {
        paneId: started.paneId,
        status: "running",
        unavailableAt: undefined,
        error: undefined,
        exitCode: undefined,
      });
    } catch (error) {
      this.store.update(id, {
        status: "failed",
        unavailableAt: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.syncMonitorBestEffort();
    return record;
  }

  read(sessionId: string, options: { lines?: number; maxCharacters?: number } = {}): LiveReadResult {
    this.reconcile();
    const session = this.requireSession(sessionId);
    if (!session.paneId) {
      return { session, output: "", fingerprint: "" };
    }

    const panes = this.runtime.listPanes();
    const pane = panes.get(session.id);
    if (!pane || pane.paneId !== session.paneId) {
      return { session: this.requireSession(session.id), output: "", fingerprint: "" };
    }

    const lines = boundedInteger(options.lines, DEFAULT_READ_LINES, 1, MAX_READ_LINES, "lines");
    const maxCharacters = boundedInteger(
      options.maxCharacters,
      DEFAULT_READ_CHARACTERS,
      256,
      MAX_READ_CHARACTERS,
      "maxCharacters",
    );
    return {
      session: this.requireSession(session.id),
      output: this.runtime.capture(pane.paneId, lines, maxCharacters),
      fingerprint: this.runtime.fingerprint(pane.paneId),
    };
  }

  send(input: SendLiveInput): LiveSessionRecord {
    this.reconcile();
    const session = this.requireSession(input.sessionId);
    if (session.status !== "running" || !session.paneId) {
      throw new Error(`Live session ${session.id} is ${session.status}; input is blocked.`);
    }
    if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
      throw new Error("expectedFingerprint must come from a prior live_read_session result.");
    }

    const currentFingerprint = this.runtime.fingerprint(session.paneId);
    if (currentFingerprint !== input.expectedFingerprint) {
      throw new Error(`Interaction precondition failed for ${session.id}: screen changed before input.`);
    }

    this.runtime.pasteText(session.paneId, input.text);
    if (input.submit !== false) this.runtime.pasteControl(session.paneId, Buffer.from([0x0d]));
    return this.requireSession(session.id);
  }

  async brake(sessionId: string, actor: "user" | "controller" = "controller"): Promise<LiveSessionRecord> {
    this.reconcile();
    let session = this.requireSession(sessionId);
    if (session.status === "interrupted_by_user" || session.status === "interrupted_by_controller") return session;
    if (session.status !== "running" || !session.paneId) {
      throw new Error(`Cannot Brake live session ${session.id} in state ${session.status}.`);
    }

    const before = this.runtime.listPanes().get(session.id);
    if (!before || before.dead || before.paneId !== session.paneId) {
      throw new Error(`Managed pane for ${session.id} is not live; Brake fails closed.`);
    }

    let ownedGroups = this.runtime.processGroups(before.panePid);
    session = this.store.update(session.id, {
      status: actor === "user" ? "interrupted_by_user" : "interrupted_by_controller",
      interruptedAt: new Date().toISOString(),
      interruptedActor: actor,
      reconciledAt: undefined,
      paneId: before.paneId,
    });

    this.runtime.pasteControl(before.paneId, Buffer.from([0x03]));
    let after = await this.runtime.waitForDead(session.id, 350);

    const refreshOwnedGroups = () => {
      if (after && !after.dead) {
        ownedGroups = mergeProcessGroups(ownedGroups, this.runtime.processGroups(before.panePid));
      }
    };
    const stillActive = () => Boolean(after && !after.dead) || this.runtime.processGroupsAlive(ownedGroups);

    if (stillActive()) {
      refreshOwnedGroups();
      this.runtime.signalGroups(ownedGroups, "SIGINT");
      after = await this.runtime.waitForDead(session.id, 350);
    }
    if (stillActive()) {
      refreshOwnedGroups();
      this.runtime.signalGroups(ownedGroups, "SIGTERM");
      after = await this.runtime.waitForDead(session.id, 500);
    }
    if (stillActive()) {
      refreshOwnedGroups();
      this.runtime.signalGroups(ownedGroups, "SIGKILL");
      after = await this.runtime.waitForDead(session.id, 500);
    }
    if (stillActive()) {
      throw new Error(`Brake escalation failed to stop ${session.id}; interrupted state remains unresolved.`);
    }

    return this.store.update(session.id, {
      exitCode: after?.deadStatus,
      error: undefined,
    });
  }

  resolve(sessionId: string): LiveSessionRecord {
    this.reconcile();
    const session = this.requireSession(sessionId);
    if (
      session.status !== "interrupted_by_user"
      && session.status !== "interrupted_by_controller"
      && session.status !== "unavailable"
    ) {
      throw new Error(`Live session ${session.id} in state ${session.status} does not require reconciliation.`);
    }
    if (session.reconciledAt) return session;
    return this.store.update(session.id, { reconciledAt: new Date().toISOString() });
  }

  async watch(): Promise<void> {
    const records = this.list();
    if (records.length === 0) throw new Error("No live sessions exist to monitor.");

    const refreshMonitor = () => {
      this.reconcile();
      this.syncMonitorBestEffort();
    };
    const refreshTimer = setInterval(refreshMonitor, 750);
    refreshTimer.unref();
    try {
      await this.runtime.watch(records, this.brakeCommand);
    } finally {
      clearInterval(refreshTimer);
    }
  }

  close(): void {
    if (this.ownsStore) this.store.close();
  }

  private syncMonitorBestEffort(): void {
    if (!this.runtime.monitorAvailable()) return;
    try {
      this.runtime.syncMonitor(this.store.list(), this.brakeCommand, false);
    } catch {
      // The monitor is presentation-only and may disappear between tmux calls.
      // Worker lifecycle truth must not be changed or the caller failed because the view closed.
    }
  }

  private reconcile(): void {
    const panes = this.runtime.listPanes();
    for (const session of this.store.list()) {
      const pane = panes.get(session.id);
      if (!pane) {
        if (session.status === "running") {
          this.store.update(session.id, {
            status: "unavailable",
            unavailableAt: new Date().toISOString(),
          });
        }
        continue;
      }

      if (session.paneId !== pane.paneId) {
        this.store.update(session.id, { paneId: pane.paneId });
      }

      if (pane.dead) {
        if (session.status === "running" || session.status === "unavailable") {
          this.store.update(session.id, {
            status: pane.deadStatus === 0 ? "completed" : "failed",
            exitCode: pane.deadStatus,
            unavailableAt: undefined,
          });
        } else if (
          (session.status === "interrupted_by_user" || session.status === "interrupted_by_controller")
          && session.exitCode !== pane.deadStatus
        ) {
          this.store.update(session.id, { exitCode: pane.deadStatus });
        }
        continue;
      }

      if (session.status === "unavailable") {
        this.store.update(session.id, {
          status: "running",
          unavailableAt: undefined,
        });
      }
    }
  }

  private requireSession(idOrPrefix: string): LiveSessionRecord {
    const session = this.store.get(idOrPrefix);
    if (!session) throw new Error(`Unknown or ambiguous live session: ${idOrPrefix}`);
    return session;
  }
}

interface TmuxLiveRuntimeOptions {
  stateDir: string;
  tmuxBin?: string;
}

export class TmuxLiveRuntime implements LiveRuntime {
  readonly tmuxBin: string;
  readonly workerSocketName: string;
  readonly monitorSocketName: string;

  constructor(options: TmuxLiveRuntimeOptions) {
    this.tmuxBin = options.tmuxBin ?? process.env.DEVSPACE_LIVE_TMUX_BIN ?? "tmux";
    const suffix = createHash("sha256").update(resolve(options.stateDir)).digest("hex").slice(0, 10);
    this.workerSocketName = `devspace-live-${suffix}`;
    this.monitorSocketName = `${this.workerSocketName}-monitor`;
  }

  listPanes(): Map<string, LivePaneInfo> {
    if (!this.workerServerAvailable()) return new Map();
    const result = this.runWorker([
      "list-panes",
      "-a",
      "-F",
      "#{@devspace_live_id}\t#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}\t#{window_name}",
    ], { allowFailure: true });
    if (result.status !== 0) return new Map();
    const panes = new Map<string, LivePaneInfo>();
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const [liveSessionId, paneId, dead, deadStatus, panePid, windowName] = line.split("\t");
      if (!liveSessionId || !paneId) continue;
      panes.set(liveSessionId, {
        liveSessionId,
        paneId,
        dead: dead === "1",
        deadStatus: deadStatus ? Number(deadStatus) : undefined,
        panePid: Number(panePid),
        windowName: windowName ?? "",
      });
    }
    return panes;
  }

  start(record: LiveSessionRecord, cwd: string): { paneId: string } {
    const command = [record.program, ...record.args];
    let result: TmuxResult;
    if (!this.workerServerAvailable()) {
      result = this.runWorker([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        WORKER_SESSION_NAME,
        "-n",
        record.windowName,
        "-c",
        cwd,
        ...command,
      ]);
      this.runWorker(["set-option", "-t", WORKER_SESSION_NAME, "history-limit", "20000"]);
    } else {
      result = this.runWorker([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `${WORKER_SESSION_NAME}:`,
        "-n",
        record.windowName,
        "-c",
        cwd,
        ...command,
      ]);
    }

    const paneId = result.stdout.trim();
    if (!paneId.startsWith("%")) throw new Error(`Unexpected tmux pane id: ${paneId}`);
    this.runWorker(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
    this.runWorker(["set-option", "-p", "-t", paneId, "@devspace_live_id", record.id]);
    this.runWorker(["set-option", "-w", "-t", paneId, "automatic-rename", "off"]);
    return { paneId };
  }

  capture(paneId: string, lines: number, maxCharacters: number): string {
    const depth = Math.max(lines * 3, 120);
    const result = this.runWorker(["capture-pane", "-p", "-J", "-t", paneId, "-S", `-${depth}`]);
    const selected = result.stdout.split("\n").slice(-lines - 1).join("\n");
    return takeTailCodePoints(selected, maxCharacters);
  }

  fingerprint(paneId: string): string {
    const result = this.runWorker(["capture-pane", "-p", "-e", "-N", "-t", paneId]);
    return createHash("sha256").update(result.stdout, "utf8").digest("hex");
  }

  pasteText(paneId: string, text: string): void {
    const bufferName = `devspace-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.runWorker(["load-buffer", "-b", bufferName, "-"], { input: Buffer.from(text, "utf8") });
    this.runWorker(["paste-buffer", "-p", "-b", bufferName, "-d", "-t", paneId]);
  }

  pasteControl(paneId: string, bytes: Buffer): void {
    const bufferName = `devspace-control-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.runWorker(["load-buffer", "-b", bufferName, "-"], { input: bytes });
    this.runWorker(["paste-buffer", "-S", "-r", "-b", bufferName, "-d", "-t", paneId]);
  }

  async waitForDead(liveSessionId: string, timeoutMs: number): Promise<LivePaneInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = this.listPanes().get(liveSessionId);
      if (!pane || pane.dead) return pane;
      await sleep(50);
    }
    return this.listPanes().get(liveSessionId);
  }

  processGroups(rootPid: number): LiveProcessGroup[] {
    if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
    const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      env: controllerEnvironment(),
    });
    if (result.status !== 0) return [];

    const processes = result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((parts) => parts.length === 3 && parts.every(Number.isInteger))
      .map(([pid, ppid, pgid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid! }));
    if (!processes.some((entry) => entry.pid === rootPid)) return [];

    const descendants = new Set<number>([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of processes) {
        if (descendants.has(entry.pid) || !descendants.has(entry.ppid)) continue;
        descendants.add(entry.pid);
        changed = true;
      }
    }

    const groups = new Map<number, LiveProcessIdentity[]>();
    for (const entry of processes) {
      if (!descendants.has(entry.pid) || entry.pgid <= 1) continue;
      const startedAt = this.processStartedAt(entry.pid);
      if (!startedAt) continue;
      const members = groups.get(entry.pgid) ?? [];
      members.push({ pid: entry.pid, startedAt });
      groups.set(entry.pgid, members);
    }
    return [...groups.entries()].map(([pgid, members]) => ({ pgid, members }));
  }

  processGroupsAlive(groups: LiveProcessGroup[]): boolean {
    return groups.some((group) => group.members.some((member) => this.processIdentityAlive(member)));
  }

  signalGroups(groups: LiveProcessGroup[], signal: NodeJS.Signals): void {
    const ownGroup = this.processGroupId(process.pid);
    for (const group of groups) {
      if (ownGroup === group.pgid) {
        throw new Error(`Refusing to signal DevSpace's own process group ${group.pgid}.`);
      }
      if (!group.members.some((member) => this.processIdentityAlive(member))) continue;
      try {
        process.kill(-group.pgid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  private processGroupId(pid: number): number | undefined {
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    const result = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      env: controllerEnvironment(),
    });
    if (result.status !== 0) return undefined;
    const pgid = Number(result.stdout.trim());
    return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
  }

  private processStartedAt(pid: number): string | undefined {
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: controllerEnvironment(),
    });
    if (result.status !== 0) return undefined;
    const startedAt = result.stdout.trim();
    return startedAt || undefined;
  }

  private processIdentityAlive(identity: LiveProcessIdentity): boolean {
    return this.processStartedAt(identity.pid) === identity.startedAt;
  }

  monitorAvailable(): boolean {
    return this.runMonitor(["has-session", "-t", MONITOR_SESSION_NAME], { allowFailure: true }).status === 0;
  }

  syncMonitor(records: LiveSessionRecord[], brakeCommand: string, createIfMissing: boolean): number {
    const panes = this.listPanes();
    const available = this.monitorAvailable();
    if (!available && !createIfMissing) return 0;

    const existing = available ? this.monitorWindows() : new Map<string, string>();
    const wantedIds = new Set(records.map((record) => record.id));
    for (const [id, windowId] of existing) {
      if (!wantedIds.has(id)) this.runMonitor(["kill-window", "-t", windowId], { allowFailure: true });
    }

    let monitorExists = available;
    let visibleCount = 0;
    for (const record of records) {
      const pane = panes.get(record.id);
      let windowId = existing.get(record.id);
      if (!windowId && !pane) continue;

      const displayName = monitorWindowName(record);
      if (!windowId) {
        this.ensureViewSession(record);
        const innerCommand = [
          this.tmuxBin,
          "-L",
          this.workerSocketName,
          "attach",
          "-t",
          viewSessionName(record.id),
          "-f",
          "read-only",
        ];
        const result = monitorExists
          ? this.runMonitor([
              "new-window",
              "-d",
              "-P",
              "-F",
              "#{window_id}",
              "-t",
              `${MONITOR_SESSION_NAME}:`,
              "-n",
              displayName,
              ...innerCommand,
            ])
          : this.runMonitor([
              "new-session",
              "-d",
              "-P",
              "-F",
              "#{window_id}",
              "-s",
              MONITOR_SESSION_NAME,
              "-n",
              displayName,
              ...innerCommand,
            ]);
        monitorExists = true;
        windowId = result.stdout.trim();
        if (!windowId.startsWith("@")) throw new Error(`Unexpected monitor window id: ${windowId}`);
        this.runMonitor(["set-option", "-w", "-t", windowId, "@devspace_live_id", record.id]);
        this.runMonitor(["set-option", "-w", "-t", windowId, "automatic-rename", "off"]);
        this.runMonitor(["set-option", "-p", "-t", windowId, "remain-on-exit", "on"]);
      } else {
        this.runMonitor(["rename-window", "-t", windowId, displayName]);
      }

      this.runMonitor(["set-option", "-w", "-t", windowId, "@devspace_live_status", record.status]);
      visibleCount += 1;
    }

    if (!monitorExists) return 0;
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "mouse", "on"]);
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "prefix", "None"]);
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "status-left", ""]);
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "status-left-length", "0"]);
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "status-style", "bg=default,fg=default"]);
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "window-status-separator", "  "]);
    this.runMonitor([
      "set-option",
      "-t",
      MONITOR_SESSION_NAME,
      "window-status-format",
      "#{?#{==:#{@devspace_live_status},running},#[fg=white]#[bg=green],#[fg=white]#[bg=red]} #W #[default]",
    ]);
    this.runMonitor([
      "set-option",
      "-t",
      MONITOR_SESSION_NAME,
      "window-status-current-format",
      "#{?#{==:#{@devspace_live_status},running},#[fg=white]#[bg=green]#[bold],#[fg=white]#[bg=red]#[bold]} #W #[default]",
    ]);
    this.runMonitor([
      "set-option",
      "-t",
      MONITOR_SESSION_NAME,
      "status-right",
      "#[range=control|0]#[fg=green]#[bg=black] [ Close Monitor ] #[default]#[norange]",
    ]);
    this.runMonitor(["set-option", "-t", MONITOR_SESSION_NAME, "status-right-length", "28"]);
    this.runMonitor(["bind-key", "-n", "MouseDown1Control0", "kill-server"]);
    this.runMonitor(["bind-key", "-n", "C-c", "run-shell", "-b", brakeCommand]);
    return visibleCount;
  }

  async watch(records: LiveSessionRecord[], brakeCommand: string): Promise<void> {
    const count = this.syncMonitor(records, brakeCommand, true);
    if (count === 0) throw new Error("No live tmux panes are available to monitor.");

    const child = spawn(
      this.tmuxBin,
      ["-L", this.monitorSocketName, "attach", "-t", MONITOR_SESSION_NAME],
      { stdio: "inherit", env: controllerEnvironment() },
    );
    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code && code !== 0 && this.monitorAvailable()) {
            reject(new Error(`tmux monitor exited with code ${code}${signal ? ` (${signal})` : ""}.`));
            return;
          }
          resolvePromise();
        });
      });
    } finally {
      this.runMonitor(["kill-server"], { allowFailure: true });
    }
  }

  private workerServerAvailable(): boolean {
    return this.runWorker(["has-session", "-t", WORKER_SESSION_NAME], { allowFailure: true }).status === 0;
  }

  private ensureViewSession(record: LiveSessionRecord): void {
    const viewName = viewSessionName(record.id);
    const exists = this.runWorker(["has-session", "-t", viewName], { allowFailure: true }).status === 0;
    if (!exists) {
      this.runWorker(["new-session", "-d", "-s", viewName, "-t", WORKER_SESSION_NAME]);
      this.runWorker(["set-option", "-t", viewName, "status", "off"]);
    }
    this.runWorker(["select-window", "-t", `${viewName}:${record.windowName}`]);
  }

  private monitorWindows(): Map<string, string> {
    const result = this.runMonitor([
      "list-windows",
      "-t",
      MONITOR_SESSION_NAME,
      "-F",
      "#{@devspace_live_id}\t#{window_id}",
    ]);
    const windows = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const [id, windowId] = line.split("\t");
      if (id && windowId) windows.set(id, windowId);
    }
    return windows;
  }

  private runWorker(args: string[], options: TmuxRunOptions = {}): TmuxResult {
    return this.runTmux(this.workerSocketName, args, options);
  }

  private runMonitor(args: string[], options: TmuxRunOptions = {}): TmuxResult {
    return this.runTmux(this.monitorSocketName, args, options);
  }

  private runTmux(socketName: string, args: string[], options: TmuxRunOptions): TmuxResult {
    const result = spawnSync(this.tmuxBin, ["-L", socketName, ...args], {
      encoding: "utf8",
      input: options.input,
      env: controllerEnvironment(),
    });
    if (!options.allowFailure && (result.error || result.status !== 0)) {
      const detail = result.error?.message || result.stderr || result.stdout || "tmux command failed";
      throw new Error(`${this.tmuxBin} -L ${socketName} ${args.join(" ")} failed: ${detail.trim()}`);
    }
    return {
      status: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

interface TmuxRunOptions {
  input?: string | Buffer;
  allowFailure?: boolean;
}

interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function createLiveSessionManager(config: ServerConfig): LiveSessionManager {
  return new LiveSessionManager({ stateDir: config.stateDir });
}

function buildBrakeCommand(stateDir: string, cliPath: string): string {
  return [
    `DEVSPACE_STATE_DIR=${shellQuote(stateDir)}`,
    shellQuote(process.execPath),
    shellQuote(cliPath),
    "live",
    "brake",
    shellQuote("#{@devspace_live_id}"),
    "--user",
  ].join(" ");
}

function controllerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function monitorWindowName(record: LiveSessionRecord): string {
  const base = normalizeDisplayName(record.name).replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 24) || "worker";
  return `${base}-${record.id.slice(-4)}`;
}

function viewSessionName(id: string): string {
  return `ds-view-${id}`;
}

function normalizeDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "worker";
  return trimmed.slice(0, 80);
}

function formatSessionRef(session: Pick<LiveSessionRecord, "id" | "name">): string {
  return `${session.id} (${session.name})`;
}

function mergeProcessGroups(
  first: LiveProcessGroup[],
  second: LiveProcessGroup[],
): LiveProcessGroup[] {
  const groups = new Map<number, Map<string, LiveProcessIdentity>>();
  for (const group of [...first, ...second]) {
    const members = groups.get(group.pgid) ?? new Map<string, LiveProcessIdentity>();
    for (const member of group.members) {
      members.set(`${member.pid}\u0000${member.startedAt}`, member);
    }
    groups.set(group.pgid, members);
  }
  return [...groups.entries()].map(([pgid, members]) => ({
    pgid,
    members: [...members.values()],
  }));
}

function takeTailCodePoints(value: string, count: number): string {
  const characters = Array.from(value);
  return characters.length <= count ? value : characters.slice(characters.length - count).join("");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
