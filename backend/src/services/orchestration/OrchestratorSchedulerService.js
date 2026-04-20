const DEFAULT_MAX_POOL_ENTRIES = 500;
const DEFAULT_MAX_AGENT_QUEUE = 200;

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeLineList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    : [];
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeAgentId(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeDisplayName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fallbackAgentDisplayName(agentId, agentType = "") {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedAgentType = String(agentType ?? "").trim().toLowerCase();
  if (!normalizedAgentId) {
    return "";
  }

  if (normalizedAgentId.startsWith("primary:") || normalizedAgentType === "primary") {
    return "主智能体";
  }

  if (normalizedAgentId.startsWith("subagent:")) {
    return normalizedAgentType && normalizedAgentType !== "generic" ? normalizedAgentType : "子智能体";
  }

  return normalizedAgentType && normalizedAgentType !== "generic"
    ? normalizedAgentType
    : normalizedAgentId;
}

function resolveAgentDisplayName(sessionState, agentId) {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId || !sessionState || !(sessionState.agents instanceof Map)) {
    return fallbackAgentDisplayName(normalizedAgentId);
  }

  const agent = sessionState.agents.get(normalizedAgentId);
  const displayName = normalizeDisplayName(agent?.metadata?.displayName);
  if (displayName) {
    return displayName;
  }

  return fallbackAgentDisplayName(normalizedAgentId, agent?.agentType);
}

function uniqueAgentIds(items = []) {
  const normalized = [];
  const seen = new Set();

  for (const item of items) {
    const agentId = normalizeAgentId(item);
    if (!agentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    normalized.push(agentId);
  }

  return normalized;
}

function normalizeAgentRecord(agentId, options = {}) {
  return {
    agentId,
    agentType: String(options.agentType ?? "generic").trim() || "generic",
    isPrimary: Boolean(options.isPrimary),
    metadata: normalizeMetadata(options.metadata),
    atomicDepth: Number.isInteger(options.atomicDepth) ? options.atomicDepth : 0,
    openAtomicSteps: Array.isArray(options.openAtomicSteps) ? options.openAtomicSteps : [],
    lastActiveAt: Number(options.lastActiveAt ?? Date.now())
  };
}

function normalizeMessageFactory(value) {
  return typeof value === "function" ? value : null;
}

function normalizeMessageObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? cloneValue(value) : null;
}

function createQueueRecord(options = {}) {
  return {
    id: String(options.id ?? createId("orchestrator_queue")).trim() || createId("orchestrator_queue"),
    sessionId: String(options.sessionId ?? "").trim(),
    targetAgentId: String(options.targetAgentId ?? "").trim(),
    sourceAgentId: String(options.sourceAgentId ?? "").trim(),
    subtype: String(options.subtype ?? "generic").trim() || "generic",
    deliveryMode: String(options.deliveryMode ?? "queued_after_atomic").trim()
      || "queued_after_atomic",
    broadcastMode: String(options.broadcastMode ?? "direct").trim() || "direct",
    atomicStepId: String(options.atomicStepId ?? "").trim(),
    createdAt: Number(options.createdAt ?? Date.now()),
    readyAt: Number(options.readyAt ?? 0),
    status: String(options.status ?? "queued").trim() || "queued",
    message: cloneValue(options.message),
    metadata: normalizeMetadata(options.metadata)
  };
}

function createPoolEntry(options = {}) {
  return {
    id: String(options.id ?? createId("pool_entry")).trim() || createId("pool_entry"),
    sequence: Number(options.sequence ?? 0),
    sessionId: String(options.sessionId ?? "").trim(),
    sourceAgentId: String(options.sourceAgentId ?? "").trim(),
    subtype: String(options.subtype ?? "generic").trim() || "generic",
    atomicStepId: String(options.atomicStepId ?? "").trim(),
    title: String(options.title ?? "").trim(),
    summaryLines: normalizeLineList(options.summaryLines),
    detailLines: normalizeLineList(options.detailLines),
    payload: options.payload ?? null,
    createdAt: Number(options.createdAt ?? Date.now()),
    metadata: normalizeMetadata(options.metadata)
  };
}

