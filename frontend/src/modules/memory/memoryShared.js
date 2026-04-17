export function formatMetaCount(label, count) {
  return `${label} ${Number(count ?? 0)}`;
}

export function formatTimeMeta(createdAt, updatedAt) {
  const created = String(createdAt ?? "").trim();
  const updated = String(updatedAt ?? "").trim();

  if (created && updated) {
    return `创建 ${created} · 更新 ${updated}`;
  }

  return updated || created || "无时间";
}

export function createRootSelection() {
  return {
    kind: "root",
    topicId: "",
    contentId: "",
    nodeId: ""
  };
}

export function createTopicSelection(topicId) {
  return {
    kind: "topic",
    topicId: String(topicId ?? "").trim(),
    contentId: "",
    nodeId: ""
  };
}

export function createContentSelection(topicId, contentId) {
  return {
    kind: "content",
    topicId: String(topicId ?? "").trim(),
    contentId: String(contentId ?? "").trim(),
    nodeId: ""
  };
}

export function createNodeSelection(topicId, contentId, nodeId) {
  return {
    kind: "node",
    topicId: String(topicId ?? "").trim(),
    contentId: String(contentId ?? "").trim(),
    nodeId: String(nodeId ?? "").trim()
  };
}

export function getSelectionKey(selection) {
  const normalizedSelection =
    selection && typeof selection === "object" ? selection : createRootSelection();

  switch (normalizedSelection.kind) {
    case "topic":
      return `topic:${normalizedSelection.topicId}`;
    case "content":
      return `content:${normalizedSelection.contentId}`;
    case "node":
      return `node:${normalizedSelection.nodeId}`;
    default:
      return "root:memory";
  }
}

export function normalizeKeywordList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .slice(0, 24)
    )
  );
}

export function formatKeywordList(value) {
  const keywords = normalizeKeywordList(value);
  return keywords.length > 0 ? keywords.join("，") : "无关键词";
}

export function keywordsToEditorText(value) {
  return normalizeKeywordList(value).join("\n");
}

export function parseKeywordEditorText(value) {
  const normalizedText = String(value ?? "").replace(/[，；;]/g, "\n");
  return Array.from(
    new Set(
      normalizedText
        .split(/\n+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 24)
    )
  );
}

export function clipText(value, maxLength = 96) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function buildTreeStats(topics) {
  const normalizedTopics = Array.isArray(topics) ? topics : [];
  return normalizedTopics.reduce(
    (accumulator, topic) => ({
      topicCount: accumulator.topicCount + 1,
      contentCount: accumulator.contentCount + Number(topic?.contentCount ?? 0),
      nodeCount: accumulator.nodeCount + Number(topic?.nodeCount ?? 0)
    }),
    { topicCount: 0, contentCount: 0, nodeCount: 0 }
  );
}
