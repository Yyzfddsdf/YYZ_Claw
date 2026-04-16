function normalizeText(value) {
  return String(value ?? "").trim();
}

export function buildPrimaryAgentId(sessionId) {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required");
  }

  return `primary:${normalizedSessionId}`;
}

export function buildSubagentId(sessionId, agentType) {
  const normalizedSessionId = normalizeText(sessionId);
  const normalizedAgentType = normalizeText(agentType) || "generic";

  if (!normalizedSessionId) {
    throw new Error("sessionId is required");
  }

  return `subagent:${normalizedSessionId}:${normalizedAgentType}:${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export function isPrimaryAgentId(agentId = "") {
  return normalizeText(agentId).startsWith("primary:");
}

export function normalizeAgentStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["idle", "running", "waiting_approval", "deleted", "error"].includes(normalized)) {
    return normalized;
  }
  return "idle";
}

export function normalizeAgentType(value) {
  return normalizeText(value).toLowerCase() || "generic";
}

export function normalizeDisplayName(value, fallback = "") {
  return normalizeText(value) || fallback;
}

export function normalizeConversationId(value) {
  return normalizeText(value);
}

export function resolveAgentSessionId(conversation = {}) {
  const source = normalizeText(conversation?.source).toLowerCase();
  if (source === "subagent") {
    return normalizeConversationId(conversation?.parentConversationId);
  }
  return normalizeConversationId(conversation?.id);
}
