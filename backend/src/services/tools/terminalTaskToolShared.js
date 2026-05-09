function normalizeText(value) {
  return String(value ?? "").trim();
}

export function getBackgroundTaskService(executionContext = {}) {
  const service = executionContext?.backgroundTaskService;
  if (!service || typeof service !== "object") {
    throw new Error("background task service is unavailable");
  }
  return service;
}

export function getRequiredConversationId(executionContext = {}) {
  const conversationId = normalizeText(executionContext?.conversationId);
  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  return conversationId;
}

export function getContextWorkingDirectory(executionContext = {}, explicitCwd = "") {
  const candidate = normalizeText(explicitCwd)
    || normalizeText(executionContext?.workingDirectory)
    || normalizeText(executionContext?.workplacePath);
  if (!candidate) {
    throw new Error("working directory is required");
  }
  return candidate;
}

export function getRequesterName(executionContext = {}) {
  return normalizeText(executionContext?.agentId)
    || normalizeText(executionContext?.runId)
    || "conversation";
}

export function readOptionalPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(numeric));
}
