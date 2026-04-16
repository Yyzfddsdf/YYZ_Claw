function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeLineList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];
}

export function getOrchestratorSupervisor(executionContext = {}) {
  const supervisor = executionContext?.orchestratorSupervisorService;
  if (!supervisor || typeof supervisor !== "object") {
    throw new Error("orchestrator supervisor is unavailable");
  }
  return supervisor;
}

export function getConversationId(executionContext = {}) {
  const conversationId = normalizeText(executionContext?.conversationId);
  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  return conversationId;
}

export function getAgentId(executionContext = {}) {
  const agentId = normalizeText(executionContext?.agentId);
  if (!agentId) {
    throw new Error("agentId is required");
  }
  return agentId;
}

export function getCurrentAtomicStepId(executionContext = {}) {
  return normalizeText(executionContext?.currentAtomicStepId);
}

export function readStringArray(value) {
  return normalizeLineList(value);
}

export function readOptionalText(value) {
  return normalizeText(value);
}
