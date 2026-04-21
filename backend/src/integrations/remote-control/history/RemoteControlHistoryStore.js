import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

function normalizeJsonText(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createMessageId(prefix = "remote_message") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
        return null;
      }

      const id = String(toolCall?.id ?? "").trim();
      const functionName = String(toolCall?.function?.name ?? "").trim();
      if (!id || !functionName) {
        return null;
      }

      return {
        id,
        type: "function",
        function: {
          name: functionName,
          arguments: String(toolCall?.function?.arguments ?? "{}")
        }
      };
    })
    .filter(Boolean);
}

function normalizeMessageRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  if (role === "assistant" || role === "user" || role === "tool" || role === "system") {
    return role;
  }
  return "assistant";
}

function normalizeMessageSource(value) {
  const source = String(value ?? "").trim().toLowerCase();
  if (source === "user" || source === "assistant" || source === "tool" || source === "runtime_hook") {
    return source;
  }
  return "system";
}

function normalizeMessageMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }

  return {
    ...meta
  };
}

function normalizeMessageInput(message = {}) {
  const role = normalizeMessageRole(message.role);
  const source =
    String(message.source ?? "").trim().length > 0
      ? normalizeMessageSource(message.source)
      : role === "assistant"
        ? "assistant"
        : role === "user"
          ? "user"
          : role === "tool"
            ? "tool"
            : "system";

  return {
    id: String(message.id ?? createMessageId("remote_record")).trim() || createMessageId("remote_record"),
    source,
    role,
    providerKey: normalizeProviderKey(message.providerKey),
    content: String(message.content ?? ""),
    reasoningContent: String(message.reasoningContent ?? ""),
    toolCallId: String(message.toolCallId ?? "").trim(),
    toolName: String(message.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message.toolCalls),
    meta: normalizeMessageMeta(message.meta),
    timestamp: Number(message.timestamp ?? Date.now())
  };
}

function normalizeTurnStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "completed" || normalized === "failed") {
    return normalized;
  }
  return "open";
}

function buildUserModelContent(message) {
  const meta = normalizeMessageMeta(message.meta);
  const textBlocks = [];
  const baseText = String(message.content ?? "").trim();
  if (baseText) {
    textBlocks.push(baseText);
  }

  const parsedFiles = Array.isArray(meta.parsedFiles) ? meta.parsedFiles : [];
  if (parsedFiles.length > 0) {
    const fileSections = parsedFiles
      .map((file, index) => {
        const fileName = String(file?.name ?? `file_${index + 1}`).trim() || `file_${index + 1}`;
        const extractedText = String(file?.extractedText ?? "").trim();
        const note = String(file?.note ?? "").trim();
        if (extractedText) {
          return `【文件:${fileName}】\n${extractedText}`;
        }
        if (note) {
          return `【文件:${fileName}】\n${note}`;
        }
        return "";
      })
      .filter(Boolean);

    if (fileSections.length > 0) {
      textBlocks.push(fileSections.join("\n\n"));
    }
  }

  const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  const imageAttachments = attachments
    .map((attachment, index) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return null;
      }

      const dataUrl = String(attachment.dataUrl ?? attachment.url ?? "").trim();
      const mimeType = String(attachment.mimeType ?? "").trim().toLowerCase();
      if (!dataUrl || !mimeType.startsWith("image/")) {
        return null;
      }

      return {
        id: String(attachment.id ?? `image_${index + 1}`).trim() || `image_${index + 1}`,
        dataUrl
      };
    })
    .filter(Boolean);

  if (imageAttachments.length === 0) {
    return textBlocks.join("\n\n");
  }

  const contentParts = [];
  const mergedText = textBlocks.join("\n\n").trim();
  if (mergedText) {
    contentParts.push({
      type: "text",
      text: mergedText
    });
  }

  for (const image of imageAttachments) {
    contentParts.push({
      type: "image_url",
      image_url: {
        url: image.dataUrl
      }
    });
  }

  return contentParts;
}

