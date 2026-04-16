import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TOPIC_NAMES = ["偏好", "经历", "性格"];
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

function createId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function normalizeRequiredText(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeOptionalText(value) {
  return String(value ?? "").trim();
}

function normalizeKeywordArray(value, fieldName = "keywords") {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }

  const normalized = value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);

  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return Array.from(new Set(normalized));
}

function serializeKeywordArray(value, fieldName) {
  return JSON.stringify(normalizeKeywordArray(value, fieldName));
}

function parseStoredKeywordArray(value, fieldName) {
  try {
    return normalizeKeywordArray(JSON.parse(String(value ?? "[]")), fieldName);
  } catch {
    return [];
  }
}

function keywordListToText(value, fieldName) {
  return normalizeKeywordArray(value, fieldName).join(", ");
}

function mergeKeywordLists(specificKeywords, generalKeywords) {
  return Array.from(
    new Set([
      ...normalizeKeywordArray(specificKeywords, "specificKeywords"),
      ...normalizeKeywordArray(generalKeywords, "generalKeywords")
    ])
  );
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function createGregorianDateTime(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate())
  ].join("-") + ` ${[
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
    padDatePart(date.getSeconds())
  ].join(":")}`;
}

function isLegacyTimestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return true;
  }

  const normalized = String(value ?? "").trim();
  return /^\d{10,13}$/.test(normalized);
}

function normalizeStoredDateValue(value) {
  if (isLegacyTimestampValue(value)) {
    const numeric = Number(value);
    return createGregorianDateTime(new Date(numeric));
  }

  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function buildNodeFingerprint({
  name,
  coreMemory,
  explanation,
  specificKeywords,
  generalKeywords
}) {
  return [
    name,
    coreMemory,
    explanation,
    `specific:${keywordListToText(specificKeywords, "specificKeywords")}`,
    `general:${keywordListToText(generalKeywords, "generalKeywords")}`
  ]
    .map((item) => String(item ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean)
    .join("\n");
}

function createDuplicateNodeError(node, similarity, reason = "node") {
  const reasonText =
    reason === "name"
      ? `name similarity ${(similarity * 100).toFixed(1)}% >= 80%`
      : `similarity ${(similarity * 100).toFixed(1)}% >= 80%`;
  const error = new Error(
    `duplicate memory node detected: ${reasonText} with existing node "${node.name}" under "${node.topicName} / ${node.contentName}"`
  );
  error.statusCode = 409;
  return error;
}

function createDuplicateTopicError(topic, similarity) {
  const error = new Error(
    `duplicate topic detected: name similarity ${(similarity * 100).toFixed(1)}% >= 80% with existing topic "${topic.name}"`
  );
  error.statusCode = 409;
  return error;
}

function createDuplicateContentError(content, similarity) {
  const error = new Error(
    `duplicate content detected: name similarity ${(similarity * 100).toFixed(1)}% >= 80% with existing content "${content.name}" under topic "${content.topicName}"`
  );
  error.statusCode = 409;
  return error;
}

function normalizeRelationType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || "related_to";
}

function normalizeRelationReason(value) {
  return String(value ?? "").trim();
}

function createCanonicalRelationPair(leftNodeId, rightNodeId) {
  const left = normalizeRequiredText(leftNodeId, "fromNodeId");
  const right = normalizeRequiredText(rightNodeId, "toNodeId");

  if (left === right) {
    throw new Error("fromNodeId and toNodeId must be different");
  }

  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

function calculateLevenshteinDistance(leftText, rightText) {
  const left = String(leftText ?? "");
  const right = String(rightText ?? "");

  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index];
    }
  }

  return previous[right.length];
}

function calculateCharacterSimilarity(leftText, rightText) {
  const left = String(leftText ?? "");
  const right = String(rightText ?? "");
  const baseLength = Math.max(left.length, right.length);

  if (baseLength === 0) {
    return 1;
  }

  const distance = calculateLevenshteinDistance(left, right);
  return 1 - distance / baseLength;
}

function calculateCharacterOverlapSimilarity(leftText, rightText) {
  const left = Array.from(String(leftText ?? "").replace(/\s+/g, ""));
  const right = Array.from(String(rightText ?? "").replace(/\s+/g, ""));
  const baseLength = Math.max(left.length, right.length);

  if (baseLength === 0) {
    return 1;
  }

  const leftMap = new Map();
  const rightMap = new Map();

  for (const char of left) {
    leftMap.set(char, (leftMap.get(char) ?? 0) + 1);
  }

  for (const char of right) {
    rightMap.set(char, (rightMap.get(char) ?? 0) + 1);
  }

  let overlapCount = 0;
  for (const [char, leftCount] of leftMap.entries()) {
    overlapCount += Math.min(leftCount, rightMap.get(char) ?? 0);
  }

  return overlapCount / baseLength;
}

function calculateDuplicateSimilarity(leftText, rightText) {
  return Math.max(
    calculateCharacterSimilarity(leftText, rightText),
    calculateCharacterOverlapSimilarity(leftText, rightText)
  );
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return [];
  }

  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );
}

function calculateTokenOverlapSimilarity(leftText, rightText) {
  const leftTokens = tokenizeSearchText(leftText);
  const rightTokens = tokenizeSearchText(rightText);
  const baseLength = Math.max(leftTokens.length, rightTokens.length);

  if (baseLength === 0) {
    return 1;
  }

  const rightSet = new Set(rightTokens);
  let overlapCount = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      overlapCount += 1;
    }
  }

  return overlapCount / baseLength;
}

function calculateCandidateTextSimilarity(leftText, rightText) {
  return Math.max(
    calculateDuplicateSimilarity(leftText, rightText),
    calculateTokenOverlapSimilarity(leftText, rightText)
  );
}

function buildCandidateSearchText(parts = []) {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function rankCandidateResults(candidates = [], limit = 5) {
  const normalizedLimit = Number.isInteger(limit) ? Math.max(1, limit) : 5;

  return candidates
    .filter((candidate) => Number(candidate?.score ?? 0) > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    })
    .slice(0, normalizedLimit);
}

function calculateNodeFieldSimilarity(leftNode, rightNode, fieldName) {
  return calculateDuplicateSimilarity(leftNode?.[fieldName], rightNode?.[fieldName]);
}

