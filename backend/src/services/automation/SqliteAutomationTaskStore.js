import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["idle", "running", "error", "disabled"].includes(normalized)) {
    return normalized;
  }
  return "idle";
}

function normalizeTimeOfDay(value) {
  const normalized = normalizeText(value);
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return "09:00";
  }
  return normalized;
}

function normalizeTaskRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    name: normalizeText(row.name),
    prompt: String(row.prompt ?? ""),
    conversationId: normalizeText(row.conversation_id),
    workplacePath: normalizeText(row.workplace_path),
    enabled: Number(row.enabled ?? 0) === 1,
    timeOfDay: normalizeTimeOfDay(row.time_of_day),
    timezone: normalizeText(row.timezone) || "Asia/Shanghai",
    status: normalizeStatus(row.status),
    lastError: String(row.last_error ?? ""),
    lastRunAt: Number(row.last_run_at ?? 0),
    nextRunAt: Number(row.next_run_at ?? 0),
    runningSince: Number(row.running_since ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

export class SqliteAutomationTaskStore {
  constructor(options = {}) {
    this.dbFilePath = options.dbFilePath;
    this.dirPath = options.dirPath;
    this.db = null;
  }

  async initialize() {
    if (this.dirPath) {
      await fs.mkdir(this.dirPath, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbFilePath);
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        workplace_path TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        time_of_day TEXT NOT NULL DEFAULT '09:00',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT NOT NULL DEFAULT '',
        last_run_at INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL DEFAULT 0,
        running_since INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_automation_tasks_due
      ON automation_tasks(enabled, next_run_at, status);
    `);
    this.ensureWorkplacePathColumn();

    this.db
      .prepare(
        `
          UPDATE automation_tasks
          SET status = CASE WHEN enabled = 1 THEN 'idle' ELSE 'disabled' END,
              running_since = 0,
              updated_at = ?
          WHERE status = 'running'
        `
      )
      .run(Date.now());
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("automation task store is not initialized");
    }

    return this.db;
  }

  ensureWorkplacePathColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(automation_tasks)").all();
    const columnNames = new Set(columns.map((item) => String(item?.name ?? "")));
    if (columnNames.has("workplace_path")) {
      return;
    }

    db.exec("ALTER TABLE automation_tasks ADD COLUMN workplace_path TEXT NOT NULL DEFAULT ''");
  }

  listTasks() {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
          SELECT *
          FROM automation_tasks
          ORDER BY updated_at DESC, created_at DESC, id ASC
        `
      )
      .all();

    return rows.map((row) => normalizeTaskRow(row)).filter(Boolean);
  }

  getTask(taskId) {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM automation_tasks WHERE id = ?")
      .get(normalizeText(taskId));
    return normalizeTaskRow(row);
  }

  createTask(options = {}) {
    const db = this.ensureDb();
    const id = normalizeText(options.id);
    const name = normalizeText(options.name);
    const prompt = String(options.prompt ?? "").trim();

    if (!id || !name || !prompt) {
      throw new Error("id, name and prompt are required");
    }

    const now = Number(options.createdAt ?? Date.now());
    const enabled = options.enabled !== false;
    const status = enabled ? "idle" : "disabled";

    db.prepare(
      `
        INSERT INTO automation_tasks (
          id,
          name,
          prompt,
          conversation_id,
          workplace_path,
          enabled,
          time_of_day,
          timezone,
          status,
          last_error,
          last_run_at,
          next_run_at,
          running_since,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, 0, ?, ?)
      `
    ).run(
      id,
      name,
      prompt,
      normalizeText(options.conversationId),
      normalizeText(options.workplacePath),
      enabled ? 1 : 0,
      normalizeTimeOfDay(options.timeOfDay),
      normalizeText(options.timezone) || "Asia/Shanghai",
      status,
      Number(options.nextRunAt ?? 0),
      now,
      now
    );

    return this.getTask(id);
  }

  updateTask(taskId, patch = {}) {
    const db = this.ensureDb();
    const existing = this.getTask(taskId);
    if (!existing) {
      return null;
    }

    const nextEnabled = Object.prototype.hasOwnProperty.call(patch, "enabled")
      ? Boolean(patch.enabled)
      : existing.enabled;
    const nextStatus = nextEnabled
      ? (existing.status === "running" ? "running" : normalizeStatus(patch.status || "idle"))
      : "disabled";
    const nextUpdatedAt = Number(patch.updatedAt ?? Date.now());

    db.prepare(
      `
        UPDATE automation_tasks
        SET
          name = ?,
          prompt = ?,
          conversation_id = ?,
          workplace_path = ?,
          enabled = ?,
          time_of_day = ?,
          timezone = ?,
          status = ?,
          last_error = ?,
          last_run_at = ?,
          next_run_at = ?,
          running_since = ?,
          updated_at = ?
        WHERE id = ?
      `
    ).run(
      normalizeText(patch.name ?? existing.name) || existing.name,
      String(patch.prompt ?? existing.prompt),
      normalizeText(patch.conversationId ?? existing.conversationId),
      normalizeText(patch.workplacePath ?? existing.workplacePath),
      nextEnabled ? 1 : 0,
      normalizeTimeOfDay(patch.timeOfDay ?? existing.timeOfDay),
      normalizeText(patch.timezone ?? existing.timezone) || "Asia/Shanghai",
      nextStatus,
      String(patch.lastError ?? existing.lastError),
      Number(patch.lastRunAt ?? existing.lastRunAt),
      Number(patch.nextRunAt ?? existing.nextRunAt),
      Number(patch.runningSince ?? (nextStatus === "running" ? existing.runningSince : 0)),
      nextUpdatedAt,
      normalizeText(taskId)
    );

    return this.getTask(taskId);
  }

  deleteTask(taskId) {
    const db = this.ensureDb();
    const normalizedTaskId = normalizeText(taskId);
    if (!normalizedTaskId) {
      return false;
    }

    const result = db.prepare("DELETE FROM automation_tasks WHERE id = ?").run(normalizedTaskId);
    return Number(result?.changes ?? 0) > 0;
  }

  listDueTasks(now = Date.now(), limit = 10) {
    const db = this.ensureDb();
    const numericNow = Number(now ?? Date.now());
    const numericLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 10;

    const rows = db
      .prepare(
        `
          SELECT *
          FROM automation_tasks
          WHERE enabled = 1
            AND status <> 'running'
            AND next_run_at > 0
            AND next_run_at <= ?
          ORDER BY next_run_at ASC, updated_at ASC
          LIMIT ?
        `
      )
      .all(numericNow, numericLimit);

    return rows.map((row) => normalizeTaskRow(row)).filter(Boolean);
  }

  markTaskRunning(taskId, options = {}) {
    const db = this.ensureDb();
    const normalizedTaskId = normalizeText(taskId);
    if (!normalizedTaskId) {
      return false;
    }

    const now = Number(options.now ?? Date.now());
    const nextRunAt = Number(options.nextRunAt ?? 0);

    const result = db.prepare(
      `
        UPDATE automation_tasks
        SET
          status = 'running',
          running_since = ?,
          next_run_at = CASE WHEN ? > 0 THEN ? ELSE next_run_at END,
          last_error = '',
          updated_at = ?
        WHERE id = ?
          AND enabled = 1
          AND status <> 'running'
      `
    ).run(now, nextRunAt, nextRunAt, now, normalizedTaskId);

    return Number(result?.changes ?? 0) > 0;
  }

  finishTaskRun(taskId, options = {}) {
    const db = this.ensureDb();
    const normalizedTaskId = normalizeText(taskId);
    if (!normalizedTaskId) {
      return null;
    }

    const existing = this.getTask(normalizedTaskId);
    if (!existing) {
      return null;
    }

    const now = Number(options.now ?? Date.now());
    const success = options.success !== false;
    const status = existing.enabled ? (success ? "idle" : "error") : "disabled";

    db.prepare(
      `
        UPDATE automation_tasks
        SET
          status = ?,
          running_since = 0,
          last_error = ?,
          last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END,
          updated_at = ?
        WHERE id = ?
      `
    ).run(
      status,
      success ? "" : String(options.errorMessage ?? "automation run failed"),
      success ? 1 : 0,
      now,
      now,
      normalizedTaskId
    );

    return this.getTask(normalizedTaskId);
  }
}
