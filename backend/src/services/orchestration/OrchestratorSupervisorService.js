import { randomUUID } from "node:crypto";

import { buildPrimaryAgentId, buildSubagentId } from "./agentIdentity.js";

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

export class OrchestratorSupervisorService {
  constructor(options = {}) {
    this.historyStore = options.historyStore ?? null;
    this.orchestratorStore = options.orchestratorStore ?? null;
    this.schedulerService = options.schedulerService ?? null;
    this.wakeDispatcher = options.wakeDispatcher ?? null;
    this.subagentDefinitionRegistry = options.subagentDefinitionRegistry ?? null;
  }

  ensureSession(conversationId) {
    const history = this.historyStore.getConversation(conversationId);
    if (!history) {
      throw new Error(`conversation not found: ${conversationId}`);
    }

    const sessionId = history.source === "subagent"
      ? normalizeText(history.parentConversationId)
      : normalizeText(history.id);
    const primaryAgentId = buildPrimaryAgentId(sessionId);

    this.schedulerService.ensureSession(sessionId, {
      primaryAgentId,
      primaryConversationId: sessionId,
      primaryAgentType: "primary",
      primaryDisplayName: "主智能体",
      primaryMetadata: {
        conversationId: sessionId,
        displayName: "主智能体"
      }
    });
    this.orchestratorStore.ensurePrimaryAgent({
      sessionId,
      agentId: primaryAgentId,
      conversationId: sessionId,
      agentType: "primary",
      displayName: "主智能体",
      metadata: {
        conversationId: sessionId,
        displayName: "主智能体"
      }
    });

    return {
      sessionId,
      primaryAgentId,
      conversation: history
    };
  }

  createSubagent(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    const agentType = normalizeText(options.agentType).toLowerCase();
    if (!conversationId || !agentType) {
      throw new Error("conversationId and agentType are required");
    }

    const definition = this.subagentDefinitionRegistry.get(agentType);
    if (!definition) {
      throw new Error(`unknown subagent type: ${agentType}`);
    }

    const { sessionId, conversation } = this.ensureSession(conversationId);
    const activeSubagents = this.orchestratorStore.listAgents(sessionId, { includePrimary: false });
    if (activeSubagents.length >= 5) {
      throw new Error("subagent limit reached for this conversation");
    }

    const agentId = buildSubagentId(sessionId, definition.agentType);
    const subagentConversationId = `conv_${randomUUID()}`;
    const displayName = normalizeText(options.displayName) || definition.displayName;

    const subagentConversation = this.historyStore.upsertConversation({
      conversationId: subagentConversationId,
      title: displayName,
      workplacePath: conversation.workplacePath,
      parentConversationId: sessionId,
      source: "subagent",
      approvalMode: conversation.approvalMode,
      skills: [],
      developerPrompt: "",
      model: conversation.model,
      messages: []
    });

    const agentRecord = this.schedulerService.registerAgent({
      sessionId,
      agentId,
      agentType: definition.agentType,
      metadata: {
        conversationId: subagentConversationId,
        displayName
      }
    });
    this.orchestratorStore.upsertAgent({
      agentId,
      sessionId,
      conversationId: subagentConversationId,
      agentType: definition.agentType,
      displayName,
      isPrimary: false,
      status: "idle",
      metadata: {
        conversationId: subagentConversationId,
        displayName
      }
    });

    if (normalizeText(options.initialTask)) {
      void this.dispatchToAgent({
        conversationId: sessionId,
        sourceAgentId: buildPrimaryAgentId(sessionId),
        targetAgentId: agentId,
        subtype: "agent_dispatch",
        title: "初始任务",
        detailLines: [normalizeText(options.initialTask)]
      });
    }

    return {
      agent: {
        ...agentRecord,
        displayName,
        conversationId: subagentConversationId
      },
      history: subagentConversation
    };
  }

  listAvailableSubagentTypes() {
    return (this.subagentDefinitionRegistry?.list?.() ?? []).map((definition) => ({
      agentType: normalizeText(definition?.agentType).toLowerCase(),
      displayName: normalizeText(definition?.displayName),
      description: normalizeText(definition?.description),
      specialty: normalizeText(definition?.metadata?.specialty),
      inheritedBaseToolNames: normalizeLineList(definition?.inheritedBaseToolNames),
      inheritedBaseHookNames: normalizeLineList(definition?.inheritedBaseHookNames)
    }));
  }

  listSubagents(conversationId) {
    const { sessionId } = this.ensureSession(conversationId);
    return this.orchestratorStore
      .listAgents(sessionId, { includePrimary: false })
      .map((agent) => ({
        agentId: normalizeText(agent?.agentId),
        sessionId: normalizeText(agent?.sessionId),
        conversationId: normalizeText(agent?.conversationId),
        agentType: normalizeText(agent?.agentType),
        displayName: normalizeText(agent?.displayName),
        status: normalizeText(agent?.status) || "idle",
        lastActiveAt: Number(agent?.lastActiveAt ?? 0)
      }));
  }