function calculateNodeDuplicateSimilarity(leftNode, rightNode) {
  const combinedSimilarity = calculateDuplicateSimilarity(
    buildNodeFingerprint(leftNode),
    buildNodeFingerprint(rightNode)
  );

  const weightedSimilarity =
    calculateNodeFieldSimilarity(leftNode, rightNode, "name") * 0.34 +
    calculateNodeFieldSimilarity(leftNode, rightNode, "coreMemory") * 0.32 +
    calculateNodeFieldSimilarity(leftNode, rightNode, "specificKeywords") * 0.18 +
    calculateNodeFieldSimilarity(leftNode, rightNode, "generalKeywords") * 0.1 +
    calculateNodeFieldSimilarity(leftNode, rightNode, "explanation") * 0.06;

  return Math.max(combinedSimilarity, weightedSimilarity);
}

export class SqliteLongTermMemoryStore {
  constructor(options) {
    this.dbFilePath = path.resolve(String(options?.dbFilePath ?? ""));
    this.db = null;
    this.revision = 0;
  }

  async initialize() {
    if (!this.dbFilePath) {
      throw new Error("dbFilePath is required");
    }

    await fs.mkdir(path.dirname(this.dbFilePath), { recursive: true });

    this.db = new DatabaseSync(this.dbFilePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.resetLegacyNodeSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_topics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_contents (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(topic_id) REFERENCES memory_topics(id) ON DELETE CASCADE,
        UNIQUE(topic_id, name)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        content_id TEXT NOT NULL,
        name TEXT NOT NULL,
        core_memory TEXT NOT NULL,
        explanation TEXT NOT NULL,
        specific_keywords_json TEXT NOT NULL,
        general_keywords_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(content_id) REFERENCES memory_contents(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_node_relations (
        id TEXT PRIMARY KEY,
        node_a_id TEXT NOT NULL,
        node_b_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(node_a_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(node_b_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
        UNIQUE(node_a_id, node_b_id, relation_type)
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_contents_topic_id
      ON memory_contents(topic_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_content_id
      ON memory_nodes(content_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_node_relations_node_a
      ON memory_node_relations(node_a_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_node_relations_node_b
      ON memory_node_relations(node_b_id, updated_at DESC);
    `);

    this.migrateStoredDateValues();
    this.seedDefaultTopics();
  }

  ensureDb() {
    if (!this.db) {
      throw new Error("long-term memory store is not initialized");
    }

    return this.db;
  }

  bumpRevision() {
    this.revision += 1;
    return this.revision;
  }

  getRevision() {
    return this.revision;
  }

  resetLegacyNodeSchema() {
    const db = this.ensureDb();
    const memoryNodesExists = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'memory_nodes'
    `).get();

    if (!memoryNodesExists) {
      return;
    }

    const nodeColumns = db.prepare("PRAGMA table_info(memory_nodes)").all();
    const columnNames = new Set(nodeColumns.map((column) => String(column.name ?? "").trim()));
    const needsReset =
      columnNames.has("trigger_clues") ||
      columnNames.has("keywords") ||
      columnNames.has("keywords_json") ||
      !columnNames.has("specific_keywords_json") ||
      !columnNames.has("general_keywords_json");

    if (!needsReset) {
      return;
    }

    db.exec("BEGIN TRANSACTION");
    try {
      db.exec("DROP TABLE IF EXISTS memory_node_relations;");
      db.exec("DROP TABLE IF EXISTS memory_nodes;");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateStoredDateValues() {
    const db = this.ensureDb();
    const tableNames = [
      "memory_topics",
      "memory_contents",
      "memory_nodes",
      "memory_node_relations"
    ];

    for (const tableName of tableNames) {
      const rows = db.prepare(`
        SELECT id, created_at, updated_at
        FROM ${tableName}
      `).all();

      const update = db.prepare(`
        UPDATE ${tableName}
        SET created_at = ?, updated_at = ?
        WHERE id = ?
      `);

      db.exec("BEGIN TRANSACTION");
      try {
        for (const row of rows) {
          const nextCreatedAt = normalizeStoredDateValue(row.created_at);
          const nextUpdatedAt = normalizeStoredDateValue(row.updated_at);
          const currentCreatedAt = String(row.created_at ?? "");
          const currentUpdatedAt = String(row.updated_at ?? "");

          if (nextCreatedAt === currentCreatedAt && nextUpdatedAt === currentUpdatedAt) {
            continue;
          }

          update.run(nextCreatedAt, nextUpdatedAt, String(row.id));
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  seedDefaultTopics() {
    const db = this.ensureDb();
    const row = db.prepare("SELECT COUNT(*) AS count FROM memory_topics").get();
    const count = Number(row?.count ?? 0);

    if (count > 0) {
      return;
    }

    const now = createGregorianDateTime();
    const insert = db.prepare(`
      INSERT INTO memory_topics (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    db.exec("BEGIN TRANSACTION");
    try {
      for (const name of DEFAULT_TOPIC_NAMES) {
        insert.run(createId("topic"), name, now, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  mapTopicRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      name: String(row.name),
      contentCount: Number(row.content_count ?? 0),
      nodeCount: Number(row.node_count ?? 0),
      createdAt: normalizeStoredDateValue(row.created_at),
      updatedAt: normalizeStoredDateValue(row.updated_at)
    };
  }

  mapContentRow(row) {
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      topicId: String(row.topic_id),
      topicName: String(row.topic_name ?? ""),
      name: String(row.name),
      description: String(row.description ?? ""),
      nodeCount: Number(row.node_count ?? 0),
      createdAt: normalizeStoredDateValue(row.created_at),
      updatedAt: normalizeStoredDateValue(row.updated_at)
    };
  }

  mapNodeRow(row) {
    if (!row) {
      return null;
    }

    const specificKeywords = parseStoredKeywordArray(
      row.specific_keywords_json,
      "specificKeywords"
    );
    const generalKeywords = parseStoredKeywordArray(
      row.general_keywords_json,
      "generalKeywords"
    );

    return {
      id: String(row.id),
      contentId: String(row.content_id),
      contentName: String(row.content_name ?? ""),
      topicId: String(row.topic_id ?? ""),
      topicName: String(row.topic_name ?? ""),
      name: String(row.name),
      coreMemory: String(row.core_memory),
      explanation: String(row.explanation),
      specificKeywords,
      generalKeywords,
      keywords: mergeKeywordLists(specificKeywords, generalKeywords),
      createdAt: normalizeStoredDateValue(row.created_at),
      updatedAt: normalizeStoredDateValue(row.updated_at)
    };
  }

  mapNodeRelationRow(row, currentNodeId = "") {
    if (!row) {
      return null;
    }

    const normalizedCurrentNodeId = String(currentNodeId ?? "").trim();
    const nodeAId = String(row.node_a_id ?? "");
    const nodeBId = String(row.node_b_id ?? "");
    const isCurrentNodeA = normalizedCurrentNodeId
      ? nodeAId === normalizedCurrentNodeId
      : true;

    return {
      relationId: String(row.id),
      relationType: String(row.relation_type ?? ""),
      reason: String(row.reason ?? ""),
      createdAt: normalizeStoredDateValue(row.created_at),
      updatedAt: normalizeStoredDateValue(row.updated_at),
      memoryNodeId: String(
        isCurrentNodeA ? row.related_node_id ?? nodeBId : row.related_node_id ?? nodeAId
      ),
      memoryNodeName: String(row.related_node_name ?? ""),
      contentId: String(row.related_content_id ?? ""),
      contentName: String(row.related_content_name ?? ""),
      topicId: String(row.related_topic_id ?? ""),
      topicName: String(row.related_topic_name ?? "")
    };
  }

  listTopics() {
    const db = this.ensureDb();
    const rows = db.prepare(`
      SELECT
        t.id,
        t.name,
        t.created_at,
        t.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_contents c
          WHERE c.topic_id = t.id
        ) AS content_count,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          INNER JOIN memory_contents c ON c.id = n.content_id
          WHERE c.topic_id = t.id
        ) AS node_count
      FROM memory_topics t
      ORDER BY t.updated_at DESC, t.name COLLATE NOCASE ASC
    `).all();

    return rows.map((row) => this.mapTopicRow(row));
  }

  getTopicById(topicId) {
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT
        t.id,
        t.name,
        t.created_at,
        t.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_contents c
          WHERE c.topic_id = t.id
        ) AS content_count,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          INNER JOIN memory_contents c ON c.id = n.content_id
          WHERE c.topic_id = t.id
        ) AS node_count
      FROM memory_topics t
      WHERE t.id = ?
    `).get(String(topicId ?? "").trim());

    return this.mapTopicRow(row);
  }

  findTopicByName(topicName) {
    const db = this.ensureDb();
    const name = normalizeRequiredText(topicName, "topicName");
    const row = db.prepare(`
      SELECT
        t.id,
        t.name,
        t.created_at,
        t.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_contents c
          WHERE c.topic_id = t.id
        ) AS content_count,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          INNER JOIN memory_contents c ON c.id = n.content_id
          WHERE c.topic_id = t.id
        ) AS node_count
      FROM memory_topics t
      WHERE t.name = ?
    `).get(name);

    return this.mapTopicRow(row);
  }

  findSimilarTopicName({ name, excludeTopicIds = [] }) {
    const normalizedName = normalizeRequiredText(name, "name");
    const excludedIds = new Set(
      Array.isArray(excludeTopicIds)
        ? excludeTopicIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );

    let bestMatch = null;

    for (const topic of this.listTopics()) {
      if (excludedIds.has(topic.id)) {
        continue;
      }

      const similarity = calculateDuplicateSimilarity(normalizedName, topic.name);
      if (similarity < DUPLICATE_SIMILARITY_THRESHOLD) {
        continue;
      }

      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = {
          topic,
          similarity
        };
      }
    }

    return bestMatch;
  }

  assertTopicNameNotDuplicated({ name, excludeTopicIds = [] }) {
    const duplicateMatch = this.findSimilarTopicName({
      name,
      excludeTopicIds
    });

    if (!duplicateMatch) {
      return;
    }

    throw createDuplicateTopicError(duplicateMatch.topic, duplicateMatch.similarity);
  }

  getOrCreateTopic({ topicId, topicName, createIfMissing = false }) {
    const normalizedTopicId = normalizeOptionalText(topicId);
    if (normalizedTopicId) {
      const topic = this.getTopicById(normalizedTopicId);
      if (!topic) {
        throw new Error(`topic not found: ${normalizedTopicId}`);
      }
      return {
        topic,
        created: false
      };
    }

    const normalizedTopicName = normalizeOptionalText(topicName);
    if (!normalizedTopicName) {
      throw new Error("topicId or topicName is required");
    }

    const existingTopic = this.findTopicByName(normalizedTopicName);
    if (existingTopic) {
      return {
        topic: existingTopic,
        created: false
      };
    }

    if (!createIfMissing) {
      throw new Error(`topic not found: ${normalizedTopicName}`);
    }

    return {
      topic: this.createTopic({ name: normalizedTopicName }),
      created: true
    };
  }

  createTopic({ name }) {
    const db = this.ensureDb();
    const normalizedName = normalizeRequiredText(name, "name");
    const existing = this.findTopicByName(normalizedName);
    if (existing) {
      throw createDuplicateTopicError(existing, 1);
    }

    this.assertTopicNameNotDuplicated({
      name: normalizedName
    });

    const now = createGregorianDateTime();
    const id = createId("topic");
    db.prepare(`
      INSERT INTO memory_topics (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(id, normalizedName, now, now);
    this.bumpRevision();

    return this.getTopicById(id);
  }

  updateTopic({ topicId, name }) {
    const db = this.ensureDb();
    const existing = this.getTopicById(topicId);
    if (!existing) {
      throw new Error(`topic not found: ${String(topicId ?? "").trim()}`);
    }

    const normalizedName = normalizeRequiredText(name, "name");
    this.assertTopicNameNotDuplicated({
      name: normalizedName,
      excludeTopicIds: [existing.id]
    });
    db.prepare(`
      UPDATE memory_topics
      SET name = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizedName, createGregorianDateTime(), existing.id);
    this.bumpRevision();

    return this.getTopicById(existing.id);
  }

  deleteTopic(topicId) {
    const db = this.ensureDb();
    const existing = this.getTopicById(topicId);
    if (!existing) {
      throw new Error(`topic not found: ${String(topicId ?? "").trim()}`);
    }

    db.prepare("DELETE FROM memory_topics WHERE id = ?").run(existing.id);
    this.bumpRevision();
    return existing;
  }

  listContents({ topicId }) {
    const db = this.ensureDb();
    const normalizedTopicId = normalizeRequiredText(topicId, "topicId");
    const rows = db.prepare(`
      SELECT
        c.id,
        c.topic_id,
        t.name AS topic_name,
        c.name,
        c.description,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          WHERE n.content_id = c.id
        ) AS node_count
      FROM memory_contents c
      INNER JOIN memory_topics t ON t.id = c.topic_id
      WHERE c.topic_id = ?
      ORDER BY c.updated_at DESC, c.name COLLATE NOCASE ASC
    `).all(normalizedTopicId);

    return rows.map((row) => this.mapContentRow(row));
  }

  getContentById(contentId) {
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT
        c.id,
        c.topic_id,
        t.name AS topic_name,
        c.name,
        c.description,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          WHERE n.content_id = c.id
        ) AS node_count
      FROM memory_contents c
      INNER JOIN memory_topics t ON t.id = c.topic_id
      WHERE c.id = ?
    `).get(String(contentId ?? "").trim());

    return this.mapContentRow(row);
  }

  listAllContents() {
    const db = this.ensureDb();
    const rows = db.prepare(`
      SELECT
        c.id,
        c.topic_id,
        t.name AS topic_name,
        c.name,
        c.description,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          WHERE n.content_id = c.id
        ) AS node_count
      FROM memory_contents c
      INNER JOIN memory_topics t ON t.id = c.topic_id
      ORDER BY c.updated_at DESC, c.name COLLATE NOCASE ASC
    `).all();

    return rows.map((row) => this.mapContentRow(row));
  }

  findContentByName({ topicId, name }) {
    const db = this.ensureDb();
    const normalizedTopicId = normalizeRequiredText(topicId, "topicId");
    const normalizedName = normalizeRequiredText(name, "name");
    const row = db.prepare(`
      SELECT
        c.id,
        c.topic_id,
        t.name AS topic_name,
        c.name,
        c.description,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*)
          FROM memory_nodes n
          WHERE n.content_id = c.id
        ) AS node_count
      FROM memory_contents c
      INNER JOIN memory_topics t ON t.id = c.topic_id
      WHERE c.topic_id = ? AND c.name = ?
    `).get(normalizedTopicId, normalizedName);

    return this.mapContentRow(row);
  }

  findSimilarContentName({
    topicId,
    name,
    excludeContentIds = []
  }) {
    const normalizedTopicId = normalizeRequiredText(topicId, "topicId");
    const normalizedName = normalizeRequiredText(name, "name");
    const excludedIds = new Set(
      Array.isArray(excludeContentIds)
        ? excludeContentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );

    let bestMatch = null;

    for (const content of this.listContents({ topicId: normalizedTopicId })) {
      if (excludedIds.has(content.id)) {
        continue;
      }

      const similarity = calculateDuplicateSimilarity(normalizedName, content.name);
      if (similarity < DUPLICATE_SIMILARITY_THRESHOLD) {
        continue;
      }

      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = {
          content,
          similarity
        };
      }
    }

    return bestMatch;
  }

  assertContentNameNotDuplicated({
    topicId,
    name,
    excludeContentIds = []
  }) {
    const duplicateMatch = this.findSimilarContentName({
      topicId,
      name,
      excludeContentIds
    });

    if (!duplicateMatch) {
      return;
    }

    throw createDuplicateContentError(duplicateMatch.content, duplicateMatch.similarity);
  }

  getOrCreateContent({
    contentId,
    contentName,
    topicId,
    topicName,
    description = "",
    createIfMissing = false
  }) {
    const normalizedContentId = normalizeOptionalText(contentId);
    if (normalizedContentId) {
      const content = this.getContentById(normalizedContentId);
      if (!content) {
        throw new Error(`content not found: ${normalizedContentId}`);
      }
      return {
        content,
        topic: this.getTopicById(content.topicId),
        topicCreated: false,
        contentCreated: false
      };
    }

    const normalizedContentName = normalizeOptionalText(contentName);
    if (!normalizedContentName) {
      throw new Error("contentId or contentName is required");
    }

    const topicResult = this.getOrCreateTopic({
      topicId,
      topicName,
      createIfMissing
    });

    const existingContent = this.findContentByName({
      topicId: topicResult.topic.id,
      name: normalizedContentName
    });

    if (existingContent) {
      return {
        content: existingContent,
        topic: topicResult.topic,
        topicCreated: topicResult.created,
        contentCreated: false
      };
    }

    if (!createIfMissing) {
      throw new Error(`content not found: ${normalizedContentName}`);
    }

    return {
      content: this.createContent({
        topicId: topicResult.topic.id,
        name: normalizedContentName,
        description
      }),
      topic: topicResult.topic,
      topicCreated: topicResult.created,
      contentCreated: true
    };
  }

  createContent({ topicId, name, description = "" }) {
    const db = this.ensureDb();
    const topic = this.getTopicById(topicId);
    if (!topic) {
      throw new Error(`topic not found: ${String(topicId ?? "").trim()}`);
    }

    const normalizedName = normalizeRequiredText(name, "name");
    const normalizedDescription = normalizeOptionalText(description);
    const existing = this.findContentByName({
      topicId: topic.id,
      name: normalizedName
    });
    if (existing) {
      throw createDuplicateContentError(existing, 1);
    }

    this.assertContentNameNotDuplicated({
      topicId: topic.id,
      name: normalizedName
    });

    const now = createGregorianDateTime();
    const id = createId("content");
    db.exec("BEGIN TRANSACTION");
    try {
      db.prepare(`
        INSERT INTO memory_contents (id, topic_id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, topic.id, normalizedName, normalizedDescription, now, now);
      db.prepare(`
        UPDATE memory_topics
        SET updated_at = ?
        WHERE id = ?
      `).run(now, topic.id);
      db.exec("COMMIT");
      this.bumpRevision();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getContentById(id);
  }

  updateContent({ contentId, topicId, topicName, name, description }) {
    const db = this.ensureDb();
    const existing = this.getContentById(contentId);
    if (!existing) {
      throw new Error(`content not found: ${String(contentId ?? "").trim()}`);
    }

    let nextTopicId = existing.topicId;
    if (normalizeOptionalText(topicId) || normalizeOptionalText(topicName)) {
      const normalizedTopicId = normalizeOptionalText(topicId);
      if (!normalizedTopicId) {
        throw new Error("moving content requires an existing topicId");
      }

      const nextTopic = this.getTopicById(normalizedTopicId);
      if (!nextTopic) {
        throw new Error(`topic not found: ${normalizedTopicId}`);
      }
      nextTopicId = nextTopic.id;
    }

    const normalizedName =
      typeof name === "undefined" ? existing.name : normalizeRequiredText(name, "name");
    const normalizedDescription =
      typeof description === "undefined" ? existing.description : normalizeOptionalText(description);
    this.assertContentNameNotDuplicated({
      topicId: nextTopicId,
      name: normalizedName,
      excludeContentIds: [existing.id]
    });
    const now = createGregorianDateTime();

    db.exec("BEGIN TRANSACTION");
    try {
      db.prepare(`
        UPDATE memory_contents
        SET topic_id = ?, name = ?, description = ?, updated_at = ?
        WHERE id = ?
      `).run(nextTopicId, normalizedName, normalizedDescription, now, existing.id);
      db.prepare(`
        UPDATE memory_topics
        SET updated_at = ?
        WHERE id IN (?, ?)
      `).run(now, existing.topicId, nextTopicId);
      db.exec("COMMIT");
      this.bumpRevision();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getContentById(existing.id);
  }

  deleteContent(contentId) {
    const db = this.ensureDb();
    const existing = this.getContentById(contentId);
    if (!existing) {
      throw new Error(`content not found: ${String(contentId ?? "").trim()}`);
    }

    db.prepare("DELETE FROM memory_contents WHERE id = ?").run(existing.id);
    this.bumpRevision();
    return existing;
  }

  listNodes({ contentId }) {
    const db = this.ensureDb();
    const normalizedContentId = normalizeRequiredText(contentId, "contentId");
    const rows = db.prepare(`
      SELECT
        n.id,
        n.content_id,
        c.name AS content_name,
        c.topic_id,
        t.name AS topic_name,
        n.name,
        n.core_memory,
        n.explanation,
        n.specific_keywords_json,
        n.general_keywords_json,
        n.created_at,
        n.updated_at
      FROM memory_nodes n
      INNER JOIN memory_contents c ON c.id = n.content_id
      INNER JOIN memory_topics t ON t.id = c.topic_id
      WHERE n.content_id = ?
      ORDER BY n.updated_at DESC, n.created_at DESC
    `).all(normalizedContentId);

    return rows.map((row) => this.mapNodeRow(row));
  }

  getNodeById(nodeId) {
    const db = this.ensureDb();
    const row = db.prepare(`
      SELECT
        n.id,
        n.content_id,
        c.name AS content_name,
        c.topic_id,
        t.name AS topic_name,
        n.name,
        n.core_memory,
        n.explanation,
        n.specific_keywords_json,
        n.general_keywords_json,
        n.created_at,
        n.updated_at
      FROM memory_nodes n
      INNER JOIN memory_contents c ON c.id = n.content_id
      INNER JOIN memory_topics t ON t.id = c.topic_id
      WHERE n.id = ?
    `).get(String(nodeId ?? "").trim());

    return this.mapNodeRow(row);
  }

  listAllNodes() {
    const db = this.ensureDb();
    const rows = db.prepare(`
      SELECT
        n.id,
        n.content_id,
        c.name AS content_name,
        c.topic_id,
        t.name AS topic_name,
        n.name,
        n.core_memory,
        n.explanation,
        n.specific_keywords_json,
        n.general_keywords_json,
        n.created_at,
        n.updated_at
      FROM memory_nodes n
      INNER JOIN memory_contents c ON c.id = n.content_id
      INNER JOIN memory_topics t ON t.id = c.topic_id
      ORDER BY n.updated_at DESC, n.created_at DESC
    `).all();

    return rows.map((row) => this.mapNodeRow(row));
  }

  findTopicCandidates({
    topicName = "",
    contentName = "",
    name = "",
    specificKeywords = [],
    generalKeywords = [],
    limit = 5,
    excludeTopicIds = []
  } = {}) {
    const excludedIds = new Set(
      Array.isArray(excludeTopicIds)
        ? excludeTopicIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );
    const queryText = buildCandidateSearchText([
      topicName,
      contentName,
      name,
      specificKeywords,
      generalKeywords
    ]);

    return rankCandidateResults(
      this.listTopics().map((topic) => {
        if (excludedIds.has(topic.id)) {
          return null;
        }

        const exactNameSimilarity = topicName
          ? calculateDuplicateSimilarity(topicName, topic.name)
          : 0;
        const querySimilarity = queryText
          ? calculateCandidateTextSimilarity(queryText, topic.name)
          : 0;
        const score = Math.max(exactNameSimilarity, querySimilarity);

        return {
          topicId: topic.id,
          topicName: topic.name,
          createdAt: topic.createdAt,
          updatedAt: topic.updatedAt,
          score
        };
      }),
      limit
    );
  }

  findContentCandidates({
    topicId = "",
    topicName = "",
    contentName = "",
    name = "",
    specificKeywords = [],
    generalKeywords = [],
    limit = 5,
    excludeContentIds = []
  } = {}) {
    const normalizedTopicId = normalizeOptionalText(topicId);
    const excludedIds = new Set(
      Array.isArray(excludeContentIds)
        ? excludeContentIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );
    const queryText = buildCandidateSearchText([
      topicName,
      contentName,
      name,
      specificKeywords,
      generalKeywords
    ]);
    const contentPool = normalizedTopicId
      ? this.listContents({ topicId: normalizedTopicId })
      : this.listAllContents();

    return rankCandidateResults(
      contentPool.map((content) => {
        if (excludedIds.has(content.id)) {
          return null;
        }

        const exactNameSimilarity = contentName
          ? calculateDuplicateSimilarity(contentName, content.name)
          : 0;
        const topicNameSimilarity = topicName
          ? calculateDuplicateSimilarity(topicName, content.topicName)
          : 0;
        const querySimilarity = queryText
          ? calculateCandidateTextSimilarity(
              queryText,
              buildCandidateSearchText([content.topicName, content.name, content.description])
            )
          : 0;
        const score = Math.max(
          exactNameSimilarity,
          querySimilarity,
          Math.min(1, topicNameSimilarity * 0.85 + exactNameSimilarity * 0.15)
        );

        return {
          contentId: content.id,
          contentName: content.name,
          topicId: content.topicId,
          topicName: content.topicName,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt,
          score
        };
      }),
      limit
    );
  }

  findNodeCandidates({
    name = "",
    coreMemory = "",
    explanation = "",
    specificKeywords = [],
    generalKeywords = [],
    limit = 5,
    excludeNodeIds = []
  } = {}) {
    const normalizedName = normalizeOptionalText(name);
    const normalizedCoreMemory = normalizeOptionalText(coreMemory);
    const normalizedExplanation = normalizeOptionalText(explanation);
    const normalizedSpecificKeywords = Array.isArray(specificKeywords)
      ? normalizeKeywordArray(specificKeywords, "specificKeywords")
      : [];
    const normalizedGeneralKeywords = Array.isArray(generalKeywords)
      ? normalizeKeywordArray(generalKeywords, "generalKeywords")
      : [];
    const excludedIds = new Set(
      Array.isArray(excludeNodeIds)
        ? excludeNodeIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );
    const queryText = buildCandidateSearchText([
      normalizedName,
      normalizedCoreMemory,
      normalizedExplanation,
      normalizedSpecificKeywords,
      normalizedGeneralKeywords
    ]);

    return rankCandidateResults(
      this.listAllNodes().map((node) => {
        if (excludedIds.has(node.id)) {
          return null;
        }

        const duplicateSimilarity = calculateNodeDuplicateSimilarity(
          {
            name: normalizedName,
            coreMemory: normalizedCoreMemory,
            explanation: normalizedExplanation,
            specificKeywords: normalizedSpecificKeywords,
            generalKeywords: normalizedGeneralKeywords
          },
          {
            name: node.name,
            coreMemory: node.coreMemory,
            explanation: node.explanation,
            specificKeywords: node.specificKeywords,
            generalKeywords: node.generalKeywords
          }
        );
        const exactNameSimilarity = normalizedName
          ? calculateDuplicateSimilarity(normalizedName, node.name)
          : 0;
        const querySimilarity = queryText
          ? calculateCandidateTextSimilarity(
              queryText,
              buildCandidateSearchText([
                node.name,
                node.coreMemory,
                node.explanation,
                node.specificKeywords,
                node.generalKeywords
              ])
            )
          : 0;
        const score = Math.max(duplicateSimilarity, exactNameSimilarity, querySimilarity);

        return {
          memoryNodeId: node.id,
          memoryNodeName: node.name,
          contentId: node.contentId,
          contentName: node.contentName,
          topicId: node.topicId,
          topicName: node.topicName,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          score
        };
      }),
      limit
    );
  }

  findMemoryWriteCandidates({
    topicName = "",
    contentName = "",
    name = "",
    coreMemory = "",
    explanation = "",
    specificKeywords = [],
    generalKeywords = [],
    limit = 5,
    excludeTopicIds = [],
    excludeContentIds = [],
    excludeNodeIds = []
  } = {}) {
    const topics = this.findTopicCandidates({
      topicName,
      contentName,
      name,
      specificKeywords,
      generalKeywords,
      limit,
      excludeTopicIds
    });
    const contents = this.findContentCandidates({
      topicName,
      contentName,
      name,
      specificKeywords,
      generalKeywords,
      limit,
      excludeContentIds
    });
    const nodes = this.findNodeCandidates({
      name,
      coreMemory,
      explanation,
      specificKeywords,
      generalKeywords,
      limit,
      excludeNodeIds
    });

    const topNodeScore = Number(nodes[0]?.score ?? 0);
    const topContentScore = Number(contents[0]?.score ?? 0);
    const topTopicScore = Number(topics[0]?.score ?? 0);

    let recommendedAction = "create_new_structure_only_if_truly_needed";
    if (topNodeScore >= DUPLICATE_SIMILARITY_THRESHOLD) {
      recommendedAction = "update_or_merge_existing_node";
    } else if (topNodeScore >= 0.6) {
      recommendedAction = "review_existing_node_candidates_before_create";
    } else if (topContentScore >= DUPLICATE_SIMILARITY_THRESHOLD) {
      recommendedAction = "create_node_in_existing_content";
    } else if (topContentScore >= 0.6) {
      recommendedAction = "review_existing_content_candidates_before_create";
    } else if (topTopicScore >= DUPLICATE_SIMILARITY_THRESHOLD) {
      recommendedAction = "create_content_in_existing_topic";
    } else if (topTopicScore >= 0.6) {
      recommendedAction = "review_existing_topic_candidates_before_create";
    }

    return {
      recommendedAction,
      topicCandidates: topics,
      contentCandidates: contents,
      nodeCandidates: nodes
    };
  }

  listNodeRelations(nodeId) {
    const db = this.ensureDb();
    const currentNode = this.getNodeById(nodeId);
    if (!currentNode) {
      throw new Error(`node not found: ${String(nodeId ?? "").trim()}`);
    }

    const rows = db.prepare(`
      SELECT
        r.id,
        r.node_a_id,
        r.node_b_id,
        r.relation_type,
        r.reason,
        r.created_at,
        r.updated_at,
        related.id AS related_node_id,
        related.name AS related_node_name,
        related_content.id AS related_content_id,
        related_content.name AS related_content_name,
        related_topic.id AS related_topic_id,
        related_topic.name AS related_topic_name
      FROM memory_node_relations r
      INNER JOIN memory_nodes related
        ON related.id = CASE
          WHEN r.node_a_id = ? THEN r.node_b_id
          ELSE r.node_a_id
        END
      INNER JOIN memory_contents related_content ON related_content.id = related.content_id
      INNER JOIN memory_topics related_topic ON related_topic.id = related_content.topic_id
      WHERE r.node_a_id = ? OR r.node_b_id = ?
      ORDER BY r.updated_at DESC, r.created_at DESC
    `).all(currentNode.id, currentNode.id, currentNode.id);

    return rows.map((row) => this.mapNodeRelationRow(row, currentNode.id));
  }

  createNodeRelation({
    fromNodeId,
    toNodeId,
    relationType = "related_to",
    reason = ""
  }) {
    const db = this.ensureDb();
    const requestedFromNodeId = normalizeRequiredText(fromNodeId, "fromNodeId");
    const requestedToNodeId = normalizeRequiredText(toNodeId, "toNodeId");
    const [nodeAId, nodeBId] = createCanonicalRelationPair(fromNodeId, toNodeId);
    const nodeA = this.getNodeById(nodeAId);
    const nodeB = this.getNodeById(nodeBId);

    if (!nodeA) {
      throw new Error(`node not found: ${String(nodeAId ?? "").trim()}`);
    }

    if (!nodeB) {
      throw new Error(`node not found: ${String(nodeBId ?? "").trim()}`);
    }

    const normalizedRelationType = normalizeRelationType(relationType);
    const normalizedReason = normalizeRelationReason(reason);
    const existing = db.prepare(`
      SELECT id
      FROM memory_node_relations
      WHERE node_a_id = ? AND node_b_id = ? AND relation_type = ?
    `).get(nodeAId, nodeBId, normalizedRelationType);

    const now = createGregorianDateTime();

    if (existing?.id) {
      db.prepare(`
        UPDATE memory_node_relations
        SET reason = ?, updated_at = ?
        WHERE id = ?
      `).run(normalizedReason, now, String(existing.id));

      return {
        action: "updated",
        relation: this.listNodeRelations(requestedFromNodeId).find(
          (relation) =>
            relation.relationId === String(existing.id) &&
            relation.memoryNodeId === requestedToNodeId
        ) ?? null
      };
    }

    const relationId = createId("relation");
    db.prepare(`
      INSERT INTO memory_node_relations (
        id,
        node_a_id,
        node_b_id,
        relation_type,
        reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      relationId,
      nodeAId,
      nodeBId,
      normalizedRelationType,
      normalizedReason,
      now,
      now
    );

    return {
      action: "created",
      relation: this.listNodeRelations(requestedFromNodeId).find(
        (relation) =>
          relation.relationId === relationId &&
          relation.memoryNodeId === requestedToNodeId
      ) ?? null
    };
  }

  findSimilarNode({
    contentId,
    name,
    coreMemory,
    explanation,
    specificKeywords,
    generalKeywords,
    excludeNodeIds = []
  }) {
    void contentId;
    const excludedIds = new Set(
      Array.isArray(excludeNodeIds)
        ? excludeNodeIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );

    let bestMatch = null;

    for (const node of this.listAllNodes()) {
      if (excludedIds.has(node.id)) {
        continue;
      }

      const similarity = calculateNodeDuplicateSimilarity(
        {
          name,
          coreMemory,
          explanation,
          specificKeywords,
          generalKeywords
        },
        {
          name: node.name,
          coreMemory: node.coreMemory,
          explanation: node.explanation,
          specificKeywords: node.specificKeywords,
          generalKeywords: node.generalKeywords
        }
      );

      if (similarity < DUPLICATE_SIMILARITY_THRESHOLD) {
        continue;
      }

      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = {
          node,
          similarity
        };
      }
    }

    return bestMatch;
  }

  findSimilarNodeName({
    contentId,
    name,
    excludeNodeIds = []
  }) {
    void contentId;
    const normalizedName = normalizeRequiredText(name, "name");
    const excludedIds = new Set(
      Array.isArray(excludeNodeIds)
        ? excludeNodeIds.map((item) => String(item ?? "").trim()).filter(Boolean)
        : []
    );

    let bestMatch = null;

    for (const node of this.listAllNodes()) {
      if (excludedIds.has(node.id)) {
        continue;
      }

      const similarity = calculateDuplicateSimilarity(normalizedName, node.name);
      if (similarity < DUPLICATE_SIMILARITY_THRESHOLD) {
        continue;
      }

      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = {
          node,
          similarity
        };
      }
    }

    return bestMatch;
  }

  assertNodeNotDuplicated({
    contentId,
    name,
    coreMemory,
    explanation,
    specificKeywords,
    generalKeywords,
    excludeNodeIds = []
  }) {
    const duplicateNameMatch = this.findSimilarNodeName({
      contentId,
      name,
      excludeNodeIds
    });

    if (duplicateNameMatch) {
      throw createDuplicateNodeError(
        duplicateNameMatch.node,
        duplicateNameMatch.similarity,
        "name"
      );
    }

    const duplicateMatch = this.findSimilarNode({
      contentId,
      name,
      coreMemory,
      explanation,
      specificKeywords,
      generalKeywords,
      excludeNodeIds
    });

    if (!duplicateMatch) {
      return;
    }

    throw createDuplicateNodeError(duplicateMatch.node, duplicateMatch.similarity, "node");
  }

  createNode({
    contentId,
    name,
    coreMemory,
    explanation,
    specificKeywords,
    generalKeywords,
    ignoreDuplicateNodeIds = []
  }) {
    const db = this.ensureDb();
    const content = this.getContentById(contentId);
    if (!content) {
      throw new Error(`content not found: ${String(contentId ?? "").trim()}`);
    }

    const normalizedName = normalizeRequiredText(name, "name");
    const normalizedCoreMemory = normalizeRequiredText(coreMemory, "coreMemory");
    const normalizedExplanation = normalizeRequiredText(explanation, "explanation");
    const normalizedSpecificKeywords = normalizeKeywordArray(
      specificKeywords,
      "specificKeywords"
    );
    const normalizedGeneralKeywords = normalizeKeywordArray(
      generalKeywords,
      "generalKeywords"
    );
    this.assertNodeNotDuplicated({
      contentId: content.id,
      name: normalizedName,
      coreMemory: normalizedCoreMemory,
      explanation: normalizedExplanation,
      specificKeywords: normalizedSpecificKeywords,
      generalKeywords: normalizedGeneralKeywords,
      excludeNodeIds: ignoreDuplicateNodeIds
    });

    const now = createGregorianDateTime();
    const id = createId("node");

    db.exec("BEGIN TRANSACTION");
    try {
      db.prepare(`
        INSERT INTO memory_nodes (
          id,
          content_id,
          name,
          core_memory,
          explanation,
          specific_keywords_json,
          general_keywords_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        content.id,
        normalizedName,
        normalizedCoreMemory,
        normalizedExplanation,
        serializeKeywordArray(normalizedSpecificKeywords, "specificKeywords"),
        serializeKeywordArray(normalizedGeneralKeywords, "generalKeywords"),
        now,
        now
      );
      db.prepare(`
        UPDATE memory_contents
        SET updated_at = ?
        WHERE id = ?
      `).run(now, content.id);
      db.prepare(`
        UPDATE memory_topics
        SET updated_at = ?
        WHERE id = ?
      `).run(now, content.topicId);
      db.exec("COMMIT");
      this.bumpRevision();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getNodeById(id);
  }

  updateNode({
    nodeId,
    contentId,
    topicId,
    topicName,
    contentName,
    name,
    coreMemory,
    explanation,
    specificKeywords,
    generalKeywords
  }) {
    const db = this.ensureDb();
    const existing = this.getNodeById(nodeId);
    if (!existing) {
      throw new Error(`node not found: ${String(nodeId ?? "").trim()}`);
    }

    let nextContentId = existing.contentId;
    if (
      normalizeOptionalText(contentId) ||
      normalizeOptionalText(contentName) ||
      normalizeOptionalText(topicId) ||
      normalizeOptionalText(topicName)
    ) {
      const normalizedContentId = normalizeOptionalText(contentId);
      if (!normalizedContentId) {
        throw new Error("moving memory node requires an existing contentId");
      }

      const nextContent = this.getContentById(normalizedContentId);
      if (!nextContent) {
        throw new Error(`content not found: ${normalizedContentId}`);
      }
      nextContentId = nextContent.id;
    }

    const normalizedName =
      typeof name === "undefined" ? existing.name : normalizeRequiredText(name, "name");
    const normalizedCoreMemory =
      typeof coreMemory === "undefined"
        ? existing.coreMemory
        : normalizeRequiredText(coreMemory, "coreMemory");
    const normalizedExplanation =
      typeof explanation === "undefined"
        ? existing.explanation
        : normalizeRequiredText(explanation, "explanation");
    const normalizedSpecificKeywords =
      typeof specificKeywords === "undefined"
        ? existing.specificKeywords
        : normalizeKeywordArray(specificKeywords, "specificKeywords");
    const normalizedGeneralKeywords =
      typeof generalKeywords === "undefined"
        ? existing.generalKeywords
        : normalizeKeywordArray(generalKeywords, "generalKeywords");
    this.assertNodeNotDuplicated({
      contentId: nextContentId,
      name: normalizedName,
      coreMemory: normalizedCoreMemory,
      explanation: normalizedExplanation,
      specificKeywords: normalizedSpecificKeywords,
      generalKeywords: normalizedGeneralKeywords,
      excludeNodeIds: [existing.id]
    });

    const now = createGregorianDateTime();

    db.exec("BEGIN TRANSACTION");
    try {
      db.prepare(`
        UPDATE memory_nodes
        SET
          content_id = ?,
          name = ?,
          core_memory = ?,
          explanation = ?,
          specific_keywords_json = ?,
          general_keywords_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        nextContentId,
        normalizedName,
        normalizedCoreMemory,
        normalizedExplanation,
        serializeKeywordArray(normalizedSpecificKeywords, "specificKeywords"),
        serializeKeywordArray(normalizedGeneralKeywords, "generalKeywords"),
        now,
        existing.id
      );

      const existingContent = this.getContentById(existing.contentId);
      const nextContent = this.getContentById(nextContentId);

      db.prepare(`
        UPDATE memory_contents
        SET updated_at = ?
        WHERE id IN (?, ?)
      `).run(now, existing.contentId, nextContentId);

      if (existingContent?.topicId || nextContent?.topicId) {
        db.prepare(`
          UPDATE memory_topics
          SET updated_at = ?
          WHERE id IN (?, ?)
        `).run(now, existingContent?.topicId ?? "", nextContent?.topicId ?? "");
      }

      db.exec("COMMIT");
      this.bumpRevision();
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return this.getNodeById(existing.id);
  }

  deleteNode(nodeId) {
    const db = this.ensureDb();
    const existing = this.getNodeById(nodeId);
    if (!existing) {
      throw new Error(`node not found: ${String(nodeId ?? "").trim()}`);
    }

    db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(existing.id);
    this.bumpRevision();
    return existing;
  }

  mergeNodes({
    nodeIds,
    contentId,
    topicId,
    topicName,
    contentName,
    name,
    coreMemory,
    explanation,
    specificKeywords,
    generalKeywords,
    deleteSource = true
  }) {
    const db = this.ensureDb();
    const normalizedNodeIds = Array.isArray(nodeIds)
      ? Array.from(new Set(nodeIds.map((item) => String(item ?? "").trim()).filter(Boolean)))
      : [];

    if (normalizedNodeIds.length < 2) {
      throw new Error("at least two nodeIds are required");
    }

    const sourceNodes = normalizedNodeIds.map((nodeId) => this.getNodeById(nodeId));
    if (sourceNodes.some((node) => !node)) {
      throw new Error("one or more source nodes do not exist");
    }

    let targetContentId = normalizeOptionalText(contentId);
    if (!targetContentId && !normalizeOptionalText(contentName)) {
      const uniqueContentIds = new Set(sourceNodes.map((node) => node.contentId));
      if (uniqueContentIds.size !== 1) {
        throw new Error(
          "source nodes span multiple contents; provide an existing contentId"
        );
      }
      targetContentId = sourceNodes[0].contentId;
    }
    if (!targetContentId) {
      throw new Error("merge target requires an existing contentId");
    }

    const targetContent = this.getContentById(targetContentId);
    if (!targetContent) {
      throw new Error(`content not found: ${targetContentId}`);
    }

    const mergedNode = this.createNode({
      contentId: targetContent.id,
      name,
      coreMemory,
      explanation,
      specificKeywords,
      generalKeywords,
      ignoreDuplicateNodeIds: normalizedNodeIds
    });

    if (deleteSource) {
      db.prepare(`
        DELETE FROM memory_nodes
        WHERE id IN (${normalizedNodeIds.map(() => "?").join(", ")})
      `).run(...normalizedNodeIds);
      this.bumpRevision();
    }

    return {
      mergedNode: this.getNodeById(mergedNode.id),
      deletedSourceCount: deleteSource ? normalizedNodeIds.length : 0,
      sourceNodes
    };
  }

  getTopicTree({ topicId, includeNodes = false }) {
    const topic = this.getTopicById(topicId);
    if (!topic) {
      return null;
    }

    const contents = this.listContents({ topicId: topic.id }).map((content) =>
      includeNodes
        ? {
            ...content,
            nodes: this.listNodes({ contentId: content.id })
          }
        : { ...content }
    );

    return {
      ...topic,
      contents
    };
  }

  getContentTree(contentId) {
    const content = this.getContentById(contentId);
    if (!content) {
      return null;
    }

    return {
      ...content,
      nodes: this.listNodes({ contentId: content.id }).map((node) => ({
        ...node,
        relatedMemoryNodes: this.listNodeRelations(node.id)
      }))
    };
  }

  getNodeContextTree(nodeId) {
    const node = this.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    const content = this.getContentById(node.contentId);
    const topic = content ? this.getTopicById(content.topicId) : null;

    return {
      topic,
      content,
      node
    };
  }
}
