import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

function clipText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function buildTitleFromMessages(messages) {
  const firstUserMessage = messages.find(
    (item) => item.role === "user" && item.content.trim().length > 0
  );

  const fallbackMessage = messages.find((item) => item.content.trim().length > 0);
  const source = firstUserMessage?.content ?? fallbackMessage?.content ?? "未命名会话";

  return clipText(source.trim(), 32);
}

function buildPreviewFromMessages(messages) {
  const lastNonEmpty = [...messages]
    .reverse()
    .find((item) => {
      const content = String(item?.content ?? "").trim();
      const kind = String(item?.meta?.kind ?? "").trim();
      const attachments = Array.isArray(item?.meta?.attachments) ? item.meta.attachments : [];
      return (
        (content.length > 0 || attachments.length > 0) &&
        kind !== "compression_summary" &&
        kind !== "tool_event"
      );
    });

  const kind = String(lastNonEmpty?.meta?.kind ?? "").trim();
  const attachments = Array.isArray(lastNonEmpty?.meta?.attachments)
    ? lastNonEmpty.meta.attachments
    : [];

  if (kind === "tool_image_input") {
    const toolName = String(lastNonEmpty?.meta?.toolName ?? "").trim();
    const label = toolName ? `工具看图(${toolName})` : "工具看图";
    return attachments.length > 0 ? `${label} [图片 ${attachments.length}]` : label;
  }

  const content = String(lastNonEmpty?.content ?? "").trim();
  if (content.length > 0) {
    return clipText(content, 80);
  }

  return attachments.length > 0 ? `[图片 ${attachments.length}]` : "";
}