function createSessionState(sessionId, options = {}) {
  const primaryAgentId = normalizeAgentId(options.primaryAgentId, "primary_agent");
  const primaryAgent = normalizeAgentRecord(primaryAgentId, {
    agentType: String(options.primaryAgentType ?? "primary").trim() || "primary",
    isPrimary: true,
    metadata: normalizeMetadata(options.primaryMetadata)
  });

  return {
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: normalizeMetadata(options.metadata),
    primaryAgentId,
    agents: new Map([[primaryAgentId, primaryAgent]]),
    publicPool: [],
    queueByAgent: new Map(),
    sequenceCounter: 0
  };
}

function queueRecordToSnapshot(record) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    targetAgentId: record.targetAgentId,
    sourceAgentId: record.sourceAgentId,
    subtype: record.subtype,
    deliveryMode: record.deliveryMode,
    broadcastMode: record.broadcastMode,
    atomicStepId: record.atomicStepId,
    createdAt: record.createdAt,
    readyAt: record.readyAt,
    status: record.status,
    message: cloneValue(record.message),
    metadata: cloneValue(record.metadata)
  };
}

function agentRecordToSnapshot(agent) {
  return {
    agentId: agent.agentId,
    agentType: agent.agentType,
    isPrimary: agent.isPrimary,
    metadata: cloneValue(agent.metadata),
    atomicDepth: agent.atomicDepth,
    openAtomicSteps: cloneValue(agent.openAtomicSteps),
    lastActiveAt: agent.lastActiveAt
  };
}

export class OrchestratorSchedulerService {
  constructor(options = {}) {
    this.maxPoolEntries = Number.isInteger(options.maxPoolEntries)
      ? options.maxPoolEntries
      : DEFAULT_MAX_POOL_ENTRIES;
    this.maxAgentQueue = Number.isInteger(options.maxAgentQueue)
      ? options.maxAgentQueue
      : DEFAULT_MAX_AGENT_QUEUE;
    this.messageAdapter = options.messageAdapter && typeof options.messageAdapter === "object"
      ? options.messageAdapter
      : null;
    this.store = options.store ?? null;
    this.sessionMap = new Map();
  }

  hydrateSessionState(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }

    const agents = Array.isArray(snapshot.agents)
      ? snapshot.agents.map((agent) => normalizeAgentRecord(agent.agentId, agent))
      : [];
    const queueByAgent = new Map();

    if (snapshot.queueByAgent instanceof Map) {
      for (const [agentId, queue] of snapshot.queueByAgent.entries()) {
        queueByAgent.set(
          agentId,
          Array.isArray(queue) ? queue.map((item) => createQueueRecord(item)) : []
        );
      }
    } else if (snapshot.queueByAgent && typeof snapshot.queueByAgent === "object") {
      for (const [agentId, queue] of Object.entries(snapshot.queueByAgent)) {
        queueByAgent.set(
          agentId,
          Array.isArray(queue) ? queue.map((item) => createQueueRecord(item)) : []
        );
      }
    }

    const sessionId = String(snapshot.sessionId ?? options.sessionId ?? "").trim();
    if (!sessionId) {
      return null;
    }