  deleteSubagent(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    const agentId = normalizeText(options.agentId);
    const { sessionId } = this.ensureSession(conversationId);
    const agent = this.orchestratorStore.getAgent(agentId);
    if (!agent || agent.sessionId !== sessionId || agent.isPrimary) {
      return false;
    }

    if (agent.conversationId) {
      this.historyStore.deleteConversation(agent.conversationId);
    }
    this.schedulerService.unregisterAgent(sessionId, agentId);
    this.orchestratorStore.deleteAgent(agentId);
    return true;
  }

  async dispatchToAgent(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    const targetAgentId = normalizeText(options.targetAgentId);
    const subtype = normalizeText(options.subtype) || "agent_dispatch";
    if (!conversationId || !targetAgentId) {
      throw new Error("conversationId and targetAgentId are required");
    }

    const { sessionId, primaryAgentId } = this.ensureSession(conversationId);
    const sourceAgentId = normalizeText(options.sourceAgentId) || primaryAgentId;

    const queued = this.schedulerService.queueMessage({
      sessionId,
      targetAgentId,
      sourceAgentId,
      subtype,
      title: normalizeText(options.title),
      summaryLines: normalizeLineList(options.summaryLines),
      detailLines: normalizeLineList(options.detailLines),
      payload: options.payload ?? null,
      metadata: options.metadata ?? {}
    });

    await this.wakeDispatcher.wakeAgentIfNeeded({
      sessionId,
      agentId: targetAgentId
    });

    return queued;
  }

  async reportToPool(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    const sourceAgentId = normalizeText(options.sourceAgentId);
    if (!conversationId || !sourceAgentId) {
      throw new Error("conversationId and sourceAgentId are required");
    }

    const { sessionId, primaryAgentId } = this.ensureSession(conversationId);
    const agents = this.orchestratorStore.listAgents(sessionId, { includePrimary: false });
    const childAgentIds = agents.map((agent) => agent.agentId).filter((agentId) => agentId !== sourceAgentId);
    const fullBroadcastAgentIds = sourceAgentId === primaryAgentId ? [] : [primaryAgentId];

    const result = this.schedulerService.reportToPool({
      sessionId,
      sourceAgentId,
      atomicStepId: normalizeText(options.atomicStepId),
      subtype: normalizeText(options.subtype) || "agent_report",
      title: normalizeText(options.title),
      summaryLines: normalizeLineList(options.summaryLines),
      detailLines: normalizeLineList(options.detailLines),
      payload: options.payload ?? null,
      metadata: options.metadata ?? {},
      lightBroadcastAgentIds: childAgentIds,
      fullBroadcastAgentIds
    });

    for (const targetAgentId of [...childAgentIds, ...fullBroadcastAgentIds]) {
      await this.wakeDispatcher.wakeAgentIfNeeded({
        sessionId,
        agentId: targetAgentId
      });
    }

    return result;
  }

  async dispatchCompletionToPrimary(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    const sourceAgentId = normalizeText(options.sourceAgentId);
    if (!conversationId || !sourceAgentId) {
      throw new Error("conversationId and sourceAgentId are required");
    }

    const { sessionId, primaryAgentId } = this.ensureSession(conversationId);
    if (!primaryAgentId || sourceAgentId === primaryAgentId) {
      return null;
    }

    const title = normalizeText(options.title);
    const detailLines = normalizeLineList(options.detailLines);
    if (!title || detailLines.length === 0) {
      throw new Error("completion dispatch requires title and detailLines");
    }

    const queued = this.schedulerService.queueMessage({
      sessionId,
      targetAgentId: primaryAgentId,
      sourceAgentId,
      subtype: normalizeText(options.subtype) || "subagent_finish_report",
      deliveryMode: "queued_after_atomic",
      broadcastMode: "direct",
      atomicStepId: normalizeText(options.atomicStepId),
      title,
      summaryLines: normalizeLineList(options.summaryLines),
      detailLines,
      payload: options.payload ?? null,
      metadata: {
        completionReport: true,
        ...(options.metadata ?? {})
      }
    });

    await this.wakeDispatcher.wakeAgentIfNeeded({
      sessionId,
      agentId: primaryAgentId
    });

    return queued;
  }

  listPoolEntries(conversationId, options = {}) {
    const { sessionId } = this.ensureSession(conversationId);
    return this.orchestratorStore.listPoolEntries(sessionId, options);
  }

  readPoolEntry(conversationId, poolEntryId) {
    const { sessionId } = this.ensureSession(conversationId);
    const entry = this.orchestratorStore.getPoolEntryById(poolEntryId);
    return entry && entry.sessionId === sessionId ? entry : null;
  }
}