function normalizeMessage(item, index) {
  const toolCalls = Array.isArray(item?.toolCalls)
    ? item.toolCalls
        .map((toolCall) => {
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
        .filter(Boolean)
    : [];
  const meta =
    item?.meta && typeof item.meta === "object" && !Array.isArray(item.meta)
      ? item.meta
      : {};
  const tokenUsage = normalizeTokenUsage(item?.tokenUsage);

  return {
    id: String(item.id),
    role: String(item.role),
    content: String(item.content ?? ""),
    reasoningContent: String(item.reasoningContent ?? ""),
    timestamp: Number(item.timestamp ?? Date.now()),
    sortIndex: index,
    toolCallId: String(item.toolCallId ?? "").trim(),
    toolName: String(item.toolName ?? "").trim(),
    toolCalls,
    meta,
    tokenUsage
  };
}

function normalizeApprovalMode(value) {
  return String(value ?? "").trim() === "auto" ? "auto" : "confirm";
}

function normalizeThinkingMode(value) {
  const normalized = String(value ?? "").trim();
  return ["off", "default", "low", "medium", "high", "xhigh", "max"].includes(normalized)
    ? normalized
    : "off";
}

function normalizeSkillNames(value) {
  const list = Array.isArray(value) ? value : [];
  const normalized = [];
  const seen = new Set();

  for (const item of list) {
    const skillName = String(item ?? "").trim();
    if (!skillName) {
      continue;
    }

    const lookupKey = skillName.toLowerCase();
    if (seen.has(lookupKey)) {
      continue;
    }

    seen.add(lookupKey);
    normalized.push(skillName);
  }

  return normalized;
}

function normalizeToolNames(value) {
  const list = Array.isArray(value) ? value : [];
  const normalized = [];
  const seen = new Set();

  for (const item of list) {
    const toolName = String(item ?? "").trim();
    if (!toolName) {
      continue;
    }

    if (seen.has(toolName)) {
      continue;
    }

    seen.add(toolName);
    normalized.push(toolName);
  }

  return normalized;
}

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

function normalizeFtsMetaKind(meta) {
  const kind = String(meta?.kind ?? "").trim();
  if (kind === "compression_summary" || kind === "tool_event") {
    return kind;
  }
  return "";
}

function upsertConversationMessageFtsRow(db, seq, message) {
  const numericSeq = Number(seq ?? 0);
  if (!Number.isInteger(numericSeq) || numericSeq <= 0) {
    return;
  }

  db.prepare("DELETE FROM conversation_messages_fts WHERE rowid = ?").run(numericSeq);
  db.prepare(
    `
      INSERT INTO conversation_messages_fts(rowid, content, conversation_id, role, meta_kind)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(
    numericSeq,
    String(message?.content ?? ""),
    String(message?.conversationId ?? "").trim(),
    String(message?.role ?? "assistant").trim() || "assistant",
    normalizeFtsMetaKind(message?.meta)
  );
}

function sanitizeFts5Query(query) {
  const source = String(query ?? "").trim();
  if (!source) {
    return "";
  }

  const quotedParts = [];
  let sanitized = source.replace(/"[^"]*"/g, (match) => {
    const placeholder = `\u0000Q${quotedParts.length}\u0000`;
    quotedParts.push(match);
    return placeholder;
  });

  sanitized = sanitized.replace(/[+{}()^"]/g, " ");
  sanitized = sanitized.replace(/\*+/g, "*");
  sanitized = sanitized.replace(/(^|\s)\*/g, "$1");
  sanitized = sanitized.replace(/^(AND|OR|NOT)\b\s*/i, "");
  sanitized = sanitized.replace(/\s+(AND|OR|NOT)\s*$/i, "");
  sanitized = sanitized.replace(/\b(\w+(?:[.-]\w+)+)\b/g, "\"$1\"");

  for (let index = 0; index < quotedParts.length; index += 1) {
    sanitized = sanitized.replace(`\u0000Q${index}\u0000`, quotedParts[index]);
  }

  return sanitized.trim();
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const promptTokens = Number(value.promptTokens ?? 0);
  const completionTokens = Number(value.completionTokens ?? 0);
  const totalTokens = Number(value.totalTokens ?? promptTokens + completionTokens);

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens,
    promptTokensDetails:
      value.promptTokensDetails && typeof value.promptTokensDetails === "object"
        ? value.promptTokensDetails
        : null,
    completionTokensDetails:
      value.completionTokensDetails && typeof value.completionTokensDetails === "object"
        ? value.completionTokensDetails
        : null
  };
}

function normalizeTokenUsageRow(row) {
  if (!row) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      usageCount: 0,
      lastUsedAt: 0
    };
  }

  return {
    promptTokens: Number(row.token_prompt_total ?? 0),
    completionTokens: Number(row.token_completion_total ?? 0),
    totalTokens: Number(row.token_total_total ?? 0),
    usageCount: Number(row.token_usage_count ?? 0),
    lastUsedAt: Number(row.token_last_used_at ?? 0)
  };
}

function buildMessageMergeKey(message, index, namespace) {
  const normalizedId = String(message?.id ?? "").trim();
  if (normalizedId) {
    return normalizedId;
  }

  const normalizedNamespace = String(namespace ?? "message").trim() || "message";
  return `${normalizedNamespace}_${index}_${String(message?.role ?? "").trim()}_${Number(message?.timestamp ?? 0)}`;
}

function mergeMessageSnapshots(baseMessages, overlayMessages) {
  const normalizedBase = Array.isArray(baseMessages)
    ? baseMessages.map((item, index) => normalizeMessage(item, index))
    : [];
  const normalizedOverlay = Array.isArray(overlayMessages)
    ? overlayMessages.map((item, index) => normalizeMessage(item, index))
    : [];

  if (normalizedBase.length === 0) {
    return normalizedOverlay.map((item, index) => normalizeMessage(item, index));
  }

  if (normalizedOverlay.length === 0) {
    return normalizedBase.map((item, index) => normalizeMessage(item, index));
  }

  const overlayByKey = new Map();
  const overlayOrder = [];

  normalizedOverlay.forEach((message, index) => {
    const key = buildMessageMergeKey(message, index, "overlay");
    if (!overlayByKey.has(key)) {
      overlayOrder.push(key);
    }
    overlayByKey.set(key, message);
  });

  const merged = [];
  const seenKeys = new Set();

  normalizedBase.forEach((message, index) => {
    const key = buildMessageMergeKey(message, index, "base");
    if (overlayByKey.has(key)) {
      merged.push(overlayByKey.get(key));
      seenKeys.add(key);
      return;
    }

    merged.push(message);
    seenKeys.add(key);
  });

  overlayOrder.forEach((key) => {
    if (seenKeys.has(key)) {
      return;
    }

    merged.push(overlayByKey.get(key));
    seenKeys.add(key);
  });

  return merged.map((message, index) => normalizeMessage(message, index));
}

function normalizeConversationTokenSnapshot(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const totalTokens = Number(value.totalTokens ?? 0);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }

  const promptTokens = Number(value.promptTokens ?? totalTokens);
  const completionTokens = Number(value.completionTokens ?? 0);

  return {
    promptTokens: Number.isFinite(promptTokens) && promptTokens >= 0 ? promptTokens : totalTokens,
    completionTokens: Number.isFinite(completionTokens) && completionTokens >= 0 ? completionTokens : 0,
    totalTokens
  };
}

function applyConversationTokenSnapshotUpdate(
  db,
  conversationId,
  snapshot,
  metadata = {},
  options = {}
) {
  const normalizedSnapshot = normalizeConversationTokenSnapshot(snapshot);
  if (!normalizedSnapshot) {
    return null;
  }

  const now = Number(metadata.createdAt ?? Date.now());
  const model = String(metadata.model ?? "").trim();
  const incrementUsageCount = options.incrementUsageCount === true;

  const sql = incrementUsageCount
    ? `
        UPDATE conversations
        SET
          model = CASE WHEN TRIM(?) <> '' THEN ? ELSE model END,
          token_usage_count = token_usage_count + 1,
          token_prompt_total = ?,
          token_completion_total = ?,
          token_total_total = ?,
          token_last_used_at = ?,
          updated_at = ?
        WHERE id = ?
      `
    : `
        UPDATE conversations
        SET
          model = CASE WHEN TRIM(?) <> '' THEN ? ELSE model END,
          token_prompt_total = ?,
          token_completion_total = ?,
          token_total_total = ?,
          token_last_used_at = ?,
          updated_at = ?
        WHERE id = ?
      `;

  db.prepare(sql).run(
    model,
    model,
    normalizedSnapshot.promptTokens,
    normalizedSnapshot.completionTokens,
    normalizedSnapshot.totalTokens,
    now,
    now,
    conversationId
  );

  return {
    ...normalizedSnapshot,
    model,
    lastUsedAt: now,
    createdAt: now
  };
}

function normalizeConversationSource(value) {
  const source = String(value ?? "").trim().toLowerCase();
  if (!source) {
    return "chat";
  }
  return source;
}

function normalizeConversationParentId(value) {
  return String(value ?? "").trim();
}

export class SqliteChatHistoryStore {
  constructor(options) {
    this.dbFilePath = options.dbFilePath;
    this.dirPath = options.dirPath;
    this.defaultWorkplacePath = String(options.defaultWorkplacePath ?? "").trim();
    this.db = null;
  }

  async initialize() {
    await fs.mkdir(this.dirPath, { recursive: true });

    this.db = new DatabaseSync(this.dbFilePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workplace_path TEXT NOT NULL,
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'chat',
        model TEXT NOT NULL DEFAULT '',
        model_profile_id TEXT NOT NULL DEFAULT '',
        thinking_mode TEXT NOT NULL DEFAULT 'off',
        approval_mode TEXT NOT NULL DEFAULT 'confirm',
        skills_json TEXT NOT NULL DEFAULT '[]',
        disabled_tools_json TEXT NOT NULL DEFAULT '[]',
        persona_id TEXT NOT NULL DEFAULT '',
        developer_prompt TEXT NOT NULL DEFAULT '',
        memory_summary_prompt TEXT DEFAULT NULL,
        workplace_locked INTEGER NOT NULL DEFAULT 0,
        token_usage_count INTEGER NOT NULL DEFAULT 0,
        token_prompt_total INTEGER NOT NULL DEFAULT 0,
        token_completion_total INTEGER NOT NULL DEFAULT 0,
        token_total_total INTEGER NOT NULL DEFAULT 0,
        token_last_used_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.ensureConversationWorkplaceColumns();
    this.ensureConversationLineageColumns();
    this.ensureConversationModelProfileColumn();
    this.ensureConversationThinkingModeColumn();
    this.ensureConversationApprovalModeColumn();
    this.ensureConversationSkillsColumn();
    this.ensureConversationDisabledToolsColumn();
    this.ensureConversationPersonaColumn();
    this.ensureConversationDeveloperPromptColumn();
    this.ensureConversationMemorySummaryPromptColumn();
    this.ensureConversationTokenUsageColumns();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning_content TEXT NOT NULL DEFAULT '',
        tool_call_id TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,
        sort_index INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
      ON conversation_messages(conversation_id, sort_index, seq);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_tool_approvals (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_approval_group TEXT NOT NULL DEFAULT 'unknown',
        tool_approval_section TEXT NOT NULL DEFAULT 'unknown',
        tool_arguments TEXT NOT NULL,
        tool_calls_json TEXT NOT NULL,
        assistant_message_json TEXT NOT NULL,
        conversation_snapshot_json TEXT NOT NULL,
        runtime_config_json TEXT NOT NULL,
        execution_context_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_tool_approvals_conversation
      ON pending_tool_approvals(conversation_id, status, created_at DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_token_usages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens_details_json TEXT NOT NULL DEFAULT '',
        completion_tokens_details_json TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversation_token_usages_conversation
      ON conversation_token_usages(conversation_id, seq DESC);
    `);

    this.ensurePendingToolApprovalColumns();
    this.ensureConversationMessageMetadataColumns();
    this.ensureConversationMessageSearchIndex();
    this.migrateLegacyFlatHistory();
    this.rebuildConversationMessageSearchIndex();
  }

  ensureConversationWorkplaceColumns() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("workplace_path")) {
      db.exec("ALTER TABLE conversations ADD COLUMN workplace_path TEXT");
      db.prepare(
        `
          UPDATE conversations
          SET workplace_path = ?
          WHERE workplace_path IS NULL OR TRIM(workplace_path) = ''
        `
      ).run(this.defaultWorkplacePath);
    }

    if (!columnNames.has("workplace_locked")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN workplace_locked INTEGER NOT NULL DEFAULT 0"
      );
    }
  }

  ensureConversationApprovalModeColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("approval_mode")) {
      db.exec("ALTER TABLE conversations ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'confirm'");
    }
  }

  ensureConversationModelProfileColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("model_profile_id")) {
      db.exec("ALTER TABLE conversations ADD COLUMN model_profile_id TEXT NOT NULL DEFAULT ''");
    }
  }

  ensureConversationThinkingModeColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("thinking_mode")) {
      db.exec("ALTER TABLE conversations ADD COLUMN thinking_mode TEXT NOT NULL DEFAULT 'off'");
    }
  }

  ensureConversationSkillsColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("skills_json")) {
      db.exec("ALTER TABLE conversations ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  ensureConversationPersonaColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("persona_id")) {
      db.exec("ALTER TABLE conversations ADD COLUMN persona_id TEXT NOT NULL DEFAULT ''");
    }
  }

  ensureConversationDeveloperPromptColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("developer_prompt")) {
      db.exec("ALTER TABLE conversations ADD COLUMN developer_prompt TEXT NOT NULL DEFAULT ''");
    }
  }

  ensureConversationMemorySummaryPromptColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("memory_summary_prompt")) {
      db.exec("ALTER TABLE conversations ADD COLUMN memory_summary_prompt TEXT DEFAULT NULL");
    }
  }

  ensureConversationTokenUsageColumns() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("token_usage_count")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN token_usage_count INTEGER NOT NULL DEFAULT 0"
      );
    }

    if (!columnNames.has("token_prompt_total")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN token_prompt_total INTEGER NOT NULL DEFAULT 0"
      );
    }

    if (!columnNames.has("token_completion_total")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN token_completion_total INTEGER NOT NULL DEFAULT 0"
      );
    }

    if (!columnNames.has("token_total_total")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN token_total_total INTEGER NOT NULL DEFAULT 0"
      );
    }

    if (!columnNames.has("token_last_used_at")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN token_last_used_at INTEGER NOT NULL DEFAULT 0"
      );
    }
  }

  ensureConversationMessageMetadataColumns() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversation_messages)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("tool_call_id")) {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''");
    }

    if (!columnNames.has("reasoning_content")) {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN reasoning_content TEXT NOT NULL DEFAULT ''");
    }

    if (!columnNames.has("tool_name")) {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''");
    }

    if (!columnNames.has("tool_calls_json")) {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN tool_calls_json TEXT NOT NULL DEFAULT ''");
    }

    if (!columnNames.has("meta_json")) {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN meta_json TEXT NOT NULL DEFAULT ''");
    }

    if (!columnNames.has("token_usage_json")) {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN token_usage_json TEXT NOT NULL DEFAULT ''");
    }
  }

  ensureConversationLineageColumns() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("parent_conversation_id")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT NOT NULL DEFAULT ''"
      );
    }

    if (!columnNames.has("source")) {
      db.exec("ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'");
    }

    if (!columnNames.has("model")) {
      db.exec("ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    }
  }

  ensureConversationMessageSearchIndex() {
    const db = this.ensureDb();

    db.exec("DROP TRIGGER IF EXISTS conversation_messages_fts_insert;");
    db.exec("DROP TRIGGER IF EXISTS conversation_messages_fts_delete;");
    db.exec("DROP TRIGGER IF EXISTS conversation_messages_fts_update;");

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        role UNINDEXED,
        meta_kind UNINDEXED
      );
    `);
  }

  rebuildConversationMessageSearchIndex() {
    const db = this.ensureDb();
    db.exec("DELETE FROM conversation_messages_fts;");
    db.exec(`
      INSERT INTO conversation_messages_fts(rowid, content, conversation_id, role, meta_kind)
      SELECT
        seq,
        content,
        conversation_id,
        role,
        CASE
          WHEN instr(meta_json, '"kind":"compression_summary"') > 0 THEN 'compression_summary'
          WHEN instr(meta_json, '"kind":"tool_event"') > 0 THEN 'tool_event'
          ELSE ''
        END
      FROM conversation_messages;
    `);
  }

  ensurePendingToolApprovalColumns() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(pending_tool_approvals)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("tool_approval_group")) {
      db.exec(
        "ALTER TABLE pending_tool_approvals ADD COLUMN tool_approval_group TEXT NOT NULL DEFAULT 'unknown'"
      );
    }

    if (!columnNames.has("tool_approval_section")) {
      db.exec(
        "ALTER TABLE pending_tool_approvals ADD COLUMN tool_approval_section TEXT NOT NULL DEFAULT 'unknown'"
      );
    }
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("SQLite history store is not initialized.");
    }

    return this.db;
  }

  migrateLegacyFlatHistory() {
    const db = this.ensureDb();

    const hasLegacyTable = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'chat_messages'
        `
      )
      .get();

    if (!hasLegacyTable) {
      return;
    }

    const hasConversation = db
      .prepare("SELECT COUNT(*) AS count FROM conversations")
      .get();

    if (Number(hasConversation?.count ?? 0) > 0) {
      return;
    }

    const rows = db
      .prepare(
        `
          SELECT id, role, content, timestamp
          FROM chat_messages
          ORDER BY seq ASC
        `
      )
      .all();

    if (rows.length === 0) {
      return;
    }

    const conversationId = `legacy_${Date.now()}`;
    const messages = rows.map((item, index) => ({
      id: String(item.id),
      role: String(item.role),
      content: String(item.content),
      timestamp: Number(item.timestamp),
      sortIndex: index
    }));

    const title = buildTitleFromMessages(messages);
    const updatedAt = Number(messages.at(-1)?.timestamp ?? Date.now());

    db.exec("BEGIN TRANSACTION");

    try {
      db.prepare(
        `
          INSERT INTO conversations (
            id,
            title,
            workplace_path,
            parent_conversation_id,
            source,
            model,
            workplace_locked,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, '', 'chat', '', 0, ?, ?)
        `
      ).run(conversationId, title, this.defaultWorkplacePath, updatedAt, updatedAt);

      const insertStmt = db.prepare(
        `
          INSERT INTO conversation_messages
          (conversation_id, id, role, content, timestamp, sort_index)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      );

      for (const message of messages) {
        insertStmt.run(
          conversationId,
          message.id,
          message.role,
          message.content,
          message.timestamp,
          message.sortIndex
        );
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listConversations(options = {}) {
    const db = this.ensureDb();
    const includeChildren = options.includeChildren !== false;
    const includeSources = Array.isArray(options.includeSources)
      ? options.includeSources
          .map((item) => normalizeConversationSource(item))
          .filter(Boolean)
      : [];
    const excludeSources = Array.isArray(options.excludeSources)
      ? options.excludeSources
          .map((item) => normalizeConversationSource(item))
          .filter(Boolean)
      : [];
    const whereClauses = [];
    const params = [];

    if (!includeChildren) {
      whereClauses.push("(c.parent_conversation_id IS NULL OR TRIM(c.parent_conversation_id) = '')");
    }

    if (includeSources.length > 0) {
      const placeholders = includeSources.map(() => "?").join(", ");
      whereClauses.push(`c.source IN (${placeholders})`);
      params.push(...includeSources);
    }

    if (excludeSources.length > 0) {
      const placeholders = excludeSources.map(() => "?").join(", ");
      whereClauses.push(`c.source NOT IN (${placeholders})`);
      params.push(...excludeSources);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `
      SELECT
        c.id,
        c.title,
        c.workplace_path,
        c.parent_conversation_id,
        c.source,
        c.model,
        c.model_profile_id,
        c.thinking_mode,
        c.approval_mode,
        c.skills_json,
        c.disabled_tools_json,
        c.persona_id,
        c.developer_prompt,
        c.memory_summary_prompt,
        c.workplace_locked,
        c.token_usage_count,
        c.token_prompt_total,
        c.token_completion_total,
        c.token_total_total,
        c.token_last_used_at,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM conversation_messages m
          WHERE m.conversation_id = c.id
        ) AS message_count,
        COALESCE(
          (
            SELECT
              CASE
                WHEN TRIM(m.content) <> '' THEN SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 80)
                ELSE ''
              END
            FROM conversation_messages m
            WHERE m.conversation_id = c.id
              AND instr(m.meta_json, '"kind":"compression_summary"') = 0
              AND instr(m.meta_json, '"kind":"tool_event"') = 0
            ORDER BY m.sort_index DESC, m.seq DESC
            LIMIT 1
          ),
          ''
        ) AS preview
          FROM conversations c
          ${whereSql}
          ORDER BY c.updated_at DESC
        `
      )
      .all(...params);

    return rows.map((item) => ({
      id: String(item.id),
      title: String(item.title),
      workplacePath:
        String(item.workplace_path ?? "").trim() || this.defaultWorkplacePath,
      parentConversationId: normalizeConversationParentId(item.parent_conversation_id),
      source: normalizeConversationSource(item.source),
      model: String(item.model ?? "").trim(),
      modelProfileId: String(item.model_profile_id ?? "").trim(),
      thinkingMode: normalizeThinkingMode(item.thinking_mode),
      approvalMode: normalizeApprovalMode(item.approval_mode),
      skills: normalizeSkillNames(normalizeJsonText(item.skills_json, [])),
      disabledTools: normalizeToolNames(normalizeJsonText(item.disabled_tools_json, [])),
      personaId: String(item.persona_id ?? "").trim(),
      developerPrompt: String(item.developer_prompt ?? ""),
      memorySummaryPrompt:
        item.memory_summary_prompt == null ? null : String(item.memory_summary_prompt ?? ""),
      workplaceLocked: Number(item.workplace_locked ?? 0) === 1,
      tokenUsage: normalizeTokenUsageRow(item),
      preview: String(item.preview ?? ""),
      createdAt: Number(item.created_at),
      updatedAt: Number(item.updated_at),
      messageCount: Number(item.message_count)
    }));
  }

  listRecentConversationsRich({
    limit = 20,
    offset = 0,
    excludeConversationIds = [],
    excludeSources = [],
    includeChildren = false
  } = {}) {
    const db = this.ensureDb();
    const whereClauses = [];
    const params = [];

    if (!includeChildren) {
      whereClauses.push("(c.parent_conversation_id IS NULL OR TRIM(c.parent_conversation_id) = '')");
    }

    const normalizedExcludeConversationIds = Array.isArray(excludeConversationIds)
      ? excludeConversationIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    if (normalizedExcludeConversationIds.length > 0) {
      const placeholders = normalizedExcludeConversationIds.map(() => "?").join(", ");
      whereClauses.push(`c.id NOT IN (${placeholders})`);
      params.push(...normalizedExcludeConversationIds);
    }

    const normalizedExcludeSources = Array.isArray(excludeSources)
      ? excludeSources.map((item) => normalizeConversationSource(item)).filter(Boolean)
      : [];
    if (normalizedExcludeSources.length > 0) {
      const placeholders = normalizedExcludeSources.map(() => "?").join(", ");
      whereClauses.push(`c.source NOT IN (${placeholders})`);
      params.push(...normalizedExcludeSources);
    }

    const numericLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 20;
    const numericOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `
          SELECT
            c.id,
            c.title,
            c.workplace_path,
            c.parent_conversation_id,
            c.source,
            c.model,
            c.model_profile_id,
            c.thinking_mode,
            c.approval_mode,
            c.skills_json,
            c.disabled_tools_json,
            c.persona_id,
            c.developer_prompt,
            c.memory_summary_prompt,
            c.workplace_locked,
            c.token_usage_count,
            c.token_prompt_total,
            c.token_completion_total,
            c.token_total_total,
            c.token_last_used_at,
            c.created_at,
            c.updated_at,
            (
              SELECT COUNT(*)
              FROM conversation_messages m
              WHERE m.conversation_id = c.id
                AND instr(m.meta_json, '"kind":"compression_summary"') = 0
                AND instr(m.meta_json, '"kind":"tool_event"') = 0
            ) AS message_count,
            COALESCE(
              (
                SELECT
                  CASE
                    WHEN TRIM(m.content) <> '' THEN SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 120)
                    ELSE ''
                  END
                FROM conversation_messages m
                WHERE m.conversation_id = c.id
                  AND instr(m.meta_json, '"kind":"compression_summary"') = 0
                  AND instr(m.meta_json, '"kind":"tool_event"') = 0
                ORDER BY m.sort_index DESC, m.seq DESC
                LIMIT 1
              ),
              ''
            ) AS preview
          FROM conversations c
          ${whereSql}
          ORDER BY c.updated_at DESC
          LIMIT ? OFFSET ?
        `
      )
      .all(...params, numericLimit, numericOffset);

    return rows.map((item) => ({
      id: String(item.id),
      title: String(item.title),
      workplacePath:
        String(item.workplace_path ?? "").trim() || this.defaultWorkplacePath,
      parentConversationId: normalizeConversationParentId(item.parent_conversation_id),
      source: normalizeConversationSource(item.source),
      model: String(item.model ?? "").trim(),
      modelProfileId: String(item.model_profile_id ?? "").trim(),
      thinkingMode: normalizeThinkingMode(item.thinking_mode),
      approvalMode: normalizeApprovalMode(item.approval_mode),
      skills: normalizeSkillNames(normalizeJsonText(item.skills_json, [])),
      disabledTools: normalizeToolNames(normalizeJsonText(item.disabled_tools_json, [])),
      personaId: String(item.persona_id ?? "").trim(),
      developerPrompt: String(item.developer_prompt ?? ""),
      memorySummaryPrompt:
        item.memory_summary_prompt == null ? null : String(item.memory_summary_prompt ?? ""),
      workplaceLocked: Number(item.workplace_locked ?? 0) === 1,
      tokenUsage: normalizeTokenUsageRow(item),
      preview: String(item.preview ?? "").trim(),
      createdAt: Number(item.created_at),
      updatedAt: Number(item.updated_at),
      messageCount: Number(item.message_count ?? 0)
    }));
  }

  getConversation(conversationId) {
    const db = this.ensureDb();

    const conversation = db
      .prepare(
        `
          SELECT
            id,
            title,
            workplace_path,
            parent_conversation_id,
            source,
            model,
            model_profile_id,
            thinking_mode,
            approval_mode,
            skills_json,
            disabled_tools_json,
            persona_id,
            developer_prompt,
            memory_summary_prompt,
            workplace_locked,
            token_usage_count,
            token_prompt_total,
            token_completion_total,
            token_total_total,
            token_last_used_at,
            created_at,
            updated_at
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!conversation) {
      return null;
    }

    const messages = db
      .prepare(
        `
          SELECT id, role, content, reasoning_content, tool_call_id, tool_name, tool_calls_json, meta_json, timestamp
          , token_usage_json
          FROM conversation_messages
          WHERE conversation_id = ?
          ORDER BY sort_index ASC, seq ASC
        `
      )
      .all(conversationId)
      .map((item) => ({
        id: String(item.id),
        role: String(item.role),
        content: String(item.content),
        reasoningContent: String(item.reasoning_content ?? ""),
        timestamp: Number(item.timestamp),
        toolCallId: String(item.tool_call_id ?? "").trim(),
        toolName: String(item.tool_name ?? "").trim(),
        toolCalls: Array.isArray(normalizeJsonText(item.tool_calls_json, []))
          ? normalizeJsonText(item.tool_calls_json, [])
          : [],
        meta:
          normalizeJsonText(item.meta_json, null) &&
          typeof normalizeJsonText(item.meta_json, null) === "object" &&
          !Array.isArray(normalizeJsonText(item.meta_json, null))
            ? normalizeJsonText(item.meta_json, null)
            : {},
        tokenUsage: normalizeTokenUsage(normalizeJsonText(item.token_usage_json, null))
      }));

    return {
      id: String(conversation.id),
      title: String(conversation.title),
      workplacePath:
        String(conversation.workplace_path ?? "").trim() || this.defaultWorkplacePath,
      parentConversationId: normalizeConversationParentId(conversation.parent_conversation_id),
      source: normalizeConversationSource(conversation.source),
      model: String(conversation.model ?? "").trim(),
      modelProfileId: String(conversation.model_profile_id ?? "").trim(),
      thinkingMode: normalizeThinkingMode(conversation.thinking_mode),
      approvalMode: normalizeApprovalMode(conversation.approval_mode),
      skills: normalizeSkillNames(normalizeJsonText(conversation.skills_json, [])),
      disabledTools: normalizeToolNames(normalizeJsonText(conversation.disabled_tools_json, [])),
      personaId: String(conversation.persona_id ?? "").trim(),
      developerPrompt: String(conversation.developer_prompt ?? ""),
      memorySummaryPrompt:
        conversation.memory_summary_prompt == null
          ? null
          : String(conversation.memory_summary_prompt ?? ""),
      workplaceLocked: Number(conversation.workplace_locked ?? 0) === 1,
      tokenUsage: normalizeTokenUsageRow(conversation),
      createdAt: Number(conversation.created_at),
      updatedAt: Number(conversation.updated_at),
      preview: buildPreviewFromMessages(messages),
      messageCount: messages.length,
      messages,
      tokenUsageRecords: this.listConversationTokenUsages(String(conversation.id))
    };
  }

  getConversationLineageRoot(conversationId) {
    const db = this.ensureDb();
    let currentId = String(conversationId ?? "").trim();

    if (!currentId) {
      return "";
    }

    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const row = db
        .prepare(
          `
            SELECT parent_conversation_id
            FROM conversations
            WHERE id = ?
          `
        )
        .get(currentId);

      if (!row) {
        return currentId;
      }

      const parentId = normalizeConversationParentId(row.parent_conversation_id);
      if (!parentId) {
        return currentId;
      }

      currentId = parentId;
    }

    return currentId;
  }

  listChildConversations(parentConversationId, options = {}) {
    const db = this.ensureDb();
    const normalizedParentId = normalizeConversationParentId(parentConversationId);
    if (!normalizedParentId) {
      return [];
    }

    const sourceFilter = normalizeConversationSource(options.source ?? "");
    const rows = db
      .prepare(`
        SELECT id
        FROM conversations
        WHERE parent_conversation_id = ?
          ${sourceFilter && sourceFilter !== "chat" ? "AND source = ?" : ""}
        ORDER BY updated_at DESC, created_at DESC, id ASC
      `)
      .all(...(sourceFilter && sourceFilter !== "chat"
        ? [normalizedParentId, sourceFilter]
        : [normalizedParentId]));

    return rows
      .map((row) => this.getConversation(String(row?.id ?? "").trim()))
      .filter(Boolean);
  }

  getConversationLineageIds(conversationId) {
    const db = this.ensureDb();
    const rootId = this.getConversationLineageRoot(conversationId);

    if (!rootId) {
      return [];
    }

    const visited = new Set();
    const queue = [rootId];

    while (queue.length > 0) {
      const currentId = String(queue.shift() ?? "").trim();
      if (!currentId || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      const rows = db
        .prepare(
          `
            SELECT id
            FROM conversations
            WHERE parent_conversation_id = ?
          `
        )
        .all(currentId);

      for (const row of rows) {
        const childId = String(row?.id ?? "").trim();
        if (childId && !visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    return Array.from(visited);
  }

  listConversationTokenUsages(conversationId) {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `
          SELECT
            seq,
            conversation_id,
            model,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            prompt_tokens_details_json,
            completion_tokens_details_json,
            created_at
          FROM conversation_token_usages
          WHERE conversation_id = ?
          ORDER BY seq ASC
        `
      )
      .all(conversationId);

    return rows.map((row) => ({
      id: String(row.seq),
      conversationId: String(row.conversation_id),
      model: String(row.model ?? ""),
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      promptTokensDetails: normalizeJsonText(row.prompt_tokens_details_json, null),
      completionTokensDetails: normalizeJsonText(row.completion_tokens_details_json, null),
      createdAt: Number(row.created_at ?? Date.now())
    }));
  }

  searchConversationMessages({
    query,
    roleFilter = [],
    excludeConversationIds = [],
    excludeSources = [],
    excludeMetaKinds = ["compression_summary", "tool_event"],
    contextBefore = 1,
    contextAfter = 1,
    limit = 20,
    offset = 0
  } = {}) {
    const db = this.ensureDb();
    const normalizedQuery = sanitizeFts5Query(query);

    if (!normalizedQuery) {
      return [];
    }

    const whereClauses = ["conversation_messages_fts MATCH ?"];
    const params = [normalizedQuery];

    const normalizedRoleFilter = Array.isArray(roleFilter)
      ? roleFilter.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    if (normalizedRoleFilter.length > 0) {
      const placeholders = normalizedRoleFilter.map(() => "?").join(", ");
      whereClauses.push(`conversation_messages_fts.role IN (${placeholders})`);
      params.push(...normalizedRoleFilter);
    }

    const normalizedExcludeConversationIds = Array.isArray(excludeConversationIds)
      ? excludeConversationIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    if (normalizedExcludeConversationIds.length > 0) {
      const placeholders = normalizedExcludeConversationIds.map(() => "?").join(", ");
      whereClauses.push(`conversation_messages_fts.conversation_id NOT IN (${placeholders})`);
      params.push(...normalizedExcludeConversationIds);
    }

    const normalizedExcludeSources = Array.isArray(excludeSources)
      ? excludeSources.map((item) => normalizeConversationSource(item)).filter(Boolean)
      : [];
    if (normalizedExcludeSources.length > 0) {
      const placeholders = normalizedExcludeSources.map(() => "?").join(", ");
      whereClauses.push(`c.source NOT IN (${placeholders})`);
      params.push(...normalizedExcludeSources);
    }

    const normalizedExcludeMetaKinds = Array.isArray(excludeMetaKinds)
      ? excludeMetaKinds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    if (normalizedExcludeMetaKinds.length > 0) {
      const placeholders = normalizedExcludeMetaKinds.map(() => "?").join(", ");
      whereClauses.push(`conversation_messages_fts.meta_kind NOT IN (${placeholders})`);
      params.push(...normalizedExcludeMetaKinds);
    }

    const numericLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 20;
    const numericOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const numericContextBefore = Number.isFinite(contextBefore)
      ? Math.max(0, Math.trunc(contextBefore))
      : 1;
    const numericContextAfter = Number.isFinite(contextAfter)
      ? Math.max(0, Math.trunc(contextAfter))
      : 1;
    params.push(numericLimit, numericOffset);

    let rows = [];
    try {
      rows = db
        .prepare(
          `
            SELECT
              m.seq,
              m.id,
              m.conversation_id,
              m.role,
              m.tool_name,
              m.timestamp,
              m.sort_index,
              c.title,
              c.parent_conversation_id,
              c.source,
              c.model,
              c.created_at,
              c.updated_at,
              snippet(conversation_messages_fts, 0, '>>>', '<<<', '...', 36) AS snippet,
              m.meta_json
            FROM conversation_messages_fts
            JOIN conversation_messages m
              ON m.seq = conversation_messages_fts.rowid
            JOIN conversations c
              ON c.id = m.conversation_id
            WHERE ${whereClauses.join(" AND ")}
            ORDER BY rank
            LIMIT ? OFFSET ?
          `
        )
        .all(...params);
    } catch {
      return [];
    }

    return rows.map((row) => {
      const matchSortIndex = Number(row.sort_index ?? 0);
      const contextRows = db
        .prepare(
          `
            SELECT role, content, tool_name, meta_json
            FROM conversation_messages
            WHERE conversation_id = ?
              AND sort_index >= ?
              AND sort_index <= ?
              AND instr(meta_json, '"kind":"compression_summary"') = 0
              AND instr(meta_json, '"kind":"tool_event"') = 0
            ORDER BY sort_index ASC, seq ASC
          `
        )
        .all(
          String(row.conversation_id),
          Math.max(0, matchSortIndex - numericContextBefore),
          matchSortIndex + numericContextAfter
        )
        .map((contextRow) => ({
          role: String(contextRow.role ?? "").trim(),
          content: clipText(String(contextRow.content ?? ""), 200),
          toolName: String(contextRow.tool_name ?? "").trim(),
          metaKind: normalizeFtsMetaKind(normalizeJsonText(contextRow.meta_json, {}))
        }));

      return {
        seq: Number(row.seq),
        sortIndex: matchSortIndex,
        messageId: String(row.id),
        conversationId: String(row.conversation_id),
        parentConversationId: normalizeConversationParentId(row.parent_conversation_id),
        source: normalizeConversationSource(row.source),
        model: String(row.model ?? "").trim(),
        role: String(row.role),
        toolName: String(row.tool_name ?? "").trim(),
        timestamp: Number(row.timestamp ?? 0),
        title: String(row.title ?? "").trim(),
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
        snippet: String(row.snippet ?? "").trim(),
        metaKind: normalizeFtsMetaKind(normalizeJsonText(row.meta_json, {})),
        context: contextRows
      };
    });
  }

  findLatestEmptyConversation() {
    const db = this.ensureDb();

    const row = db
      .prepare(
        `
          SELECT c.id
          FROM conversations c
          WHERE NOT EXISTS (
            SELECT 1
            FROM conversation_messages m
            WHERE m.conversation_id = c.id
          )
          ORDER BY c.updated_at DESC
          LIMIT 1
        `
      )
      .get();

    if (!row?.id) {
      return null;
    }

    return this.getConversation(String(row.id));
  }

  upsertConversation(payload) {
    const db = this.ensureDb();
    const conversationId = String(payload.conversationId);
    const normalizedMessages = payload.messages.map((item, index) =>
      normalizeMessage(item, index)
    );

    const existing = db
      .prepare(
        `
      SELECT
        id,
        title,
        workplace_path,
        parent_conversation_id,
        source,
        model,
        model_profile_id,
        thinking_mode,
        approval_mode,
        skills_json,
        disabled_tools_json,
        workplace_locked,
        created_at,
        persona_id,
        developer_prompt,
        memory_summary_prompt
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    const requestedWorkplacePath = String(payload.workplacePath ?? "").trim();
    const currentWorkplacePath = String(existing?.workplace_path ?? "").trim();
    const workplacePath =
      requestedWorkplacePath ||
      currentWorkplacePath ||
      this.defaultWorkplacePath;
    const approvalMode = normalizeApprovalMode(
      payload.approvalMode ?? existing?.approval_mode
    );
    const skills = normalizeSkillNames(
      payload.skills ?? normalizeJsonText(existing?.skills_json, [])
    );
    const disabledTools = normalizeToolNames(
      payload.disabledTools ?? normalizeJsonText(existing?.disabled_tools_json, [])
    );
    const parentConversationId = normalizeConversationParentId(
      payload.parentConversationId ?? existing?.parent_conversation_id
    );
    const source = normalizeConversationSource(payload.source ?? existing?.source);
    const model =
      String(payload.model ?? existing?.model ?? "").trim();
    const modelProfileId =
      String(payload.modelProfileId ?? existing?.model_profile_id ?? "").trim();
    const thinkingMode = normalizeThinkingMode(payload.thinkingMode ?? existing?.thinking_mode);
    const developerPrompt =
      String(payload.developerPrompt ?? existing?.developer_prompt ?? "").trim();
    const personaId = String(payload.personaId ?? existing?.persona_id ?? "").trim();
    const hasMemorySummaryPrompt =
      Object.prototype.hasOwnProperty.call(payload, "memorySummaryPrompt");
    const memorySummaryPrompt = hasMemorySummaryPrompt
      ? payload.memorySummaryPrompt == null
        ? null
        : String(payload.memorySummaryPrompt ?? "")
      : existing?.memory_summary_prompt == null
        ? null
        : String(existing.memory_summary_prompt ?? "");

    const now = Date.now();
    const requestedCreatedAt = Number(payload.createdAt ?? 0);
    const requestedUpdatedAt = Number(payload.updatedAt ?? 0);
    const updatedAt =
      Number.isFinite(requestedUpdatedAt) && requestedUpdatedAt > 0
        ? requestedUpdatedAt
        : Number(normalizedMessages.at(-1)?.timestamp ?? now);
    const title =
      String(payload.title ?? "").trim() ||
      String(existing?.title ?? "").trim() ||
      "新会话";

    const createdAt =
      Number.isFinite(requestedCreatedAt) && requestedCreatedAt > 0
        ? requestedCreatedAt
        : Number(existing?.created_at ?? now);

    const insertMessageStmt = db.prepare(
      `
        INSERT INTO conversation_messages
        (conversation_id, id, role, content, reasoning_content, tool_call_id, tool_name, tool_calls_json, meta_json, token_usage_json, timestamp, sort_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    db.exec("BEGIN TRANSACTION");

    try {
      if (existing) {
        db.prepare(
          `
        UPDATE conversations
          SET
            title = ?,
            workplace_path = ?,
            parent_conversation_id = ?,
            source = ?,
            model = ?,
            model_profile_id = ?,
            thinking_mode = ?,
            approval_mode = ?,
            skills_json = ?,
            disabled_tools_json = ?,
            persona_id = ?,
            developer_prompt = ?,
            memory_summary_prompt = ?,
            updated_at = ?
          WHERE id = ?
          `
        ).run(
          title,
          workplacePath,
          parentConversationId,
          source,
          model,
          modelProfileId,
          thinkingMode,
          approvalMode,
          JSON.stringify(skills),
          JSON.stringify(disabledTools),
          personaId,
          developerPrompt,
          memorySummaryPrompt,
          updatedAt,
          conversationId
        );
      } else {
        db.prepare(
          `
            INSERT INTO conversations
            (
              id,
              title,
              workplace_path,
              parent_conversation_id,
              source,
              model,
              model_profile_id,
              thinking_mode,
              approval_mode,
              skills_json,
              disabled_tools_json,
              persona_id,
              developer_prompt,
              memory_summary_prompt,
              workplace_locked,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `
        ).run(
          conversationId,
          title,
          workplacePath,
          parentConversationId,
          source,
          model,
          modelProfileId,
          thinkingMode,
          approvalMode,
          JSON.stringify(skills),
          JSON.stringify(disabledTools),
          personaId,
          developerPrompt,
          memorySummaryPrompt,
          createdAt,
          updatedAt
        );
      }

      db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(
        conversationId
      );

      for (const message of normalizedMessages) {
        insertMessageStmt.run(
          conversationId,
          message.id,
          message.role,
          message.content,
          message.reasoningContent,
          message.toolCallId,
          message.toolName,
          message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : "",
          Object.keys(message.meta).length > 0 ? JSON.stringify(message.meta) : "",
          message.tokenUsage ? JSON.stringify(message.tokenUsage) : "",
          message.timestamp,
          message.sortIndex
        );
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    this.rebuildConversationMessageSearchIndex();
    return this.getConversation(conversationId);
  }

  mergeConversation(payload) {
    const conversationId = String(payload?.conversationId ?? "").trim();
    if (!conversationId) {
      throw new Error("conversationId is required");
    }

    const existing = this.getConversation(conversationId);
    if (!existing) {
      return this.upsertConversation(payload);
    }

    return this.upsertConversation({
      conversationId,
      title: payload.title ?? existing.title,
      workplacePath: payload.workplacePath ?? existing.workplacePath,
      parentConversationId: payload.parentConversationId ?? existing.parentConversationId,
      source: payload.source ?? existing.source,
      model: payload.model ?? existing.model,
      modelProfileId: payload.modelProfileId ?? existing.modelProfileId,
      thinkingMode: payload.thinkingMode ?? existing.thinkingMode,
      approvalMode: payload.approvalMode ?? existing.approvalMode,
      skills: payload.skills ?? existing.skills,
      disabledTools: payload.disabledTools ?? existing.disabledTools,
      personaId: payload.personaId ?? existing.personaId,
      developerPrompt: payload.developerPrompt ?? existing.developerPrompt,
      memorySummaryPrompt:
        Object.prototype.hasOwnProperty.call(payload, "memorySummaryPrompt")
          ? payload.memorySummaryPrompt
          : existing.memorySummaryPrompt,
      createdAt: payload.createdAt ?? existing.createdAt,
      updatedAt: payload.updatedAt,
      messages: mergeMessageSnapshots(existing.messages, payload.messages)
    });
  }

  appendMessages(conversationId, messages = [], options = {}) {
    const db = this.ensureDb();
    const existing = this.getConversation(conversationId);
    if (!existing) {
      return null;
    }

    const appendedMessages = Array.isArray(messages) ? messages : [];
    if (appendedMessages.length === 0) {
      return existing;
    }

    const normalizedConversationId = String(conversationId ?? "").trim();
    const updatedAt = Number(options.updatedAt ?? Date.now());
    const normalizedMessages = appendedMessages.map((item, index) => normalizeMessage(item, index));
    const maxSortRow = db
      .prepare(
        `
          SELECT MAX(sort_index) AS max_sort_index
          FROM conversation_messages
          WHERE conversation_id = ?
        `
      )
      .get(normalizedConversationId);
    let nextSortIndex = Number(maxSortRow?.max_sort_index ?? -1) + 1;

    const insertStmt = db.prepare(
      `
        INSERT INTO conversation_messages
        (conversation_id, id, role, content, reasoning_content, tool_call_id, tool_name, tool_calls_json, meta_json, token_usage_json, timestamp, sort_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    const selectExistingStmt = db.prepare(
      `
        SELECT seq, sort_index
        FROM conversation_messages
        WHERE conversation_id = ? AND id = ?
        ORDER BY seq DESC
        LIMIT 1
      `
    );
    const updateExistingStmt = db.prepare(
      `
        UPDATE conversation_messages
        SET
          role = ?,
          content = ?,
          reasoning_content = ?,
          tool_call_id = ?,
          tool_name = ?,
          tool_calls_json = ?,
          meta_json = ?,
          token_usage_json = ?,
          timestamp = ?
        WHERE conversation_id = ? AND id = ?
      `
    );

    db.exec("BEGIN TRANSACTION");
    try {
      for (const message of normalizedMessages) {
        const messageId = String(message.id ?? "").trim();
        if (!messageId) {
          throw new Error("message.id is required");
        }

        const existingRow = selectExistingStmt.get(normalizedConversationId, messageId);
        if (existingRow) {
          updateExistingStmt.run(
            message.role,
            message.content,
            message.reasoningContent,
            message.toolCallId,
            message.toolName,
            message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : "",
            Object.keys(message.meta).length > 0 ? JSON.stringify(message.meta) : "",
            message.tokenUsage ? JSON.stringify(message.tokenUsage) : "",
            message.timestamp,
            normalizedConversationId,
            messageId
          );

          upsertConversationMessageFtsRow(db, Number(existingRow.seq ?? 0), {
            conversationId: normalizedConversationId,
            role: message.role,
            content: message.content,
            meta: message.meta
          });
          continue;
        }

        const insertResult = insertStmt.run(
          normalizedConversationId,
          messageId,
          message.role,
          message.content,
          message.reasoningContent,
          message.toolCallId,
          message.toolName,
          message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : "",
          Object.keys(message.meta).length > 0 ? JSON.stringify(message.meta) : "",
          message.tokenUsage ? JSON.stringify(message.tokenUsage) : "",
          message.timestamp,
          nextSortIndex
        );

        upsertConversationMessageFtsRow(db, Number(insertResult.lastInsertRowid ?? 0), {
          conversationId: normalizedConversationId,
          role: message.role,
          content: message.content,
          meta: message.meta
        });

        nextSortIndex += 1;
      }

      db.prepare(
        `
          UPDATE conversations
          SET updated_at = ?
          WHERE id = ?
        `
      ).run(updatedAt, normalizedConversationId);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getConversation(normalizedConversationId);
  }

  upsertConversationMessage(conversationId, message = {}, options = {}) {
    const db = this.ensureDb();
    const existingConversation = this.getConversation(conversationId);
    if (!existingConversation) {
      return null;
    }

    const normalized = normalizeMessage(message, Number(options.sortIndex ?? 0));
    const messageId = String(normalized.id ?? "").trim();
    if (!messageId) {
      throw new Error("message.id is required");
    }

    const now = Date.now();
    const row = db
      .prepare(
        `
          SELECT seq, sort_index
          FROM conversation_messages
          WHERE conversation_id = ? AND id = ?
          ORDER BY seq DESC
          LIMIT 1
        `
      )
      .get(conversationId, messageId);

    db.exec("BEGIN TRANSACTION");
    try {
      if (row) {
        db.prepare(
          `
            UPDATE conversation_messages
            SET
              role = ?,
              content = ?,
              reasoning_content = ?,
              tool_call_id = ?,
              tool_name = ?,
              tool_calls_json = ?,
              meta_json = ?,
              token_usage_json = ?,
              timestamp = ?
            WHERE conversation_id = ? AND id = ?
          `
        ).run(
          normalized.role,
          normalized.content,
          normalized.reasoningContent,
          normalized.toolCallId,
          normalized.toolName,
          normalized.toolCalls.length > 0 ? JSON.stringify(normalized.toolCalls) : "",
          Object.keys(normalized.meta).length > 0 ? JSON.stringify(normalized.meta) : "",
          normalized.tokenUsage ? JSON.stringify(normalized.tokenUsage) : "",
          normalized.timestamp,
          conversationId,
          messageId
        );

        upsertConversationMessageFtsRow(db, Number(row.seq ?? 0), {
          conversationId,
          role: normalized.role,
          content: normalized.content,
          meta: normalized.meta
        });
      } else {
        const maxSortRow = db
          .prepare(
            `
              SELECT MAX(sort_index) AS max_sort_index
              FROM conversation_messages
              WHERE conversation_id = ?
            `
          )
          .get(conversationId);
        const nextSortIndex = Number.isInteger(Number(options.sortIndex))
          ? Number(options.sortIndex)
          : Number(maxSortRow?.max_sort_index ?? -1) + 1;

        const insertResult = db
          .prepare(
            `
              INSERT INTO conversation_messages
              (conversation_id, id, role, content, reasoning_content, tool_call_id, tool_name, tool_calls_json, meta_json, token_usage_json, timestamp, sort_index)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            conversationId,
            messageId,
            normalized.role,
            normalized.content,
            normalized.reasoningContent,
            normalized.toolCallId,
            normalized.toolName,
            normalized.toolCalls.length > 0 ? JSON.stringify(normalized.toolCalls) : "",
            Object.keys(normalized.meta).length > 0 ? JSON.stringify(normalized.meta) : "",
            normalized.tokenUsage ? JSON.stringify(normalized.tokenUsage) : "",
            normalized.timestamp,
            nextSortIndex
          );

        upsertConversationMessageFtsRow(db, Number(insertResult.lastInsertRowid ?? 0), {
          conversationId,
          role: normalized.role,
          content: normalized.content,
          meta: normalized.meta
        });
      }

      const updatedAt = Number(options.updatedAt ?? normalized.timestamp ?? now);
      db.prepare(
        `
          UPDATE conversations
          SET updated_at = ?
          WHERE id = ?
        `
      ).run(updatedAt, conversationId);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getConversation(conversationId);
  }

  cloneConversationAsFork(sourceConversationId, payload = {}) {
    const sourceConversation = this.getConversation(sourceConversationId);

    if (!sourceConversation) {
      return null;
    }

    const nextConversationId = String(payload.conversationId ?? "").trim();
    if (!nextConversationId) {
      throw new Error("conversationId is required");
    }

    const now = Date.now();
    return this.upsertConversation({
      conversationId: nextConversationId,
      title: payload.title ?? sourceConversation.title,
      workplacePath: payload.workplacePath ?? sourceConversation.workplacePath,
      parentConversationId: sourceConversation.id,
      source: "fork",
      model: payload.model ?? sourceConversation.model,
      modelProfileId: payload.modelProfileId ?? sourceConversation.modelProfileId,
      thinkingMode: payload.thinkingMode ?? sourceConversation.thinkingMode,
      approvalMode: payload.approvalMode ?? sourceConversation.approvalMode,
      skills: payload.skills ?? sourceConversation.skills,
      disabledTools: payload.disabledTools ?? sourceConversation.disabledTools,
      personaId: payload.personaId ?? sourceConversation.personaId,
      developerPrompt: payload.developerPrompt ?? sourceConversation.developerPrompt,
      memorySummaryPrompt:
        Object.prototype.hasOwnProperty.call(payload, "memorySummaryPrompt")
          ? payload.memorySummaryPrompt
          : sourceConversation.memorySummaryPrompt,
      createdAt: now,
      updatedAt: now,
      messages: Array.isArray(payload.messages)
        ? payload.messages.map((message) => ({
            ...message,
            toolCalls: Array.isArray(message.toolCalls)
              ? message.toolCalls.map((toolCall) => ({
                  ...toolCall,
                  function: toolCall?.function ? { ...toolCall.function } : undefined
                }))
              : [],
            meta:
              message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
                ? { ...message.meta }
                : {},
            tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : null
          }))
        : Array.isArray(sourceConversation.messages)
          ? sourceConversation.messages.map((message) => ({
            ...message,
            toolCalls: Array.isArray(message.toolCalls)
              ? message.toolCalls.map((toolCall) => ({
                  ...toolCall,
                  function: toolCall?.function ? { ...toolCall.function } : undefined
                }))
              : [],
            meta:
              message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
                ? { ...message.meta }
                : {},
            tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : null
            }))
          : []
    });
  }

  updateConversationTitle(conversationId, title) {
    const db = this.ensureDb();
    const normalizedTitle = String(title ?? "").trim();

    if (!normalizedTitle) {
      return this.getConversation(conversationId);
    }

    const existing = db
      .prepare(
        `
          SELECT id, title
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    if (String(existing.title) === normalizedTitle) {
      return this.getConversation(conversationId);
    }

    db.prepare(
      `
        UPDATE conversations
        SET title = ?
        WHERE id = ?
      `
    ).run(normalizedTitle, conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationWorkplace(conversationId, workplacePath) {
    const db = this.ensureDb();
    const normalizedWorkplacePath = String(workplacePath ?? "").trim();

    if (!normalizedWorkplacePath) {
      return this.getConversation(conversationId);
    }

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET workplace_path = ?
        WHERE id = ?
      `
    ).run(normalizedWorkplacePath, conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationApprovalMode(conversationId, approvalMode) {
    const db = this.ensureDb();
    const normalizedApprovalMode = normalizeApprovalMode(approvalMode);

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET approval_mode = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(normalizedApprovalMode, Date.now(), conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationSkills(conversationId, skills) {
    const db = this.ensureDb();
    const normalizedSkills = normalizeSkillNames(skills);

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET skills_json = ?
        WHERE id = ?
      `
    ).run(JSON.stringify(normalizedSkills), conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationDisabledTools(conversationId, disabledTools) {
    const db = this.ensureDb();
    const normalizedDisabledTools = normalizeToolNames(disabledTools);

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET disabled_tools_json = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(JSON.stringify(normalizedDisabledTools), Date.now(), conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationPersona(conversationId, personaId) {
    const db = this.ensureDb();
    const normalizedPersonaId = String(personaId ?? "").trim();

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET persona_id = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(normalizedPersonaId, Date.now(), conversationId);

    return this.getConversation(conversationId);
  }

  ensureConversationDisabledToolsColumn() {
    const db = this.ensureDb();
    const columns = db.prepare("PRAGMA table_info(conversations)").all();
    const columnNames = new Set(columns.map((item) => String(item.name)));

    if (!columnNames.has("disabled_tools_json")) {
      db.exec("ALTER TABLE conversations ADD COLUMN disabled_tools_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  updateConversationModelProfile(conversationId, modelProfileId, model = "") {
    const db = this.ensureDb();
    const normalizedModelProfileId = String(modelProfileId ?? "").trim();
    const normalizedModel = String(model ?? "").trim();

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET model_profile_id = ?, model = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(normalizedModelProfileId, normalizedModel, Date.now(), conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationThinkingMode(conversationId, thinkingMode) {
    const db = this.ensureDb();
    const normalizedThinkingMode = normalizeThinkingMode(thinkingMode);

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET thinking_mode = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(normalizedThinkingMode, Date.now(), conversationId);

    return this.getConversation(conversationId);
  }

  replaceConversationPersonaId(previousPersonaId, nextPersonaId) {
    const db = this.ensureDb();
    const previousId = String(previousPersonaId ?? "").trim();
    const nextId = String(nextPersonaId ?? "").trim();
    if (!previousId || previousId === nextId) {
      return 0;
    }

    const result = db
      .prepare(
        `
          UPDATE conversations
          SET persona_id = ?
          WHERE persona_id = ?
        `
      )
      .run(nextId, previousId);

    return Number(result?.changes ?? 0);
  }

  updateConversationDeveloperPrompt(conversationId, developerPrompt) {
    const db = this.ensureDb();
    const normalizedDeveloperPrompt = String(developerPrompt ?? "").trim();

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET developer_prompt = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(normalizedDeveloperPrompt, Date.now(), conversationId);

    return this.getConversation(conversationId);
  }

  updateConversationMemorySummaryPrompt(conversationId, memorySummaryPrompt) {
    const db = this.ensureDb();
    const existing = db
      .prepare(
        `
          SELECT id, memory_summary_prompt
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    const nextValue =
      memorySummaryPrompt == null ? null : String(memorySummaryPrompt ?? "");
    const currentValue =
      existing.memory_summary_prompt == null ? null : String(existing.memory_summary_prompt ?? "");

    if (currentValue === nextValue) {
      return this.getConversation(conversationId);
    }

    db.prepare(
      `
        UPDATE conversations
        SET memory_summary_prompt = ?
        WHERE id = ?
      `
    ).run(nextValue, conversationId);

    return this.getConversation(conversationId);
  }

  deleteConversationMessage(conversationId, messageId) {
    const db = this.ensureDb();
    const normalizedConversationId = String(conversationId ?? "").trim();
    const normalizedMessageId = String(messageId ?? "").trim();

    if (!normalizedConversationId || !normalizedMessageId) {
      return null;
    }

    const existingConversation = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(normalizedConversationId);

    if (!existingConversation) {
      return null;
    }

    const targetMessage = db
      .prepare(
        `
          SELECT id, role, tool_calls_json
          FROM conversation_messages
          WHERE conversation_id = ? AND id = ?
          ORDER BY seq DESC
          LIMIT 1
        `
      )
      .get(normalizedConversationId, normalizedMessageId);

    if (!targetMessage) {
      return null;
    }

    const deletedMessageIds = new Set([normalizedMessageId]);

    if (String(targetMessage.role ?? "").trim() === "assistant") {
      const toolCalls = Array.isArray(normalizeJsonText(targetMessage.tool_calls_json, []))
        ? normalizeJsonText(targetMessage.tool_calls_json, [])
        : [];
      const toolCallIds = Array.from(
        new Set(
          toolCalls
            .map((toolCall) => String(toolCall?.id ?? "").trim())
            .filter(Boolean)
        )
      );

      if (toolCallIds.length > 0) {
        const placeholders = toolCallIds.map(() => "?").join(", ");
        const toolRows = db
          .prepare(
            `
              SELECT id
              FROM conversation_messages
              WHERE conversation_id = ?
                AND role = 'tool'
                AND tool_call_id IN (${placeholders})
            `
          )
          .all(normalizedConversationId, ...toolCallIds);

        for (const row of toolRows) {
          const toolMessageId = String(row?.id ?? "").trim();
          if (toolMessageId) {
            deletedMessageIds.add(toolMessageId);
          }
        }
      }
    }

    const orderedRemainingRows = db
      .prepare(
        `
          SELECT id
          FROM conversation_messages
          WHERE conversation_id = ?
            AND id NOT IN (${Array.from(deletedMessageIds).map(() => "?").join(", ")})
          ORDER BY sort_index ASC, seq ASC
        `
      )
      .all(normalizedConversationId, ...Array.from(deletedMessageIds));

    db.exec("BEGIN TRANSACTION");

    try {
      db.prepare(
        `
          DELETE FROM conversation_messages
          WHERE conversation_id = ?
            AND id IN (${Array.from(deletedMessageIds).map(() => "?").join(", ")})
        `
      ).run(normalizedConversationId, ...Array.from(deletedMessageIds));

      const updateSortIndexStmt = db.prepare(
        `
          UPDATE conversation_messages
          SET sort_index = ?
          WHERE conversation_id = ? AND id = ?
        `
      );

      orderedRemainingRows.forEach((row, index) => {
        updateSortIndexStmt.run(index, normalizedConversationId, String(row.id));
      });

      db.prepare(
        `
          UPDATE conversations
          SET updated_at = ?
          WHERE id = ?
        `
      ).run(Date.now(), normalizedConversationId);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    this.rebuildConversationMessageSearchIndex();
    return {
      history: this.getConversation(normalizedConversationId),
      deletedMessageIds: Array.from(deletedMessageIds)
    };
  }

  clearConversationMessages(conversationId) {
    const db = this.ensureDb();
    const normalizedConversationId = String(conversationId ?? "").trim();

    if (!normalizedConversationId) {
      return null;
    }

    const existingConversation = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(normalizedConversationId);

    if (!existingConversation) {
      return null;
    }

    const now = Date.now();
    db.exec("BEGIN TRANSACTION");

    try {
      db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(
        normalizedConversationId
      );
      db.prepare("DELETE FROM conversation_token_usages WHERE conversation_id = ?").run(
        normalizedConversationId
      );
      db.prepare("DELETE FROM pending_tool_approvals WHERE conversation_id = ?").run(
        normalizedConversationId
      );
      db.prepare(
        `
          UPDATE conversations
          SET
            token_usage_count = 0,
            token_prompt_total = 0,
            token_completion_total = 0,
            token_total_total = 0,
            token_last_used_at = 0,
            updated_at = ?
          WHERE id = ?
        `
      ).run(now, normalizedConversationId);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    this.rebuildConversationMessageSearchIndex();
    return this.getConversation(normalizedConversationId);
  }

  recordConversationTokenUsage(conversationId, usage, metadata = {}) {
    const db = this.ensureDb();
    const normalizedUsage = normalizeTokenUsage(usage);

    if (!normalizedUsage) {
      return null;
    }

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    const now = Number(metadata.createdAt ?? Date.now());
    const model = String(metadata.model ?? "").trim();
    const promptTokensDetails = normalizedUsage.promptTokensDetails
      ? JSON.stringify(normalizedUsage.promptTokensDetails)
      : "";
    const completionTokensDetails = normalizedUsage.completionTokensDetails
      ? JSON.stringify(normalizedUsage.completionTokensDetails)
      : "";

    db.exec("BEGIN TRANSACTION");

    try {
      db.prepare(
        `
          INSERT INTO conversation_token_usages (
            conversation_id,
            model,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            prompt_tokens_details_json,
            completion_tokens_details_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        conversationId,
        model,
        normalizedUsage.promptTokens,
        normalizedUsage.completionTokens,
        normalizedUsage.totalTokens,
        promptTokensDetails,
        completionTokensDetails,
        now
      );

      applyConversationTokenSnapshotUpdate(
        db,
        conversationId,
        normalizedUsage,
        { createdAt: now, model },
        { incrementUsageCount: true }
      );

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      ...normalizedUsage,
      model,
      createdAt: now
    };
  }

  updateConversationTokenSnapshot(conversationId, snapshot, metadata = {}) {
    const db = this.ensureDb();
    const normalizedConversationId = String(conversationId ?? "").trim();
    if (!normalizedConversationId) {
      return null;
    }

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(normalizedConversationId);

    if (!existing) {
      return null;
    }

    const normalizedSnapshot = normalizeConversationTokenSnapshot(snapshot);
    if (!normalizedSnapshot) {
      return this.getConversation(normalizedConversationId);
    }

    db.exec("BEGIN TRANSACTION");

    try {
      applyConversationTokenSnapshotUpdate(
        db,
        normalizedConversationId,
        normalizedSnapshot,
        metadata,
        { incrementUsageCount: false }
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getConversation(normalizedConversationId);
  }

  lockConversationWorkplace(conversationId) {
    const db = this.ensureDb();

    const existing = db
      .prepare(
        `
          SELECT id
          FROM conversations
          WHERE id = ?
        `
      )
      .get(conversationId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE conversations
        SET workplace_locked = 1
        WHERE id = ?
      `
    ).run(conversationId);

    return this.getConversation(conversationId);
  }

  createPendingToolApproval(payload) {
    const db = this.ensureDb();
    const approvalId = String(payload.approvalId ?? "").trim();

    if (!approvalId) {
      throw new Error("approvalId is required");
    }

    const now = Date.now();
    const conversationId = String(payload.conversationId ?? "").trim();
    const toolCallId = String(payload.toolCallId ?? "").trim();
    const toolName = String(payload.toolName ?? "").trim();
    const toolApprovalGroup =
      String(payload.toolApprovalGroup ?? "unknown").trim() || "unknown";
    const toolApprovalSection =
      String(payload.toolApprovalSection ?? "unknown").trim() || "unknown";
    const toolArguments = String(payload.toolArguments ?? "{}");

    db.prepare(
      `
        INSERT INTO pending_tool_approvals (
          id,
          conversation_id,
          status,
          approval_mode,
          tool_call_id,
          tool_name,
          tool_approval_group,
          tool_approval_section,
          tool_arguments,
          tool_calls_json,
          assistant_message_json,
          conversation_snapshot_json,
          runtime_config_json,
          execution_context_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      approvalId,
      conversationId,
      normalizeApprovalMode(payload.approvalMode),
      toolCallId,
      toolName,
      toolApprovalGroup,
      toolApprovalSection,
      toolArguments,
      JSON.stringify(Array.isArray(payload.toolCalls) ? payload.toolCalls : []),
      JSON.stringify(payload.assistantMessage ?? {}),
      JSON.stringify(Array.isArray(payload.conversationSnapshot) ? payload.conversationSnapshot : []),
      JSON.stringify(payload.runtimeConfig ?? {}),
      JSON.stringify(payload.executionContext ?? {}),
      now,
      now
    );

    return this.getPendingToolApproval(approvalId);
  }

  getPendingToolApproval(approvalId) {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
          SELECT *
          FROM pending_tool_approvals
          WHERE id = ?
        `
      )
      .get(approvalId);

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      status: String(row.status),
      approvalMode: normalizeApprovalMode(row.approval_mode),
      toolCallId: String(row.tool_call_id),
      toolName: String(row.tool_name),
      toolApprovalGroup: String(row.tool_approval_group ?? "unknown"),
      toolApprovalSection: String(row.tool_approval_section ?? "unknown"),
      toolArguments: String(row.tool_arguments ?? "{}"),
      toolCalls: Array.isArray(normalizeJsonText(row.tool_calls_json, []))
        ? normalizeJsonText(row.tool_calls_json, [])
        : [],
      assistantMessage: normalizeJsonText(row.assistant_message_json, {}),
      conversationSnapshot: Array.isArray(normalizeJsonText(row.conversation_snapshot_json, []))
        ? normalizeJsonText(row.conversation_snapshot_json, [])
        : [],
      runtimeConfig: normalizeJsonText(row.runtime_config_json, {}),
      executionContext: normalizeJsonText(row.execution_context_json, {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  updatePendingToolApprovalStatus(approvalId, status) {
    const db = this.ensureDb();
    const normalizedStatus = String(status ?? "").trim();

    if (!normalizedStatus) {
      throw new Error("status is required");
    }

    const existing = db
      .prepare(
        `
          SELECT id
          FROM pending_tool_approvals
          WHERE id = ?
        `
      )
      .get(approvalId);

    if (!existing) {
      return null;
    }

    db.prepare(
      `
        UPDATE pending_tool_approvals
        SET status = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(normalizedStatus, Date.now(), approvalId);

    return this.getPendingToolApproval(approvalId);
  }

  deletePendingToolApproval(approvalId) {
    const db = this.ensureDb();
    db.prepare("DELETE FROM pending_tool_approvals WHERE id = ?").run(approvalId);
  }

  deletePendingToolApprovalsByConversationId(conversationId) {
    const db = this.ensureDb();
    db.prepare("DELETE FROM pending_tool_approvals WHERE conversation_id = ?").run(conversationId);
  }

  deleteConversation(conversationId) {
    const db = this.ensureDb();
    const normalizedConversationId = String(conversationId ?? "").trim();

    if (!normalizedConversationId) {
      return;
    }

    const existing = db
      .prepare(
        `
          SELECT id, parent_conversation_id, updated_at, created_at
          FROM conversations
          WHERE id = ?
        `
      )
      .get(normalizedConversationId);

    if (!existing) {
      return;
    }

    const directChildren = db
      .prepare(
        `
          SELECT id, updated_at, created_at
          FROM conversations
          WHERE parent_conversation_id = ?
          ORDER BY updated_at DESC, created_at DESC, id ASC
        `
      )
      .all(normalizedConversationId);

    let successorChildId = "";
    if (directChildren.length > 0) {
      const parentUpdatedAt = Number(existing.updated_at ?? existing.created_at ?? 0);
      const sortedChildren = [...directChildren].sort((left, right) => {
        const leftDistance = Math.abs(Number(left.updated_at ?? left.created_at ?? 0) - parentUpdatedAt);
        const rightDistance = Math.abs(Number(right.updated_at ?? right.created_at ?? 0) - parentUpdatedAt);
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }

        const rightUpdatedAt = Number(right.updated_at ?? right.created_at ?? 0);
        const leftUpdatedAt = Number(left.updated_at ?? left.created_at ?? 0);
        if (rightUpdatedAt !== leftUpdatedAt) {
          return rightUpdatedAt - leftUpdatedAt;
        }

        return String(left.id ?? "").localeCompare(String(right.id ?? ""));
      });

      successorChildId = String(sortedChildren[0]?.id ?? "").trim();
    }

    const inheritedParentId = normalizeConversationParentId(existing.parent_conversation_id);

    db.exec("BEGIN TRANSACTION");
    try {
      if (successorChildId) {
        db.prepare(
          `
            UPDATE conversations
            SET parent_conversation_id = ?, source = 'chat'
            WHERE id = ?
          `
        ).run(inheritedParentId, successorChildId);

        const siblingChildIds = directChildren
          .map((item) => String(item?.id ?? "").trim())
          .filter((item) => item && item !== successorChildId);

        if (siblingChildIds.length > 0) {
          const placeholders = siblingChildIds.map(() => "?").join(", ");
          db.prepare(
            `
              UPDATE conversations
              SET parent_conversation_id = ?
              WHERE id IN (${placeholders})
            `
          ).run(successorChildId, ...siblingChildIds);
        }
      }

      db.prepare("DELETE FROM pending_tool_approvals WHERE conversation_id = ?").run(
        normalizedConversationId
      );
      db.prepare("DELETE FROM conversations WHERE id = ?").run(normalizedConversationId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    this.rebuildConversationMessageSearchIndex();
  }
}
