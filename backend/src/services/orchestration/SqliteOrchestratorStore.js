import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import {
  buildPrimaryAgentId,
  normalizeAgentStatus,
  normalizeAgentType
} from "./agentIdentity.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeLineList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];
}

function normalizeQueueStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["queued", "ready", "consumed", "failed"].includes(normalized)) {
    return normalized;
  }
  return "queued";
}

function normalizeBroadcastMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["direct", "light", "full"].includes(normalized)) {
    return normalized;
  }
  return "direct";
}

function normalizeDeliveryMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["queued_after_atomic", "idle_wake", "direct"].includes(normalized)) {
    return normalized;
  }
  return "queued_after_atomic";
}

function normalizeDeliveryStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["queued", "ready", "consumed", "failed"].includes(normalized)) {
    return normalized;
  }
  return "queued";
}

function normalizeQueueRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    sessionId: normalizeText(row.session_id),
    targetAgentId: normalizeText(row.target_agent_id),
    sourceAgentId: normalizeText(row.source_agent_id),
    subtype: normalizeText(row.subtype) || "generic",
    deliveryMode: normalizeDeliveryMode(row.delivery_mode),
    broadcastMode: normalizeBroadcastMode(row.broadcast_mode),
    atomicStepId: normalizeText(row.atomic_step_id),
    createdAt: Number(row.created_at ?? 0),
    readyAt: Number(row.ready_at ?? 0),
    consumedAt: Number(row.consumed_at ?? 0),
    status: normalizeQueueStatus(row.status),
    message: normalizeJsonText(row.message_json, null),
    metadata: normalizeMetadata(normalizeJsonText(row.metadata_json, {}))
  };
}

function normalizePoolEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    sequence: Number(row.sequence ?? 0),
    sessionId: normalizeText(row.session_id),
    sourceAgentId: normalizeText(row.source_agent_id),
    subtype: normalizeText(row.subtype) || "generic",
    atomicStepId: normalizeText(row.atomic_step_id),
    title: normalizeText(row.title),
    summaryLines: normalizeLineList(normalizeJsonText(row.summary_lines_json, [])),
    detailLines: normalizeLineList(normalizeJsonText(row.detail_lines_json, [])),
    payload: normalizeJsonText(row.payload_json, null),
    metadata: normalizeMetadata(normalizeJsonText(row.metadata_json, {})),
    createdAt: Number(row.created_at ?? 0)
  };
}

function normalizeDelivery(row) {
  if (!row) {
    return null;
  }

  return {
    id: normalizeText(row.id),
    poolEntryId: normalizeText(row.pool_entry_id),
    sessionId: normalizeText(row.session_id),
    targetAgentId: normalizeText(row.target_agent_id),
    deliveryKind: normalizeText(row.delivery_kind) || "pool_broadcast",
    deliveryMode: normalizeDeliveryMode(row.delivery_mode),
    status: normalizeDeliveryStatus(row.status),
    queuedMessageId: normalizeText(row.queued_message_id),
    createdAt: Number(row.created_at ?? 0),
    deliveredAt: Number(row.delivered_at ?? 0),
    consumedAt: Number(row.consumed_at ?? 0),
    metadata: normalizeMetadata(normalizeJsonText(row.metadata_json, {}))
  };
}