    return {
      sessionId,
      createdAt: Number(snapshot.createdAt ?? Date.now()),
      updatedAt: Number(snapshot.updatedAt ?? Date.now()),
      metadata: normalizeMetadata(snapshot.metadata),
      primaryAgentId: normalizeAgentId(snapshot.primaryAgentId, options.primaryAgentId ?? "primary_agent"),
      agents: new Map(
        agents.map((agent) => [agent.agentId, agent])
      ),
      publicPool: Array.isArray(snapshot.publicPool)
        ? snapshot.publicPool.map((entry) => createPoolEntry(entry))
        : [],
      queueByAgent,
      sequenceCounter: Number(snapshot.sequenceCounter ?? 0)
    };
  }

  persistAgent(sessionState, agent) {
    if (!this.store || typeof this.store.upsertAgent !== "function" || !agent) {
      return;
    }

    this.store.upsertAgent({
      agentId: agent.agentId,
      sessionId: sessionState.sessionId,
      conversationId: agent.metadata?.conversationId ?? "",
      agentType: agent.agentType,
      displayName: agent.metadata?.displayName ?? "",
      isPrimary: agent.isPrimary,
      status: agent.metadata?.status ?? "idle",
      atomicDepth: agent.atomicDepth,
      openAtomicSteps: agent.openAtomicSteps,
      metadata: agent.metadata,
      lastActiveAt: agent.lastActiveAt
    });
  }

  persistQueueRecord(record) {
    if (!this.store || typeof this.store.insertQueueEntry !== "function" || !record) {
      return;
    }

    const existing = this.store.getQueueEntryById?.(record.id);
    if (existing) {
      this.store.updateQueueEntryStatus(record.id, record.status, {
        metadata: record.metadata
      });
      return;
    }

    this.store.insertQueueEntry(record);
  }

  resolveQueuedMessage(options = {}, context = {}) {
    const directMessage = normalizeMessageObject(options.message);
    if (directMessage) {
      return directMessage;
    }

    const messageFactory = normalizeMessageFactory(options.messageFactory);
    if (messageFactory) {
      const producedMessage = normalizeMessageObject(messageFactory(context));
      if (!producedMessage) {
        throw new Error("messageFactory must return a message object");
      }
      return producedMessage;
    }

    const adapterFactory = normalizeMessageFactory(this.messageAdapter?.buildQueuedMessage);
    if (adapterFactory) {
      const producedMessage = normalizeMessageObject(adapterFactory(context));
      if (!producedMessage) {
        throw new Error("messageAdapter.buildQueuedMessage must return a message object");
      }
      return producedMessage;
    }

    throw new Error(
      "queueMessage requires message, messageFactory, or a service messageAdapter.buildQueuedMessage"
    );
  }

  resolvePoolBroadcastMessageOptions(mode, options = {}, context = {}) {
    const staticMessage = mode === "light"
      ? normalizeMessageObject(options.lightMessage)
      : normalizeMessageObject(options.fullMessage);
    if (staticMessage) {
      return {
        message: staticMessage
      };
    }

    const modeFactory = mode === "light"
      ? normalizeMessageFactory(options.lightMessageFactory)
      : normalizeMessageFactory(options.fullMessageFactory);
    if (modeFactory) {
      return {
        messageFactory: (queueContext) => modeFactory({
          ...context,
          ...queueContext
        })
      };
    }

    const adapterFactory = normalizeMessageFactory(this.messageAdapter?.buildPoolBroadcastMessage);
    if (adapterFactory) {
      return {
        messageFactory: (queueContext) => adapterFactory({
          ...context,
          ...queueContext,
          poolBroadcastMode: mode
        })
      };
    }

    return {};
  }

  ensureSession(sessionId, options = {}) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) {
      throw new Error("sessionId is required");
    }

    const existing = this.sessionMap.get(normalizedSessionId);
    if (existing) {
      return existing;
    }

    const persistedSnapshot =
      this.store && typeof this.store.loadSessionSnapshot === "function"
        ? this.store.loadSessionSnapshot(normalizedSessionId)
        : null;
    const nextState =
      this.hydrateSessionState(persistedSnapshot, {
        sessionId: normalizedSessionId,
        primaryAgentId: options.primaryAgentId
      }) ?? createSessionState(normalizedSessionId, options);

    if (
      this.store &&
      typeof this.store.ensurePrimaryAgent === "function" &&
      !persistedSnapshot
    ) {
      this.store.ensurePrimaryAgent({
        sessionId: normalizedSessionId,
        agentId: nextState.primaryAgentId,
        conversationId: options.primaryConversationId ?? normalizedSessionId,
        agentType: options.primaryAgentType ?? "primary",
        displayName: options.primaryDisplayName ?? "主智能体",
        metadata: options.primaryMetadata
      });
    }

    this.sessionMap.set(normalizedSessionId, nextState);
    return nextState;
  }

  createSession(options = {}) {
    const sessionId = String(options.sessionId ?? createId("orchestrator_session")).trim()
      || createId("orchestrator_session");
    const sessionState = this.ensureSession(sessionId, options);
    return this.getSessionSnapshot(sessionState.sessionId);
  }

  getSessionState(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    return normalizedSessionId ? this.sessionMap.get(normalizedSessionId) ?? null : null;
  }

  getSessionSnapshot(sessionId) {
    const sessionState = this.getSessionState(sessionId);
    if (!sessionState) {
      return null;
    }

    return {
      sessionId: sessionState.sessionId,
      createdAt: sessionState.createdAt,
      updatedAt: sessionState.updatedAt,
      metadata: cloneValue(sessionState.metadata),
      primaryAgentId: sessionState.primaryAgentId,
      agents: Array.from(sessionState.agents.values()).map((agent) => agentRecordToSnapshot(agent)),
      publicPoolSize: sessionState.publicPool.length,
      queueSize: Array.from(sessionState.queueByAgent.values()).reduce(
        (total, queue) => total + queue.length,
        0
      )
    };
  }

  registerAgent(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    const agentId = normalizeAgentId(options.agentId);
    if (!agentId) {
      throw new Error("agentId is required");
    }

    const existing = sessionState.agents.get(agentId);
    const nextRecord = normalizeAgentRecord(agentId, {
      agentType: options.agentType ?? existing?.agentType,
      isPrimary: Boolean(options.isPrimary ?? existing?.isPrimary),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...normalizeMetadata(options.metadata)
      },
      atomicDepth: existing?.atomicDepth ?? 0,
      openAtomicSteps: existing?.openAtomicSteps ?? [],
      lastActiveAt: Date.now()
    });

    sessionState.agents.set(agentId, nextRecord);
    if (nextRecord.isPrimary) {
      sessionState.primaryAgentId = agentId;
    }
    sessionState.updatedAt = Date.now();
    this.persistAgent(sessionState, nextRecord);

    return agentRecordToSnapshot(nextRecord);
  }

  listAgents(sessionId) {
    const sessionState = this.getSessionState(sessionId);
    if (!sessionState) {
      return [];
    }

    return Array.from(sessionState.agents.values()).map((agent) => agentRecordToSnapshot(agent));
  }

  unregisterAgent(sessionId, agentId) {
    const sessionState = this.getSessionState(sessionId);
    const normalizedAgentId = normalizeAgentId(agentId);
    if (!sessionState || !normalizedAgentId) {
      return false;
    }

    const removed = sessionState.agents.delete(normalizedAgentId);
    sessionState.queueByAgent.delete(normalizedAgentId);
    sessionState.updatedAt = Date.now();

    if (removed && this.store && typeof this.store.deleteAgent === "function") {
      this.store.deleteAgent(normalizedAgentId);
    }

    return removed;
  }

  beginAtomicStep(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    const agentId = normalizeAgentId(options.agentId, sessionState.primaryAgentId);
    const agent = sessionState.agents.get(agentId) ?? normalizeAgentRecord(agentId);
    const stepId = String(options.stepId ?? createId("atomic_step")).trim() || createId("atomic_step");
    const stepRecord = {
      stepId,
      stepType: String(options.stepType ?? "generic").trim() || "generic",
      startedAt: Number(options.startedAt ?? Date.now()),
      metadata: normalizeMetadata(options.metadata)
    };

    agent.atomicDepth += 1;
    agent.openAtomicSteps = [...agent.openAtomicSteps, stepRecord];
    agent.lastActiveAt = Date.now();
    sessionState.agents.set(agentId, agent);
    sessionState.updatedAt = Date.now();
    this.persistAgent(sessionState, agent);

    return {
      sessionId: sessionState.sessionId,
      agentId,
      stepId,
      atomicDepth: agent.atomicDepth
    };
  }

  finishAtomicStep(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    const agentId = normalizeAgentId(options.agentId, sessionState.primaryAgentId);
    const agent = sessionState.agents.get(agentId);

    if (!agent) {
      throw new Error(`agent not found: ${agentId}`);
    }

    const requestedStepId = String(options.stepId ?? "").trim();
    let closedStep = null;
    if (requestedStepId) {
      const nextSteps = [];
      for (const step of agent.openAtomicSteps) {
        if (!closedStep && String(step.stepId ?? "").trim() === requestedStepId) {
          closedStep = step;
          continue;
        }
        nextSteps.push(step);
      }
      agent.openAtomicSteps = nextSteps;
    } else {
      closedStep = agent.openAtomicSteps[agent.openAtomicSteps.length - 1] ?? null;
      agent.openAtomicSteps = agent.openAtomicSteps.slice(0, -1);
    }

    if (agent.atomicDepth > 0) {
      agent.atomicDepth -= 1;
    }
    agent.lastActiveAt = Date.now();
    sessionState.updatedAt = Date.now();
    this.persistAgent(sessionState, agent);

    const readyInsertions = this.flushReadyInsertions(sessionState.sessionId, agentId);

    return {
      sessionId: sessionState.sessionId,
      agentId,
      stepId: String(closedStep?.stepId ?? requestedStepId).trim(),
      atomicDepth: agent.atomicDepth,
      readyInsertions
    };
  }

  appendPoolEntry(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    const sourceAgentId = normalizeAgentId(options.sourceAgentId, sessionState.primaryAgentId);
    const nextSequence = sessionState.sequenceCounter + 1;
    const entry =
      this.store && typeof this.store.appendPoolEntry === "function"
        ? this.store.appendPoolEntry({
            ...options,
            sessionId: sessionState.sessionId,
            sourceAgentId,
            sequence: nextSequence,
            createdAt: Date.now()
          })
        : createPoolEntry({
            ...options,
            sessionId: sessionState.sessionId,
            sourceAgentId,
            sequence: nextSequence,
            createdAt: Date.now()
          });

    sessionState.sequenceCounter = entry.sequence;
    sessionState.publicPool.push(entry);
    if (sessionState.publicPool.length > this.maxPoolEntries) {
      sessionState.publicPool.splice(0, sessionState.publicPool.length - this.maxPoolEntries);
    }
    sessionState.updatedAt = Date.now();

    return cloneValue(entry);
  }

  queueMessage(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    const targetAgentId = normalizeAgentId(options.targetAgentId);
    if (!targetAgentId) {
      throw new Error("targetAgentId is required");
    }

    const targetAgent = sessionState.agents.get(targetAgentId);
    if (!targetAgent) {
      throw new Error(`target agent not found: ${targetAgentId}`);
    }

    const sourceAgentId = normalizeAgentId(options.sourceAgentId, sessionState.primaryAgentId);
    const subtype = String(options.subtype ?? "generic").trim() || "generic";
    const deliveryMode = String(options.deliveryMode ?? "queued_after_atomic").trim()
      || "queued_after_atomic";
    const broadcastMode = String(options.broadcastMode ?? "direct").trim() || "direct";
    const atomicStepId = String(options.atomicStepId ?? "").trim();
    const title = String(options.title ?? "").trim();
    const summaryLines = normalizeLineList(options.summaryLines);
    const detailLines = normalizeLineList(options.detailLines);
    const payload = options.payload ?? null;
    const metadata = normalizeMetadata(options.metadata);
    const sourceAgentDisplayName =
      normalizeDisplayName(options.sourceAgentDisplayName)
      || normalizeDisplayName(metadata.sourceAgentDisplayName)
      || resolveAgentDisplayName(sessionState, sourceAgentId);
    const targetAgentDisplayName =
      normalizeDisplayName(options.targetAgentDisplayName)
      || normalizeDisplayName(metadata.targetAgentDisplayName)
      || resolveAgentDisplayName(sessionState, targetAgentId);
    const enrichedMetadata = {
      ...metadata,
      sourceAgentDisplayName,
      targetAgentDisplayName
    };
    const message = this.resolveQueuedMessage(options, {
      sessionId: sessionState.sessionId,
      sourceAgentId,
      targetAgentId,
      sourceAgentDisplayName,
      targetAgentDisplayName,
      subtype,
      deliveryMode,
      broadcastMode,
      atomicStepId,
      title,
      summaryLines,
      detailLines,
      payload,
      metadata: enrichedMetadata
    });

    const queue = Array.isArray(sessionState.queueByAgent.get(targetAgentId))
      ? sessionState.queueByAgent.get(targetAgentId)
      : [];
    const queueRecord = createQueueRecord({
      sessionId: sessionState.sessionId,
      targetAgentId,
      sourceAgentId,
      subtype,
      deliveryMode,
      broadcastMode,
      atomicStepId,
      message,
      metadata: enrichedMetadata
    });

    if (targetAgent.atomicDepth === 0) {
      queueRecord.status = "ready";
      queueRecord.readyAt = Date.now();
    }

    queue.push(queueRecord);
    if (queue.length > this.maxAgentQueue) {
      queue.splice(0, queue.length - this.maxAgentQueue);
    }

    sessionState.queueByAgent.set(targetAgentId, queue);
    sessionState.updatedAt = Date.now();
    this.persistQueueRecord(queueRecord);

    return queueRecordToSnapshot(queueRecord);
  }

  reportToPool(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    const sourceAgentId = normalizeAgentId(options.sourceAgentId, sessionState.primaryAgentId);
    const poolEntry = this.appendPoolEntry({
      ...options,
      sessionId: sessionState.sessionId,
      sourceAgentId
    });

    const lightBroadcastAgentIds = uniqueAgentIds(options.lightBroadcastAgentIds);
    const fullBroadcastAgentIds = uniqueAgentIds(options.fullBroadcastAgentIds);
    const queuedMessages = [];

    for (const targetAgentId of lightBroadcastAgentIds) {
      const lightMessageOptions = this.resolvePoolBroadcastMessageOptions("light", options, {
        sessionId: sessionState.sessionId,
        sourceAgentId,
        targetAgentId,
        poolEntry
      });
      const queuedMessage = this.queueMessage({
        sessionId: sessionState.sessionId,
        targetAgentId,
        sourceAgentId,
        subtype: String(options.lightBroadcastSubtype ?? `${poolEntry.subtype}_light`).trim()
          || `${poolEntry.subtype}_light`,
        deliveryMode: "queued_after_atomic",
        broadcastMode: "light",
        atomicStepId: poolEntry.atomicStepId,
        title: poolEntry.title,
        summaryLines: poolEntry.summaryLines,
        detailLines: [],
        payload: null,
        metadata: {
          poolEntryId: poolEntry.id,
          poolSequence: poolEntry.sequence,
          ...normalizeMetadata(options.metadata)
        },
        ...lightMessageOptions
      });
      queuedMessages.push(queuedMessage);
      if (this.store && typeof this.store.recordPoolDelivery === "function") {
        this.store.recordPoolDelivery({
          poolEntryId: poolEntry.id,
          sessionId: sessionState.sessionId,
          targetAgentId,
          deliveryMode: queuedMessage.deliveryMode,
          status: queuedMessage.status,
          queuedMessageId: queuedMessage.id,
          metadata: {
            broadcastMode: "light",
            poolSequence: poolEntry.sequence
          }
        });
      }
    }

    for (const targetAgentId of fullBroadcastAgentIds) {
      const fullMessageOptions = this.resolvePoolBroadcastMessageOptions("full", options, {
        sessionId: sessionState.sessionId,
        sourceAgentId,
        targetAgentId,
        poolEntry
      });
      const queuedMessage = this.queueMessage({
        sessionId: sessionState.sessionId,
        targetAgentId,
        sourceAgentId,
        subtype: String(options.fullBroadcastSubtype ?? `${poolEntry.subtype}_full`).trim()
          || `${poolEntry.subtype}_full`,
        deliveryMode: "queued_after_atomic",
        broadcastMode: "full",
        atomicStepId: poolEntry.atomicStepId,
        title: poolEntry.title,
        summaryLines: poolEntry.summaryLines,
        detailLines: poolEntry.detailLines,
        payload: poolEntry.payload,
        metadata: {
          poolEntryId: poolEntry.id,
          poolSequence: poolEntry.sequence,
          ...normalizeMetadata(options.metadata)
        },
        ...fullMessageOptions
      });
      queuedMessages.push(queuedMessage);
      if (this.store && typeof this.store.recordPoolDelivery === "function") {
        this.store.recordPoolDelivery({
          poolEntryId: poolEntry.id,
          sessionId: sessionState.sessionId,
          targetAgentId,
          deliveryMode: queuedMessage.deliveryMode,
          status: queuedMessage.status,
          queuedMessageId: queuedMessage.id,
          metadata: {
            broadcastMode: "full",
            poolSequence: poolEntry.sequence
          }
        });
      }
    }

    return {
      poolEntry,
      queuedMessages
    };
  }

  refreshAgentQueue(sessionId, agentId) {
    const sessionState = this.ensureSession(sessionId);
    const normalizedAgentId = normalizeAgentId(agentId, sessionState.primaryAgentId);
    const agent = sessionState.agents.get(normalizedAgentId);
    if (!agent) {
      return [];
    }

    const queue = Array.isArray(sessionState.queueByAgent.get(normalizedAgentId))
      ? sessionState.queueByAgent.get(normalizedAgentId)
      : [];
    if (queue.length === 0 || agent.atomicDepth > 0) {
      return queue.map((item) => queueRecordToSnapshot(item));
    }

    const now = Date.now();
    for (const item of queue) {
      if (item.status === "queued") {
        item.status = "ready";
        item.readyAt = now;
        if (this.store && typeof this.store.updateQueueEntryStatus === "function") {
          this.store.updateQueueEntryStatus(item.id, "ready", {
            metadata: item.metadata
          });
        }
      }
    }

    sessionState.updatedAt = now;
    return queue.map((item) => queueRecordToSnapshot(item));
  }

  listPendingInsertions(sessionId, agentId, options = {}) {
    const sessionState = this.getSessionState(sessionId);
    if (!sessionState) {
      return [];
    }

    const normalizedAgentId = normalizeAgentId(agentId, sessionState.primaryAgentId);
    const includeConsumed = Boolean(options.includeConsumed);
    const queue = Array.isArray(sessionState.queueByAgent.get(normalizedAgentId))
      ? sessionState.queueByAgent.get(normalizedAgentId)
      : [];

    return queue
      .filter((item) => includeConsumed || item.status !== "consumed")
      .map((item) => queueRecordToSnapshot(item));
  }

  flushReadyInsertions(sessionId, agentId) {
    this.refreshAgentQueue(sessionId, agentId);
    const sessionState = this.getSessionState(sessionId);
    if (!sessionState) {
      return [];
    }

    const normalizedAgentId = normalizeAgentId(agentId, sessionState.primaryAgentId);
    const queue = Array.isArray(sessionState.queueByAgent.get(normalizedAgentId))
      ? sessionState.queueByAgent.get(normalizedAgentId)
      : [];
    const ready = queue
      .filter((item) => item.status === "ready")
      .map((item) => {
        item.status = "consumed";
        item.consumedAt = Date.now();
        if (this.store && typeof this.store.updateQueueEntryStatus === "function") {
          this.store.updateQueueEntryStatus(item.id, "consumed", {
            metadata: item.metadata
          });
        }
        return queueRecordToSnapshot(item);
      });

    if (ready.length > 0) {
      sessionState.updatedAt = Date.now();
    }

    return ready;
  }

  getPublicPool(options = {}) {
    const sessionState = this.ensureSession(options.sessionId, options);
    if (!sessionState) {
      return [];
    }

    const sinceSequence = Number(options.sinceSequence ?? 0);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;

    return sessionState.publicPool
      .filter((entry) => entry.sequence > sinceSequence)
      .slice(-limit)
      .map((entry) => cloneValue(entry));
  }

  resetSession(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) {
      return false;
    }

    if (this.store && typeof this.store.deleteSession === "function") {
      this.store.deleteSession(normalizedSessionId);
    }

    return this.sessionMap.delete(normalizedSessionId);
  }
}
