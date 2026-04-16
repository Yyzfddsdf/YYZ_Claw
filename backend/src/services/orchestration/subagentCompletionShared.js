import { buildPrimaryAgentId } from "./agentIdentity.js";

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

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function getTurnRuntime(executionContext = {}) {
  const turnRuntime =
    executionContext?.turnRuntime && typeof executionContext.turnRuntime === "object"
      ? executionContext.turnRuntime
      : {};
  executionContext.turnRuntime = turnRuntime;
  return turnRuntime;
}

function findLastUserMessage(messages = []) {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (normalizeText(message?.role) === "user") {
      return message;
    }
  }

  return null;
}

function buildFallbackTitle(displayName = "", agentType = "") {
  const normalizedDisplayName = normalizeText(displayName);
  if (normalizedDisplayName) {
    return `${normalizedDisplayName}结果`;
  }

  const normalizedAgentType = normalizeText(agentType);
  if (normalizedAgentType) {
    return `${normalizedAgentType}结果`;
  }

  return "子智能体结果";
}

export function resolveCurrentTurnDispatchTrigger(executionContext = {}) {
  const turnRuntime = getTurnRuntime(executionContext);
  if (turnRuntime.currentTurnDispatchTrigger) {
    return turnRuntime.currentTurnDispatchTrigger;
  }

  const sessionId = normalizeText(executionContext?.sessionId);
  const primaryAgentId = sessionId ? buildPrimaryAgentId(sessionId) : "";
  const currentAgentId = normalizeText(executionContext?.agentId);
  const currentUserMessage = findLastUserMessage(executionContext?.rawConversationMessages);
  const meta = normalizeObject(currentUserMessage?.meta);
  const orchestrator = normalizeObject(meta.orchestrator);
  const kind = normalizeText(meta.kind);
  const subtype = normalizeText(meta.subtype || orchestrator.subtype);
  const sourceAgentId = normalizeText(orchestrator.sourceAgentId);
  const targetAgentId = normalizeText(orchestrator.targetAgentId);
  const isPrimaryDispatchTurn =
    Boolean(currentUserMessage) &&
    kind === "orchestrator_message" &&
    subtype === "agent_dispatch" &&
    Boolean(primaryAgentId) &&
    sourceAgentId === primaryAgentId &&
    (!currentAgentId || !targetAgentId || currentAgentId === targetAgentId);

  const trigger = {
    messageId: normalizeText(currentUserMessage?.id),
    kind,
    subtype,
    sourceAgentId,
    targetAgentId,
    isPrimaryDispatchTurn
  };

  turnRuntime.currentTurnDispatchTrigger = trigger;
  executionContext.currentTurnDispatchTrigger = trigger;
  return trigger;
}

export function recordSubagentFinishReport(executionContext = {}, options = {}) {
  const trigger = resolveCurrentTurnDispatchTrigger(executionContext);
  if (!trigger.isPrimaryDispatchTurn) {
    return {
      accepted: false,
      reason: "not_primary_dispatch_turn",
      delivery: "skipped",
      onlyToPrimary: true,
      trigger
    };
  }

  const title = normalizeText(options.title);
  const detailLines = normalizeLineList(options.detailLines);
  if (!title || detailLines.length === 0) {
    throw new Error("subagent_finish_report requires title and at least one detail line");
  }

  const report = {
    subtype: normalizeText(options.subtype) || "subagent_finish_report",
    title,
    summaryLines: normalizeLineList(options.summaryLines),
    detailLines,
    payload: normalizeObject(options.payload),
    atomicStepId: normalizeText(executionContext?.currentAtomicStepId),
    explicit: true,
    createdAt: Date.now()
  };

  const turnRuntime = getTurnRuntime(executionContext);
  turnRuntime.subagentFinishReport = report;

  return {
    accepted: true,
    delivery: "deferred_to_turn_end",
    onlyToPrimary: true,
    trigger,
    report: {
      ...report
    }
  };
}

export function resolveSubagentCompletionDispatchRequest(options = {}) {
  const executionContext = options?.executionContext ?? {};
  const status = normalizeText(options?.status).toLowerCase();
  if (status && !["idle", "completed"].includes(status)) {
    return null;
  }

  const sourceAgentId = normalizeText(executionContext?.agentId);
  const conversationId = normalizeText(executionContext?.conversationId);
  if (!sourceAgentId || !conversationId) {
    return null;
  }

  const trigger = resolveCurrentTurnDispatchTrigger(executionContext);
  if (!trigger.isPrimaryDispatchTurn) {
    return null;
  }

  const turnRuntime = getTurnRuntime(executionContext);
  const explicitReport =
    turnRuntime?.subagentFinishReport && typeof turnRuntime.subagentFinishReport === "object"
      ? turnRuntime.subagentFinishReport
      : null;

  if (explicitReport) {
    return {
      conversationId,
      sourceAgentId,
      atomicStepId: normalizeText(explicitReport.atomicStepId || executionContext?.currentAtomicStepId),
      subtype: normalizeText(explicitReport.subtype) || "subagent_finish_report",
      title: normalizeText(explicitReport.title),
      summaryLines: normalizeLineList(explicitReport.summaryLines),
      detailLines: normalizeLineList(explicitReport.detailLines),
      payload: {
        ...normalizeObject(explicitReport.payload),
        source: "explicit_finish_report",
        triggerSubtype: trigger.subtype,
        triggerSourceAgentId: trigger.sourceAgentId
      },
      metadata: {
        completionReport: true,
        explicit: true
      }
    };
  }

  const assistantText = normalizeText(options?.runResult?.assistantText);
  if (!assistantText) {
    return null;
  }

  return {
    conversationId,
    sourceAgentId,
    atomicStepId: normalizeText(executionContext?.currentAtomicStepId),
    subtype: "subagent_finish_report",
    title: buildFallbackTitle(options?.displayName, options?.agentType),
    summaryLines: [],
    detailLines: [assistantText],
    payload: {
      source: "assistant_final_output_fallback",
      triggerSubtype: trigger.subtype,
      triggerSourceAgentId: trigger.sourceAgentId
    },
    metadata: {
      completionReport: true,
      explicit: false,
      fallback: true
    }
  };
}