function normalizeAgent(row) {
  if (!row) {
    return null;
  }

  return {
    agentId: normalizeText(row.agent_id),
    sessionId: normalizeText(row.session_id),
    conversationId: normalizeText(row.conversation_id),
    agentType: normalizeAgentType(row.agent_type),
    displayName: normalizeText(row.display_name),
    isPrimary: Number(row.is_primary ?? 0) === 1,
    status: normalizeAgentStatus(row.status),
    atomicDepth: Number(row.atomic_depth ?? 0),
    openAtomicSteps: Array.isArray(normalizeJsonText(row.open_atomic_steps_json, []))
      ? normalizeJsonText(row.open_atomic_steps_json, [])
      : [],
    metadata: normalizeMetadata(normalizeJsonText(row.metadata_json, {})),
    lastActiveAt: Number(row.last_active_at ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  };
}

export class SqliteOrchestratorStore {
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
      CREATE TABLE IF NOT EXISTS orchestrator_agents (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        agent_type TEXT NOT NULL DEFAULT 'generic',
        display_name TEXT NOT NULL DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        atomic_depth INTEGER NOT NULL DEFAULT 0,
        open_atomic_steps_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_active_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orchestrator_agents_session
      ON orchestrator_agents(session_id, is_primary DESC, updated_at DESC, agent_id ASC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orchestrator_agents_conversation
      ON orchestrator_agents(conversation_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_pool_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        source_agent_id TEXT NOT NULL DEFAULT '',
        subtype TEXT NOT NULL DEFAULT 'generic',
        atomic_step_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        summary_lines_json TEXT NOT NULL DEFAULT '[]',
        detail_lines_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_pool_sequence
      ON orchestrator_pool_entries(session_id, sequence);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_pool_deliveries (
        id TEXT PRIMARY KEY,
        pool_entry_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        delivery_kind TEXT NOT NULL DEFAULT 'pool_broadcast',
        delivery_mode TEXT NOT NULL DEFAULT 'queued_after_atomic',
        status TEXT NOT NULL DEFAULT 'queued',
        queued_message_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        delivered_at INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orchestrator_pool_deliveries_target
      ON orchestrator_pool_deliveries(session_id, target_agent_id, status, created_at DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_agent_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        source_agent_id TEXT NOT NULL DEFAULT '',
        subtype TEXT NOT NULL DEFAULT 'generic',
        delivery_mode TEXT NOT NULL DEFAULT 'queued_after_atomic',
        broadcast_mode TEXT NOT NULL DEFAULT 'direct',
        atomic_step_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        message_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        ready_at INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orchestrator_agent_queue_target
      ON orchestrator_agent_queue(session_id, target_agent_id, status, created_at ASC);
    `);
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("orchestrator store is not initialized");
    }
    return this.db;
  }

  ensurePrimaryAgent(options = {}) {
    const db = this.ensureDb();
    const sessionId = normalizeText(options.sessionId);
    const conversationId = normalizeText(options.conversationId ?? options.sessionId);
    if (!sessionId) {
      throw new Error("sessionId is required");
    }

    const agentId = normalizeText(options.agentId) || buildPrimaryAgentId(sessionId);
    const now = Date.now();
    const existing = this.getAgent(agentId);
    const nextRow = {
      agentId,
      sessionId,
      conversationId,
      agentType: normalizeAgentType(options.agentType ?? "primary"),
      displayName: normalizeText(options.displayName) || "主智能体",
      isPrimary: true,
      status: normalizeAgentStatus(options.status ?? existing?.status ?? "idle"),
      atomicDepth: Number.isInteger(options.atomicDepth)
        ? options.atomicDepth
        : Number(existing?.atomicDepth ?? 0),
      openAtomicSteps: Array.isArray(options.openAtomicSteps)
        ? options.openAtomicSteps
        : Array.isArray(existing?.openAtomicSteps)
          ? existing.openAtomicSteps
          : [],
      metadata: {
        ...(existing?.metadata ?? {}),
        ...normalizeMetadata(options.metadata)
      },
      lastActiveAt: Number(options.lastActiveAt ?? existing?.lastActiveAt ?? now),
      createdAt: Number(existing?.createdAt ?? now),
      updatedAt: now
    };

    db.prepare(`
      INSERT INTO orchestrator_agents (
        agent_id,
        session_id,
        conversation_id,
        agent_type,
        display_name,
        is_primary,
        status,
        atomic_depth,
        open_atomic_steps_json,
        metadata_json,
        last_active_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id = excluded.session_id,
        conversation_id = excluded.conversation_id,
        agent_type = excluded.agent_type,
        display_name = excluded.display_name,
        is_primary = 1,
        status = excluded.status,
        atomic_depth = excluded.atomic_depth,
        open_atomic_steps_json = excluded.open_atomic_steps_json,
        metadata_json = excluded.metadata_json,
        last_active_at = excluded.last_active_at,
        updated_at = excluded.updated_at
    `).run(
      nextRow.agentId,
      nextRow.sessionId,
      nextRow.conversationId,
      nextRow.agentType,
      nextRow.displayName,
      nextRow.status,
      nextRow.atomicDepth,
      JSON.stringify(nextRow.openAtomicSteps),
      JSON.stringify(nextRow.metadata),
      nextRow.lastActiveAt,
      nextRow.createdAt,
      nextRow.updatedAt
    );

    return this.getAgent(agentId);
  }

  upsertAgent(options = {}) {
    const db = this.ensureDb();
    const agentId = normalizeText(options.agentId);
    const sessionId = normalizeText(options.sessionId);
    if (!agentId || !sessionId) {
      throw new Error("agentId and sessionId are required");
    }

    const now = Date.now();
    const existing = this.getAgent(agentId);
    const nextRow = {
      agentId,
      sessionId,
      conversationId: normalizeText(options.conversationId ?? existing?.conversationId),
      agentType: normalizeAgentType(options.agentType ?? existing?.agentType),
      displayName: normalizeText(options.displayName ?? existing?.displayName),
      isPrimary: Boolean(options.isPrimary ?? existing?.isPrimary),
      status: normalizeAgentStatus(options.status ?? existing?.status ?? "idle"),
      atomicDepth: Number.isInteger(options.atomicDepth)
        ? options.atomicDepth
        : Number(existing?.atomicDepth ?? 0),
      openAtomicSteps: Array.isArray(options.openAtomicSteps)
        ? cloneValue(options.openAtomicSteps)
        : Array.isArray(existing?.openAtomicSteps)
          ? cloneValue(existing.openAtomicSteps)
          : [],
      metadata: {
        ...(existing?.metadata ?? {}),
        ...normalizeMetadata(options.metadata)
      },
      lastActiveAt: Number(options.lastActiveAt ?? existing?.lastActiveAt ?? now),
      createdAt: Number(existing?.createdAt ?? now),
      updatedAt: now
    };

    db.prepare(`
      INSERT INTO orchestrator_agents (
        agent_id,
        session_id,
        conversation_id,
        agent_type,
        display_name,
        is_primary,
        status,
        atomic_depth,
        open_atomic_steps_json,
        metadata_json,
        last_active_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id = excluded.session_id,
        conversation_id = excluded.conversation_id,
        agent_type = excluded.agent_type,
        display_name = excluded.display_name,
        is_primary = excluded.is_primary,
        status = excluded.status,
        atomic_depth = excluded.atomic_depth,
        open_atomic_steps_json = excluded.open_atomic_steps_json,
        metadata_json = excluded.metadata_json,
        last_active_at = excluded.last_active_at,
        updated_at = excluded.updated_at
    `).run(
      nextRow.agentId,
      nextRow.sessionId,
      nextRow.conversationId,
      nextRow.agentType,
      nextRow.displayName,
      nextRow.isPrimary ? 1 : 0,
      nextRow.status,
      nextRow.atomicDepth,
      JSON.stringify(nextRow.openAtomicSteps),
      JSON.stringify(nextRow.metadata),
      nextRow.lastActiveAt,
      nextRow.createdAt,
      nextRow.updatedAt
    );

    return this.getAgent(agentId);
  }

  getAgent(agentId) {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM orchestrator_agents WHERE agent_id = ?")
      .get(normalizeText(agentId));
    return normalizeAgent(row);
  }

  findAgentByConversationId(conversationId) {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM orchestrator_agents WHERE conversation_id = ?")
      .get(normalizeText(conversationId));
    return normalizeAgent(row);
  }

  listAgents(sessionId, options = {}) {
    const db = this.ensureDb();
    const normalizedSessionId = normalizeText(sessionId);
    const includePrimary = options.includePrimary !== false;
    const rows = db
      .prepare(`
        SELECT *
        FROM orchestrator_agents
        WHERE session_id = ?
        ${includePrimary ? "" : "AND is_primary = 0"}
        ORDER BY is_primary DESC, updated_at DESC, agent_id ASC
      `)
      .all(normalizedSessionId);

    return rows.map((row) => normalizeAgent(row)).filter(Boolean);
  }

  deleteAgent(agentId) {
    const db = this.ensureDb();
    const normalizedAgentId = normalizeText(agentId);
    if (!normalizedAgentId) {
      return false;
    }

    db.exec("BEGIN TRANSACTION");
    try {
      db.prepare("DELETE FROM orchestrator_agent_queue WHERE target_agent_id = ? OR source_agent_id = ?")
        .run(normalizedAgentId, normalizedAgentId);
      db.prepare("DELETE FROM orchestrator_pool_deliveries WHERE target_agent_id = ?")
        .run(normalizedAgentId);
      db.prepare("DELETE FROM orchestrator_agents WHERE agent_id = ?").run(normalizedAgentId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return true;
  }

  appendPoolEntry(options = {}) {
    const db = this.ensureDb();
    const sessionId = normalizeText(options.sessionId);
    if (!sessionId) {
      throw new Error("sessionId is required");
    }

    const current = db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestrator_pool_entries WHERE session_id = ?")
      .get(sessionId);
    const sequence = Number(current?.sequence ?? 0) + 1;
    const id = normalizeText(options.id) || `pool_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const createdAt = Number(options.createdAt ?? Date.now());

    db.prepare(`
      INSERT INTO orchestrator_pool_entries (
        id,
        session_id,
        sequence,
        source_agent_id,
        subtype,
        atomic_step_id,
        title,
        summary_lines_json,
        detail_lines_json,
        payload_json,
        metadata_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      sequence,
      normalizeText(options.sourceAgentId),
      normalizeText(options.subtype) || "generic",
      normalizeText(options.atomicStepId),
      normalizeText(options.title),
      JSON.stringify(normalizeLineList(options.summaryLines)),
      JSON.stringify(normalizeLineList(options.detailLines)),
      options.payload === undefined || options.payload === null ? "" : JSON.stringify(options.payload),
      JSON.stringify(normalizeMetadata(options.metadata)),
      createdAt
    );

    return this.getPoolEntryById(id);
  }

  getPoolEntryById(entryId) {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM orchestrator_pool_entries WHERE id = ?")
      .get(normalizeText(entryId));
    return normalizePoolEntry(row);
  }

  listPoolEntries(sessionId, options = {}) {
    const db = this.ensureDb();
    const normalizedSessionId = normalizeText(sessionId);
    const sinceSequence = Number(options.sinceSequence ?? 0);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;

    const rows = db
      .prepare(`
        SELECT *
        FROM orchestrator_pool_entries
        WHERE session_id = ?
          AND sequence > ?
        ORDER BY sequence DESC
        LIMIT ?
      `)
      .all(normalizedSessionId, sinceSequence, limit);

    return rows
      .map((row) => normalizePoolEntry(row))
      .filter(Boolean)
      .reverse();
  }

  recordPoolDelivery(options = {}) {
    const db = this.ensureDb();
    const id = normalizeText(options.id) || `delivery_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const createdAt = Number(options.createdAt ?? Date.now());

    db.prepare(`
      INSERT INTO orchestrator_pool_deliveries (
        id,
        pool_entry_id,
        session_id,
        target_agent_id,
        delivery_kind,
        delivery_mode,
        status,
        queued_message_id,
        metadata_json,
        created_at,
        delivered_at,
        consumed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizeText(options.poolEntryId),
      normalizeText(options.sessionId),
      normalizeText(options.targetAgentId),
      normalizeText(options.deliveryKind) || "pool_broadcast",
      normalizeDeliveryMode(options.deliveryMode),
      normalizeDeliveryStatus(options.status),
      normalizeText(options.queuedMessageId),
      JSON.stringify(normalizeMetadata(options.metadata)),
      createdAt,
      Number(options.deliveredAt ?? 0),
      Number(options.consumedAt ?? 0)
    );

    return this.getPoolDeliveryById(id);
  }

  getPoolDeliveryById(deliveryId) {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM orchestrator_pool_deliveries WHERE id = ?")
      .get(normalizeText(deliveryId));
    return normalizeDelivery(row);
  }

  updatePoolDeliveryStatus(deliveryId, status, metadata = {}) {
    const db = this.ensureDb();
    const normalizedDeliveryId = normalizeText(deliveryId);
    const existing = this.getPoolDeliveryById(normalizedDeliveryId);
    if (!existing) {
      return null;
    }

    const nextStatus = normalizeDeliveryStatus(status);
    const now = Date.now();
    db.prepare(`
      UPDATE orchestrator_pool_deliveries
      SET
        status = ?,
        metadata_json = ?,
        delivered_at = CASE WHEN ? = 'ready' AND delivered_at <= 0 THEN ? ELSE delivered_at END,
        consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE consumed_at END
      WHERE id = ?
    `).run(
      nextStatus,
      JSON.stringify({
        ...existing.metadata,
        ...normalizeMetadata(metadata)
      }),
      nextStatus,
      now,
      nextStatus,
      now,
      normalizedDeliveryId
    );

    return this.getPoolDeliveryById(normalizedDeliveryId);
  }

  insertQueueEntry(options = {}) {
    const db = this.ensureDb();
    const id = normalizeText(options.id) || `queue_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const createdAt = Number(options.createdAt ?? Date.now());

    db.prepare(`
      INSERT INTO orchestrator_agent_queue (
        id,
        session_id,
        target_agent_id,
        source_agent_id,
        subtype,
        delivery_mode,
        broadcast_mode,
        atomic_step_id,
        status,
        message_json,
        metadata_json,
        created_at,
        ready_at,
        consumed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizeText(options.sessionId),
      normalizeText(options.targetAgentId),
      normalizeText(options.sourceAgentId),
      normalizeText(options.subtype) || "generic",
      normalizeDeliveryMode(options.deliveryMode),
      normalizeBroadcastMode(options.broadcastMode),
      normalizeText(options.atomicStepId),
      normalizeQueueStatus(options.status),
      JSON.stringify(options.message ?? {}),
      JSON.stringify(normalizeMetadata(options.metadata)),
      createdAt,
      Number(options.readyAt ?? 0),
      Number(options.consumedAt ?? 0)
    );

    return this.getQueueEntryById(id);
  }

  getQueueEntryById(queueId) {
    const db = this.ensureDb();
    const row = db
      .prepare("SELECT * FROM orchestrator_agent_queue WHERE id = ?")
      .get(normalizeText(queueId));
    return normalizeQueueRecord(row);
  }

  listQueueEntries(sessionId, targetAgentId, options = {}) {
    const db = this.ensureDb();
    const normalizedSessionId = normalizeText(sessionId);
    const normalizedTargetAgentId = normalizeText(targetAgentId);
    const includeConsumed = Boolean(options.includeConsumed);
    const rows = db
      .prepare(`
        SELECT *
        FROM orchestrator_agent_queue
        WHERE session_id = ?
          AND target_agent_id = ?
          ${includeConsumed ? "" : "AND status <> 'consumed'"}
        ORDER BY created_at ASC, id ASC
      `)
      .all(normalizedSessionId, normalizedTargetAgentId);

    return rows.map((row) => normalizeQueueRecord(row)).filter(Boolean);
  }

  updateQueueEntryStatus(queueId, status, options = {}) {
    const db = this.ensureDb();
    const normalizedQueueId = normalizeText(queueId);
    const existing = this.getQueueEntryById(normalizedQueueId);
    if (!existing) {
      return null;
    }

    const nextStatus = normalizeQueueStatus(status);
    const now = Date.now();
    db.prepare(`
      UPDATE orchestrator_agent_queue
      SET
        status = ?,
        ready_at = CASE WHEN ? = 'ready' AND ready_at <= 0 THEN ? ELSE ready_at END,
        consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE consumed_at END,
        metadata_json = ?
      WHERE id = ?
    `).run(
      nextStatus,
      nextStatus,
      now,
      nextStatus,
      now,
      JSON.stringify({
        ...existing.metadata,
        ...normalizeMetadata(options.metadata)
      }),
      normalizedQueueId
    );

    return this.getQueueEntryById(normalizedQueueId);
  }

  loadSessionSnapshot(sessionId) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const agents = this.listAgents(normalizedSessionId, { includePrimary: true });
    if (agents.length === 0) {
      return null;
    }

    const publicPool = this.listPoolEntries(normalizedSessionId, { sinceSequence: 0, limit: 500 });
    const queueByAgent = new Map();

    for (const agent of agents) {
      queueByAgent.set(
        agent.agentId,
        this.listQueueEntries(normalizedSessionId, agent.agentId, { includeConsumed: false })
      );
    }

    return {
      sessionId: normalizedSessionId,
      createdAt: Math.min(...agents.map((agent) => Number(agent.createdAt ?? Date.now()))),
      updatedAt: Math.max(...agents.map((agent) => Number(agent.updatedAt ?? Date.now()))),
      metadata: {},
      primaryAgentId:
        agents.find((agent) => agent.isPrimary)?.agentId ?? buildPrimaryAgentId(normalizedSessionId),
      agents,
      publicPool,
      queueByAgent,
      sequenceCounter: Number(publicPool.at(-1)?.sequence ?? 0)
    };
  }

  deleteSession(sessionId) {
    const db = this.ensureDb();
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    db.exec("BEGIN TRANSACTION");
    try {
      db.prepare("DELETE FROM orchestrator_agent_queue WHERE session_id = ?").run(normalizedSessionId);
      db.prepare("DELETE FROM orchestrator_pool_deliveries WHERE session_id = ?").run(normalizedSessionId);
      db.prepare("DELETE FROM orchestrator_pool_entries WHERE session_id = ?").run(normalizedSessionId);
      db.prepare("DELETE FROM orchestrator_agents WHERE session_id = ?").run(normalizedSessionId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return true;
  }
}
