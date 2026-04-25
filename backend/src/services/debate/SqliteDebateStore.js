import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function normalizeDebateRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    title: normalizeText(row.title),
    topic: String(row.topic ?? ""),
    objective: String(row.objective ?? ""),
    description: String(row.objective ?? ""),
    materials: safeJsonParse(row.materials_json, []),
    materialsText: String(row.materials_text ?? ""),
    status: normalizeText(row.status) || "completed",
    maxRounds: Number(row.max_rounds ?? 0),
    agreedBy: normalizeText(row.agreed_by),
    acceptedSide: normalizeText(row.accepted_side),
    finalSide: normalizeText(row.final_side),
    finalSummary: String(row.final_summary ?? ""),
    error: String(row.error ?? ""),
    turns: safeJsonParse(row.turns_json, []),
    messagesA: safeJsonParse(row.messages_a_json, []),
    messagesB: safeJsonParse(row.messages_b_json, []),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

export class SqliteDebateStore {
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS debates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT '',
        materials_json TEXT NOT NULL DEFAULT '[]',
        materials_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        max_rounds INTEGER NOT NULL DEFAULT 4,
        agreed_by TEXT NOT NULL DEFAULT '',
        accepted_side TEXT NOT NULL DEFAULT '',
        final_side TEXT NOT NULL DEFAULT '',
        final_summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        turns_json TEXT NOT NULL DEFAULT '[]',
        messages_a_json TEXT NOT NULL DEFAULT '[]',
        messages_b_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn("materials_text", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("messages_a_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("messages_b_json", "TEXT NOT NULL DEFAULT '[]'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debates_updated_at
      ON debates(updated_at DESC, created_at DESC);
    `);
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("debate store is not initialized");
    }
    return this.db;
  }

  ensureColumn(columnName, definition) {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(debates)").all();
    const hasColumn = columns.some((column) => normalizeText(column?.name) === columnName);
    if (!hasColumn) {
      db.exec(`ALTER TABLE debates ADD COLUMN ${columnName} ${definition}`);
    }
  }

  createDebate(debate) {
    const db = this.ensureDb();
    const now = Number(debate.createdAt ?? Date.now());
    db.prepare(
      `
        INSERT INTO debates (
          id, title, topic, objective, materials_json, status, max_rounds,
          agreed_by, accepted_side, final_side, final_summary, error,
          turns_json, materials_text, messages_a_json, messages_b_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '[]', ?, ?, ?, ?, ?)
      `
    ).run(
      normalizeText(debate.id),
      normalizeText(debate.title),
      String(debate.topic ?? ""),
      String(debate.objective ?? ""),
      JSON.stringify(Array.isArray(debate.materials) ? debate.materials : []),
      normalizeText(debate.status) || "running",
      Number(debate.maxRounds ?? 4),
      String(debate.materialsText ?? ""),
      JSON.stringify(Array.isArray(debate.messagesA) ? debate.messagesA : []),
      JSON.stringify(Array.isArray(debate.messagesB) ? debate.messagesB : []),
      now,
      now
    );

    return this.getDebate(debate.id);
  }

  listDebates() {
    const db = this.ensureDb();
    return db
      .prepare(
        `
          SELECT *
          FROM debates
          ORDER BY updated_at DESC, created_at DESC, id ASC
        `
      )
      .all()
      .map((row) => normalizeDebateRow(row))
      .filter(Boolean);
  }

  getDebate(id) {
    const db = this.ensureDb();
    const row = db.prepare("SELECT * FROM debates WHERE id = ?").get(normalizeText(id));
    return normalizeDebateRow(row);
  }

  updateDebate(id, patch = {}) {
    const existing = this.getDebate(id);
    if (!existing) {
      return null;
    }

    const next = {
      ...existing,
      ...patch,
      updatedAt: Number(patch.updatedAt ?? Date.now())
    };
    const db = this.ensureDb();
    db.prepare(
      `
        UPDATE debates
        SET
          title = ?,
          topic = ?,
          objective = ?,
          materials_json = ?,
          materials_text = ?,
          status = ?,
          max_rounds = ?,
          agreed_by = ?,
          accepted_side = ?,
          final_side = ?,
          final_summary = ?,
          error = ?,
          turns_json = ?,
          messages_a_json = ?,
          messages_b_json = ?,
          updated_at = ?
        WHERE id = ?
      `
    ).run(
      normalizeText(next.title),
      String(next.topic ?? ""),
      String(next.objective ?? ""),
      JSON.stringify(Array.isArray(next.materials) ? next.materials : []),
      String(next.materialsText ?? ""),
      normalizeText(next.status) || "completed",
      Number(next.maxRounds ?? 4),
      normalizeText(next.agreedBy),
      normalizeText(next.acceptedSide),
      normalizeText(next.finalSide),
      String(next.finalSummary ?? ""),
      String(next.error ?? ""),
      JSON.stringify(Array.isArray(next.turns) ? next.turns : []),
      JSON.stringify(Array.isArray(next.messagesA) ? next.messagesA : []),
      JSON.stringify(Array.isArray(next.messagesB) ? next.messagesB : []),
      next.updatedAt,
      normalizeText(id)
    );

    return this.getDebate(id);
  }

  deleteDebate(id) {
    const existing = this.getDebate(id);
    if (!existing) {
      return null;
    }

    this.ensureDb().prepare("DELETE FROM debates WHERE id = ?").run(normalizeText(id));
    return existing;
  }
}
