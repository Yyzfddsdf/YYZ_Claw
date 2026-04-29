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

function normalizeTemplateRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    name: normalizeText(row.name),
    prompt: String(row.prompt ?? ""),
    bindingCount: Number(row.binding_count ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

function normalizeBindingRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    templateId: normalizeText(row.template_id),
    templateName: normalizeText(row.template_name),
    templatePrompt: String(row.template_prompt ?? ""),
    conversationId: normalizeText(row.conversation_id),
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
    this.createTables();
    this.resetRunningBindings();
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("automation task store is not initialized");
    }

    return this.db;
  }

  createTables() {
    const db = this.ensureDb();

    db.exec("DROP TABLE IF EXISTS automation_tasks;");

    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_bindings (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        time_of_day TEXT NOT NULL DEFAULT '09:00',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT NOT NULL DEFAULT '',
        last_run_at INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL DEFAULT 0,
        running_since INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(template_id) REFERENCES automation_templates(id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_automation_bindings_due
      ON automation_bindings(enabled, next_run_at, status);
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_automation_bindings_template
      ON automation_bindings(template_id);
    `);
  }

  resetRunningBindings() {
    const db = this.ensureDb();
    db.prepare(
      `
        UPDATE automation_bindings
        SET status = CASE WHEN enabled = 1 THEN 'idle' ELSE 'disabled' END,
            running_since = 0,
            updated_at = ?
        WHERE status = 'running'
      `
    ).run(Date.now());
  }

  listTasks() {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
          SELECT
            t.*,
            COUNT(b.id) AS binding_count
          FROM automation_templates t
          LEFT JOIN automation_bindings b ON b.template_id = t.id
          GROUP BY t.id
          ORDER BY t.updated_at DESC, t.created_at DESC, t.id ASC
        `
      )
      .all();

    return rows.map((row) => normalizeTemplateRow(row)).filter(Boolean);
  }

  getTask(taskId) {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
          SELECT
            t.*,
            COUNT(b.id) AS binding_count
          FROM automation_templates t
          LEFT JOIN automation_bindings b ON b.template_id = t.id
          WHERE t.id = ?
          GROUP BY t.id
        `
      )
      .get(normalizeText(taskId));
    return normalizeTemplateRow(row);
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
    db.prepare(
      `
        INSERT INTO automation_templates (id, name, prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run(id, name, prompt, now, now);

    return this.getTask(id);
  }

  updateTask(taskId, patch = {}) {
    const db = this.ensureDb();
    const existing = this.getTask(taskId);
    if (!existing) {
      return null;
    }

    const nextUpdatedAt = Number(patch.updatedAt ?? Date.now());
    db.prepare(
      `
        UPDATE automation_templates
        SET name = ?, prompt = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(
      normalizeText(patch.name ?? existing.name) || existing.name,
      String(patch.prompt ?? existing.prompt),
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

    const result = db
      .prepare("DELETE FROM automation_templates WHERE id = ?")
      .run(normalizedTaskId);
    return Number(result?.changes ?? 0) > 0;
  }

  listBindings() {
    const db = this.ensureDb();
    const rows = db
      .prepare(
        `
          SELECT
            b.*,
            t.name AS template_name,
            t.prompt AS template_prompt
          FROM automation_bindings b
          JOIN automation_templates t ON t.id = b.template_id
          ORDER BY b.updated_at DESC, b.created_at DESC, b.id ASC
        `
      )
      .all();

    return rows.map((row) => normalizeBindingRow(row)).filter(Boolean);
  }

  getBinding(bindingId) {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
          SELECT
            b.*,
            t.name AS template_name,
            t.prompt AS template_prompt
          FROM automation_bindings b
          JOIN automation_templates t ON t.id = b.template_id
          WHERE b.id = ?
        `
      )
      .get(normalizeText(bindingId));
    return normalizeBindingRow(row);
  }

  getBindingByConversationId(conversationId) {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
          SELECT
            b.*,
            t.name AS template_name,
            t.prompt AS template_prompt
          FROM automation_bindings b
          JOIN automation_templates t ON t.id = b.template_id
          WHERE b.conversation_id = ?
        `
      )
      .get(normalizeText(conversationId));
    return normalizeBindingRow(row);
  }

  upsertBinding(options = {}) {
    const db = this.ensureDb();
    const templateId = normalizeText(options.templateId);
    const conversationId = normalizeText(options.conversationId);
    if (!templateId || !conversationId) {
      throw new Error("templateId and conversationId are required");
    }

    const template = this.getTask(templateId);
    if (!template) {
      return null;
    }

    const existing = this.getBindingByConversationId(conversationId);
    const now = Number(options.updatedAt ?? Date.now());
    const enabled = Object.prototype.hasOwnProperty.call(options, "enabled")
      ? Boolean(options.enabled)
      : existing?.enabled ?? true;
    const status = enabled ? (existing?.status === "running" ? "running" : "idle") : "disabled";
    const bindingId = existing?.id || normalizeText(options.id) || `auto_bind_${cryptoRandomSuffix()}`;

    if (existing) {
      db.prepare(
        `
          UPDATE automation_bindings
          SET
            template_id = ?,
            enabled = ?,
            time_of_day = ?,
            timezone = ?,
            status = ?,
            next_run_at = ?,
            updated_at = ?
          WHERE conversation_id = ?
        `
      ).run(
        templateId,
        enabled ? 1 : 0,
        normalizeTimeOfDay(options.timeOfDay ?? existing.timeOfDay),
        normalizeText(options.timezone ?? existing.timezone) || "Asia/Shanghai",
        status,
        Number(options.nextRunAt ?? existing.nextRunAt ?? 0),
        now,
        conversationId
      );
      return this.getBinding(existing.id);
    }

    db.prepare(
      `
        INSERT INTO automation_bindings (
          id,
          template_id,
          conversation_id,
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
        VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, 0, ?, ?)
      `
    ).run(
      bindingId,
      templateId,
      conversationId,
      enabled ? 1 : 0,
      normalizeTimeOfDay(options.timeOfDay),
      normalizeText(options.timezone) || "Asia/Shanghai",
      status,
      Number(options.nextRunAt ?? 0),
      now,
      now
    );

    return this.getBinding(bindingId);
  }

  updateBinding(bindingId, patch = {}) {
    const db = this.ensureDb();
    const existing = this.getBinding(bindingId);
    if (!existing) {
      return null;
    }

    return this.upsertBinding({
      id: existing.id,
      templateId: patch.templateId ?? existing.templateId,
      conversationId: existing.conversationId,
      enabled: Object.prototype.hasOwnProperty.call(patch, "enabled")
        ? patch.enabled
        : existing.enabled,
      timeOfDay: patch.timeOfDay ?? existing.timeOfDay,
      timezone: patch.timezone ?? existing.timezone,
      nextRunAt: Object.prototype.hasOwnProperty.call(patch, "nextRunAt")
        ? patch.nextRunAt
        : existing.nextRunAt,
      updatedAt: patch.updatedAt ?? Date.now()
    });
  }

  deleteBinding(bindingId) {
    const db = this.ensureDb();
    const normalizedBindingId = normalizeText(bindingId);
    if (!normalizedBindingId) {
      return false;
    }

    const result = db
      .prepare("DELETE FROM automation_bindings WHERE id = ?")
      .run(normalizedBindingId);
    return Number(result?.changes ?? 0) > 0;
  }

  deleteBindingByConversationId(conversationId) {
    const db = this.ensureDb();
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) {
      return false;
    }

    const result = db
      .prepare("DELETE FROM automation_bindings WHERE conversation_id = ?")
      .run(normalizedConversationId);
    return Number(result?.changes ?? 0) > 0;
  }

  listDueTasks(now = Date.now(), limit = 10) {
    const db = this.ensureDb();
    const numericNow = Number(now ?? Date.now());
    const numericLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 10;

    const rows = db
      .prepare(
        `
          SELECT
            b.*,
            t.name AS template_name,
            t.prompt AS template_prompt
          FROM automation_bindings b
          JOIN automation_templates t ON t.id = b.template_id
          WHERE b.enabled = 1
            AND b.status <> 'running'
            AND b.next_run_at > 0
            AND b.next_run_at <= ?
          ORDER BY b.next_run_at ASC, b.updated_at ASC
          LIMIT ?
        `
      )
      .all(numericNow, numericLimit);

    return rows.map((row) => normalizeBindingRow(row)).filter(Boolean);
  }

  markTaskRunning(bindingId, options = {}) {
    const db = this.ensureDb();
    const normalizedBindingId = normalizeText(bindingId);
    if (!normalizedBindingId) {
      return false;
    }

    const now = Number(options.now ?? Date.now());
    const nextRunAt = Number(options.nextRunAt ?? 0);
    const force = options.force === true ? 1 : 0;

    const result = db.prepare(
      `
        UPDATE automation_bindings
        SET
          status = 'running',
          running_since = ?,
          next_run_at = CASE WHEN ? > 0 THEN ? ELSE next_run_at END,
          last_error = '',
          updated_at = ?
        WHERE id = ?
          AND (enabled = 1 OR ? = 1)
          AND status <> 'running'
      `
    ).run(now, nextRunAt, nextRunAt, now, normalizedBindingId, force);

    return Number(result?.changes ?? 0) > 0;
  }

  finishTaskRun(bindingId, options = {}) {
    const db = this.ensureDb();
    const normalizedBindingId = normalizeText(bindingId);
    if (!normalizedBindingId) {
      return null;
    }

    const existing = this.getBinding(normalizedBindingId);
    if (!existing) {
      return null;
    }

    const now = Number(options.now ?? Date.now());
    const success = options.success !== false;
    const status = existing.enabled ? (success ? "idle" : "error") : "disabled";

    db.prepare(
      `
        UPDATE automation_bindings
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
      normalizedBindingId
    );

    return this.getBinding(normalizedBindingId);
  }
}

function cryptoRandomSuffix() {
  return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}
