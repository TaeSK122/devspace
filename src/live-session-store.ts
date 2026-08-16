import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type LiveSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted_by_user"
  | "interrupted_by_controller"
  | "unavailable";

export interface LiveSessionRecord {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  name: string;
  program: string;
  args: string[];
  paneId?: string;
  windowName: string;
  status: LiveSessionStatus;
  exitCode?: number;
  error?: string;
  interruptedAt?: string;
  interruptedActor?: string;
  reconciledAt?: string;
  unavailableAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLiveSessionRecordInput {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  name: string;
  program: string;
  args: string[];
  windowName: string;
}

export interface LiveSessionListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LiveSessionRow {
  id: string;
  workspace_id: string;
  workspace_root: string;
  name: string;
  program: string;
  args_json: string;
  pane_id: string | null;
  window_name: string;
  status: string;
  exit_code: number | null;
  error: string | null;
  interrupted_at: string | null;
  interrupted_actor: string | null;
  reconciled_at: string | null;
  unavailable_at: string | null;
  created_at: string;
  updated_at: string;
}

export class LiveSessionStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LiveSessionListScope = {}): LiveSessionRecord[] {
    let rows: LiveSessionRow[];
    if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from live_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LiveSessionRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from live_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LiveSessionRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from live_sessions order by updated_at desc")
        .all() as LiveSessionRow[];
    }

    return rows.map(rowToRecord);
  }

  get(idOrPrefix: string): LiveSessionRecord | undefined {
    const exact = this.getById(idOrPrefix);
    if (exact) return exact;

    const matches = this.database.sqlite
      .prepare(
        `select * from live_sessions
         where id like ? escape '\\'
         order by updated_at desc`,
      )
      .all(`${escapeLike(idOrPrefix)}%`) as LiveSessionRow[];

    return matches.length === 1 ? rowToRecord(matches[0]!) : undefined;
  }

  create(input: CreateLiveSessionRecordInput): LiveSessionRecord {
    const timestamp = new Date().toISOString();
    const record: LiveSessionRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      name: input.name,
      program: input.program,
      args: [...input.args],
      windowName: input.windowName,
      status: "unavailable",
      unavailableAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.database.sqlite
      .prepare(
        `insert into live_sessions (
          id,
          workspace_id,
          workspace_root,
          name,
          program,
          args_json,
          pane_id,
          window_name,
          status,
          exit_code,
          error,
          interrupted_at,
          interrupted_actor,
          reconciled_at,
          unavailable_at,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.workspaceRoot,
        record.name,
        record.program,
        JSON.stringify(record.args),
        null,
        record.windowName,
        record.status,
        null,
        null,
        null,
        null,
        null,
        record.unavailableAt ?? null,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  update(
    id: string,
    patch: Partial<Omit<LiveSessionRecord, "id" | "createdAt">>,
  ): LiveSessionRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown live session: ${id}`);

    const updated: LiveSessionRecord = {
      ...current,
      ...patch,
      workspaceRoot: resolve(patch.workspaceRoot ?? current.workspaceRoot),
      args: patch.args ? [...patch.args] : current.args,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update live_sessions set
          workspace_id = ?,
          workspace_root = ?,
          name = ?,
          program = ?,
          args_json = ?,
          pane_id = ?,
          window_name = ?,
          status = ?,
          exit_code = ?,
          error = ?,
          interrupted_at = ?,
          interrupted_actor = ?,
          reconciled_at = ?,
          unavailable_at = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId,
        updated.workspaceRoot,
        updated.name,
        updated.program,
        JSON.stringify(updated.args),
        updated.paneId ?? null,
        updated.windowName,
        updated.status,
        updated.exitCode ?? null,
        updated.error ?? null,
        updated.interruptedAt ?? null,
        updated.interruptedActor ?? null,
        updated.reconciledAt ?? null,
        updated.unavailableAt ?? null,
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  close(): void {
    this.database.close();
  }

  private getById(id: string): LiveSessionRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from live_sessions where id = ?")
      .get(id) as LiveSessionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }
}

function rowToRecord(row: LiveSessionRow): LiveSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    name: row.name,
    program: row.program,
    args: readArgs(row.args_json),
    paneId: row.pane_id ?? undefined,
    windowName: row.window_name,
    status: readStatus(row.status),
    exitCode: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    interruptedAt: row.interrupted_at ?? undefined,
    interruptedActor: row.interrupted_actor ?? undefined,
    reconciledAt: row.reconciled_at ?? undefined,
    unavailableAt: row.unavailable_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readArgs(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to an explicit corrupted-state error.
  }
  throw new Error("Live session args state is invalid.");
}

function readStatus(status: string): LiveSessionStatus {
  if (
    status === "running"
    || status === "completed"
    || status === "failed"
    || status === "interrupted_by_user"
    || status === "interrupted_by_controller"
    || status === "unavailable"
  ) {
    return status;
  }
  return "failed";
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