export class RemoteControlHistoryStore {
  constructor(options = {}) {
    this.dbFilePath = String(options.dbFilePath ?? "").trim();
    this.dirPath = String(options.dirPath ?? "").trim();
    this.db = null;
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("remote control history db is not initialized");
    }
    return this.db;
  }

  async initialize() {
    if (!this.dbFilePath) {
      throw new Error("dbFilePath is required");
    }

    if (this.dirPath) {
      await fs.mkdir(this.dirPath, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbFilePath);
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_control_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_key TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        user_message_count INTEGER NOT NULL DEFAULT 0,
        assistant_message_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_remote_turns_provider_status_updated
      ON remote_control_turns(provider_key, status, updated_at DESC, id DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_control_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        turn_id INTEGER NOT NULL,
        provider_key TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'system',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning_content TEXT NOT NULL DEFAULT '',
        tool_call_id TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(turn_id) REFERENCES remote_control_turns(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_remote_messages_turn_seq
      ON remote_control_messages(turn_id, seq);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_remote_messages_provider_seq_desc
      ON remote_control_messages(provider_key, seq DESC);
    `);
  }

  beginTurn(options = {}) {
    const db = this.ensureDb();
    const now = Number(options.createdAt ?? Date.now());
    const providerKey = normalizeProviderKey(options.providerKey ?? options.source);

    const result = db
      .prepare(
        `
          INSERT INTO remote_control_turns (
            provider_key,
            status,
            user_message_count,
            assistant_message_count,
            created_at,
            updated_at,
            closed_at
          )
          VALUES (?, 'open', 0, 0, ?, ?, 0)
        `
      )
      .run(providerKey, now, now);

    const turnId = Number(result.lastInsertRowid ?? 0);
    if (!Number.isInteger(turnId) || turnId <= 0) {
      throw new Error("failed to create remote control turn");
    }

    return this.getTurnById(turnId);
  }

  getTurnById(turnId) {
    const db = this.ensureDb();
    const numericTurnId = Number(turnId ?? 0);
    if (!Number.isInteger(numericTurnId) || numericTurnId <= 0) {
      return null;
    }

    const row = db
      .prepare(
        `
          SELECT
            id,
            provider_key,
            status,
            user_message_count,
            assistant_message_count,
            created_at,
            updated_at,
            closed_at
          FROM remote_control_turns
          WHERE id = ?
        `
      )
      .get(numericTurnId);

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      providerKey: normalizeProviderKey(row.provider_key),
      status: normalizeTurnStatus(row.status),
      userMessageCount: Number(row.user_message_count ?? 0),
      assistantMessageCount: Number(row.assistant_message_count ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      closedAt: Number(row.closed_at ?? 0)
    };
  }

  appendMessages(turnId, messages = []) {
    const db = this.ensureDb();
    const numericTurnId = Number(turnId ?? 0);
    if (!Number.isInteger(numericTurnId) || numericTurnId <= 0) {
      throw new Error("turnId is required");
    }

    const existingTurn = this.getTurnById(numericTurnId);
    if (!existingTurn) {
      throw new Error(`remote control turn not found: ${numericTurnId}`);
    }

    const normalizedMessages = Array.isArray(messages)
      ? messages.map((item) =>
          normalizeMessageInput({
            ...item,
            providerKey: item?.providerKey ?? existingTurn.providerKey
          })
        )
      : [];
    if (normalizedMessages.length === 0) {
      return [];
    }

    const now = Date.now();
    const insertStmt = db.prepare(
      `
        INSERT INTO remote_control_messages (
          id,
          turn_id,
          provider_key,
          source,
          role,
          content,
          reasoning_content,
          tool_call_id,
          tool_name,
          tool_calls_json,
          meta_json,
          timestamp,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    let userIncrement = 0;
    let assistantIncrement = 0;

    db.exec("BEGIN TRANSACTION");
    try {
      for (const message of normalizedMessages) {
        if (message.role === "user") {
          userIncrement += 1;
        } else if (message.role === "assistant") {
          assistantIncrement += 1;
        }

        insertStmt.run(
          message.id,
          numericTurnId,
          message.providerKey || existingTurn.providerKey,
          message.source,
          message.role,
          message.content,
          message.reasoningContent,
          message.toolCallId,
          message.toolName,
          message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : "",
          Object.keys(message.meta).length > 0 ? JSON.stringify(message.meta) : "",
          message.timestamp,
          now
        );
      }

      db.prepare(
        `
          UPDATE remote_control_turns
          SET
            user_message_count = user_message_count + ?,
            assistant_message_count = assistant_message_count + ?,
            updated_at = ?
          WHERE id = ?
        `
      ).run(userIncrement, assistantIncrement, now, numericTurnId);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return normalizedMessages.map((message) => ({
      ...message,
      turnId: numericTurnId
    }));
  }

  closeTurn(turnId, options = {}) {
    const db = this.ensureDb();
    const numericTurnId = Number(turnId ?? 0);
    if (!Number.isInteger(numericTurnId) || numericTurnId <= 0) {
      return null;
    }

    const now = Number(options.closedAt ?? Date.now());
    const status = normalizeTurnStatus(options.status);

    db.prepare(
      `
        UPDATE remote_control_turns
        SET
          status = ?,
          updated_at = ?,
          closed_at = ?
        WHERE id = ?
      `
    ).run(status, now, now, numericTurnId);

    return this.getTurnById(numericTurnId);
  }

  getRecentCompleteTurnIds(limit = 30, providerKey = "") {
    const db = this.ensureDb();
    const numericLimit = Number.isInteger(limit) && limit > 0 ? limit : 30;
    const normalizedProvider = normalizeProviderKey(providerKey);

    const rows =
      normalizedProvider.length > 0
        ? db
            .prepare(
              `
                SELECT id
                FROM remote_control_turns
                WHERE provider_key = ?
                  AND status IN ('completed', 'failed')
                ORDER BY id DESC
                LIMIT ?
              `
            )
            .all(normalizedProvider, numericLimit)
        : db
            .prepare(
              `
                SELECT id
                FROM remote_control_turns
                WHERE status IN ('completed', 'failed')
                ORDER BY id DESC
                LIMIT ?
              `
            )
            .all(numericLimit);

    return rows
      .map((row) => Number(row?.id ?? 0))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);
  }

  getMessagesByTurnIds(turnIds = [], options = {}) {
    const db = this.ensureDb();
    const normalizedTurnIds = Array.isArray(turnIds)
      ? turnIds
          .map((item) => Number(item ?? 0))
          .filter((item) => Number.isInteger(item) && item > 0)
      : [];
    if (normalizedTurnIds.length === 0) {
      return [];
    }

    const providerKey = normalizeProviderKey(options.providerKey);
    const placeholders = normalizedTurnIds.map(() => "?").join(", ");
    const rows =
      providerKey.length > 0
        ? db
            .prepare(
              `
                SELECT
                  seq,
                  id,
                  turn_id,
                  provider_key,
                  source,
                  role,
                  content,
                  reasoning_content,
                  tool_call_id,
                  tool_name,
                  tool_calls_json,
                  meta_json,
                  timestamp,
                  created_at
                FROM remote_control_messages
                WHERE turn_id IN (${placeholders})
                  AND provider_key = ?
                ORDER BY turn_id ASC, seq ASC
              `
            )
            .all(...normalizedTurnIds, providerKey)
        : db
            .prepare(
              `
                SELECT
                  seq,
                  id,
                  turn_id,
                  provider_key,
                  source,
                  role,
                  content,
                  reasoning_content,
                  tool_call_id,
                  tool_name,
                  tool_calls_json,
                  meta_json,
                  timestamp,
                  created_at
                FROM remote_control_messages
                WHERE turn_id IN (${placeholders})
                ORDER BY turn_id ASC, seq ASC
              `
            )
            .all(...normalizedTurnIds);

    return rows.map((row) => ({
      seq: Number(row.seq),
      id: String(row.id),
      turnId: Number(row.turn_id),
      providerKey: normalizeProviderKey(row.provider_key),
      source: normalizeMessageSource(row.source),
      role: normalizeMessageRole(row.role),
      content: String(row.content ?? ""),
      reasoningContent: String(row.reasoning_content ?? ""),
      toolCallId: String(row.tool_call_id ?? ""),
      toolName: String(row.tool_name ?? ""),
      toolCalls: normalizeToolCalls(normalizeJsonText(row.tool_calls_json, [])),
      meta: normalizeMessageMeta(normalizeJsonText(row.meta_json, {})),
      timestamp: Number(row.timestamp ?? 0),
      createdAt: Number(row.created_at ?? 0)
    }));
  }

  buildContextMessages(options = {}) {
    const currentTurnId = Number(options.currentTurnId ?? 0);
    const maxTurns = Number.isInteger(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : 30;
    const providerKey = normalizeProviderKey(options.providerKey);

    const completeTurnIds = this.getRecentCompleteTurnIds(maxTurns, providerKey);
    const selectedTurnIds = [...completeTurnIds];
    if (Number.isInteger(currentTurnId) && currentTurnId > 0 && !selectedTurnIds.includes(currentTurnId)) {
      selectedTurnIds.push(currentTurnId);
    }

    const storedMessages = this.getMessagesByTurnIds(selectedTurnIds, {
      providerKey
    });
    return storedMessages
      .map((message) => {
        if (message.role === "user") {
          return {
            role: "user",
            content: buildUserModelContent(message)
          };
        }

        if (message.role === "assistant") {
          return {
            role: "assistant",
            content: message.content,
            ...(message.toolCalls.length > 0 ? { tool_calls: message.toolCalls } : {})
          };
        }

        if (message.role === "tool") {
          const toolCallId = String(message.toolCallId ?? "").trim();
          if (!toolCallId) {
            return null;
          }

          return {
            role: "tool",
            tool_call_id: toolCallId,
            content: message.content
          };
        }

        if (message.role === "system") {
          return {
            role: "system",
            content: message.content
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  listRecords(options = {}) {
    const db = this.ensureDb();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    const cursor = Number(options.cursor ?? 0);
    const hasCursor = Number.isInteger(cursor) && cursor > 0;
    const providerKey = normalizeProviderKey(options.providerKey);

    const queryByProvider = providerKey.length > 0;
    const rows = hasCursor
      ? queryByProvider
        ? db
            .prepare(
              `
                SELECT
                  m.seq,
                  m.id,
                  m.turn_id,
                  m.provider_key,
                  m.source,
                  m.role,
                  m.content,
                  m.reasoning_content,
                  m.tool_call_id,
                  m.tool_name,
                  m.tool_calls_json,
                  m.meta_json,
                  m.timestamp,
                  m.created_at,
                  t.status AS turn_status
                FROM remote_control_messages AS m
                INNER JOIN remote_control_turns AS t ON t.id = m.turn_id
                WHERE m.provider_key = ?
                  AND m.seq < ?
                ORDER BY m.seq DESC
                LIMIT ?
              `
            )
            .all(providerKey, cursor, limit)
        : db
            .prepare(
              `
                SELECT
                  m.seq,
                  m.id,
                  m.turn_id,
                  m.provider_key,
                  m.source,
                  m.role,
                  m.content,
                  m.reasoning_content,
                  m.tool_call_id,
                  m.tool_name,
                  m.tool_calls_json,
                  m.meta_json,
                  m.timestamp,
                  m.created_at,
                  t.status AS turn_status
                FROM remote_control_messages AS m
                INNER JOIN remote_control_turns AS t ON t.id = m.turn_id
                WHERE m.seq < ?
                ORDER BY m.seq DESC
                LIMIT ?
              `
            )
            .all(cursor, limit)
      : queryByProvider
        ? db
            .prepare(
              `
                SELECT
                  m.seq,
                  m.id,
                  m.turn_id,
                  m.provider_key,
                  m.source,
                  m.role,
                  m.content,
                  m.reasoning_content,
                  m.tool_call_id,
                  m.tool_name,
                  m.tool_calls_json,
                  m.meta_json,
                  m.timestamp,
                  m.created_at,
                  t.status AS turn_status
                FROM remote_control_messages AS m
                INNER JOIN remote_control_turns AS t ON t.id = m.turn_id
                WHERE m.provider_key = ?
                ORDER BY m.seq DESC
                LIMIT ?
              `
            )
            .all(providerKey, limit)
        : db
            .prepare(
              `
                SELECT
                  m.seq,
                  m.id,
                  m.turn_id,
                  m.provider_key,
                  m.source,
                  m.role,
                  m.content,
                  m.reasoning_content,
                  m.tool_call_id,
                  m.tool_name,
                  m.tool_calls_json,
                  m.meta_json,
                  m.timestamp,
                  m.created_at,
                  t.status AS turn_status
                FROM remote_control_messages AS m
                INNER JOIN remote_control_turns AS t ON t.id = m.turn_id
                ORDER BY m.seq DESC
                LIMIT ?
              `
            )
            .all(limit);

    const records = rows.map((row) => ({
      seq: Number(row.seq ?? 0),
      id: String(row.id ?? ""),
      turnId: Number(row.turn_id ?? 0),
      turnStatus: normalizeTurnStatus(row.turn_status),
      providerKey: normalizeProviderKey(row.provider_key),
      source: normalizeMessageSource(row.source),
      role: normalizeMessageRole(row.role),
      content: String(row.content ?? ""),
      reasoningContent: String(row.reasoning_content ?? ""),
      toolCallId: String(row.tool_call_id ?? ""),
      toolName: String(row.tool_name ?? ""),
      toolCalls: normalizeToolCalls(normalizeJsonText(row.tool_calls_json, [])),
      meta: normalizeMessageMeta(normalizeJsonText(row.meta_json, {})),
      timestamp: Number(row.timestamp ?? 0),
      createdAt: Number(row.created_at ?? 0)
    }));

    const nextCursor = records.length === limit ? Number(records[records.length - 1].seq ?? 0) : null;
    return {
      records,
      nextCursor: nextCursor && nextCursor > 0 ? nextCursor : null
    };
  }
}
