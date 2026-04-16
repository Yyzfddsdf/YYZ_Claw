import {
  buildOrchestratorMessage,
  ORCHESTRATOR_MESSAGE_KIND
} from "../orchestratorMessage.js";

function normalizeLineList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    : [];
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildMessage(kind, context = {}) {
  return buildOrchestratorMessage({
    kind,
    sessionId: String(context.sessionId ?? "").trim(),
    sourceAgentId: String(context.sourceAgentId ?? "").trim(),
    targetAgentId: String(context.targetAgentId ?? "").trim(),
    subtype: String(context.subtype ?? "generic").trim() || "generic",
    deliveryMode: String(context.deliveryMode ?? "queued_after_atomic").trim()
      || "queued_after_atomic",
    broadcastMode: String(context.broadcastMode ?? "direct").trim() || "direct",
    atomicStepId: String(context.atomicStepId ?? "").trim(),
    title: String(context.title ?? "").trim(),
    summaryLines: normalizeLineList(context.summaryLines),
    detailLines: normalizeLineList(context.detailLines),
    payload: context.payload ?? null,
    metadata: normalizeMetadata(context.metadata)
  });
}

export function createOrchestratorMessageAdapter(options = {}) {
  const kind = String(options.kind ?? ORCHESTRATOR_MESSAGE_KIND).trim() || ORCHESTRATOR_MESSAGE_KIND;

  return {
    kind,
    buildQueuedMessage(context = {}) {
      return buildMessage(kind, context);
    },
    buildPoolBroadcastMessage(context = {}) {
      return buildMessage(kind, context);
    }
  };
}
