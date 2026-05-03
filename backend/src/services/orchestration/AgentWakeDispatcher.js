import { isAbortError } from "../runs/runAbort.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

export class AgentWakeDispatcher {
  constructor(options = {}) {
    this.historyStore = options.historyStore ?? null;
    this.schedulerService = options.schedulerService ?? null;
    this.orchestratorStore = options.orchestratorStore ?? null;
    this.runtimeService = options.runtimeService ?? null;
    this.orchestratorSupervisorService = options.orchestratorSupervisorService ?? null;
    this.conversationEventBroadcaster = options.conversationEventBroadcaster ?? null;
    this.conversationRunCoordinator = options.conversationRunCoordinator ?? null;
  }

  getRunKey(sessionId, agentId) {
    return `${normalizeText(sessionId)}::${normalizeText(agentId)}`;
  }

  getActiveRun(sessionId, agentId) {
    return this.conversationRunCoordinator?.getRunByAgent?.(sessionId, agentId) ?? null;
  }

  isAgentBusy(sessionId, agentId) {
    return Boolean(this.getActiveRun(sessionId, agentId));
  }

  restorePersistedRun(sessionId, agentId, conversationId, mode = "foreground") {
    const existingRun = this.getActiveRun(sessionId, agentId);
    if (existingRun) {
      return existingRun;
    }

    const persistedAgent = this.orchestratorStore?.getAgent?.(agentId) ?? null;
    const openAtomicSteps = Array.isArray(persistedAgent?.openAtomicSteps)
      ? persistedAgent.openAtomicSteps
      : [];
    const latestStep = openAtomicSteps[openAtomicSteps.length - 1] ?? null;
    const stepId = normalizeText(latestStep?.stepId);
    if (!stepId || Number(persistedAgent?.atomicDepth ?? 0) <= 0) {
      return null;
    }

    return this.conversationRunCoordinator?.beginRun?.({
      sessionId,
      agentId,
      conversationId: normalizeText(conversationId) || normalizeText(persistedAgent?.conversationId),
      stepId,
      mode,
      restored: true,
      status: "running"
    }) ?? {
      sessionId,
      agentId,
      conversationId: normalizeText(conversationId) || normalizeText(persistedAgent?.conversationId),
      stepId,
      mode,
      restored: true,
      status: "running"
    };
  }

  beginForegroundRun(options = {}) {
    const sessionId = normalizeText(options.sessionId);
    const agentId = normalizeText(options.agentId);
    const allowExistingRun = Boolean(options.allowExistingRun);
    const allowRestore = Boolean(options.allowRestore);
    if (!sessionId || !agentId) {
      return null;
    }

    const existingRun = this.getActiveRun(sessionId, agentId);
    if (existingRun) {
      return allowExistingRun ? existingRun : { ...existingRun, busy: true };
    }

    const restoredRun = this.restorePersistedRun(
      sessionId,
      agentId,
      normalizeText(options.conversationId),
      "foreground"
    );
    if (restoredRun) {
      this.orchestratorStore?.upsertAgent?.({
        agentId,
        sessionId,
        conversationId: restoredRun.conversationId,
        status: "running",
        lastActiveAt: Date.now()
      });
      return allowRestore ? restoredRun : { ...restoredRun, busy: true };
    }

    const atomic = this.schedulerService.beginAtomicStep({
      sessionId,
      agentId,
      stepType: "foreground_run",
      metadata: {
        conversationId: normalizeText(options.conversationId)
      }
    });

    const runRecord = this.conversationRunCoordinator?.beginRun?.({
      sessionId,
      agentId,
      conversationId: normalizeText(options.conversationId),
      stepId: atomic.stepId,
      mode: "foreground",
      status: "running"
    }) ?? {
      sessionId,
      agentId,
      conversationId: normalizeText(options.conversationId),
      stepId: atomic.stepId,
      mode: "foreground",
      status: "running"
    };

    this.orchestratorStore?.upsertAgent?.({
      agentId,
      sessionId,
      status: "running",
      lastActiveAt: Date.now()
    });

    return runRecord;
  }

  async finishForegroundRun(options = {}) {
    const sessionId = normalizeText(options.sessionId);
    const agentId = normalizeText(options.agentId);
    if (!sessionId || !agentId) {
      return null;
    }

    const activeRun = this.getActiveRun(sessionId, agentId);
    if (!activeRun) {
      return null;
    }

    const requestedStatus = normalizeText(options.status) || "idle";
    if (requestedStatus === "waiting_approval") {
      activeRun.status = "waiting_approval";
      const pausedAgent = this.orchestratorStore?.getAgent?.(agentId) ?? null;
      this.orchestratorStore?.upsertAgent?.({
        agentId,
        sessionId,
        conversationId: pausedAgent?.conversationId ?? activeRun.conversationId,
        agentType: pausedAgent?.agentType ?? "generic",
        displayName: pausedAgent?.displayName ?? "",
        isPrimary: pausedAgent?.isPrimary ?? false,
        status: "waiting_approval",
        atomicDepth: pausedAgent?.atomicDepth,
        openAtomicSteps: pausedAgent?.openAtomicSteps,
        metadata: pausedAgent?.metadata ?? {},
        lastActiveAt: Date.now()
      });
      return {
        sessionId,
        agentId,
        stepId: activeRun.stepId,
        runId: activeRun.runId,
        atomicDepth: Number(pausedAgent?.atomicDepth ?? 0),
        readyInsertions: [],
        paused: true
      };
    }

    const result = this.schedulerService.finishAtomicStep({
      sessionId,
      agentId,
      stepId: activeRun.stepId
    });

    const agentRecord = this.orchestratorStore?.getAgent?.(agentId) ?? null;
    const nextStatus =
      Number(result?.readyInsertions?.length ?? 0) > 0 ? "idle" : requestedStatus;
    this.orchestratorStore?.upsertAgent?.({
      agentId,
      sessionId,
      conversationId: agentRecord?.conversationId ?? activeRun.conversationId,
      agentType: agentRecord?.agentType ?? "generic",
      displayName: agentRecord?.displayName ?? "",
      isPrimary: agentRecord?.isPrimary ?? false,
      status: nextStatus,
      atomicDepth: Number(result?.atomicDepth ?? 0),
      openAtomicSteps: agentRecord?.openAtomicSteps ?? [],
      metadata: agentRecord?.metadata ?? {},
      lastActiveAt: Date.now()
    });

    this.conversationRunCoordinator?.finishRun?.(activeRun, {
      status: nextStatus
    });

    await this.handleReadyInsertions(agentRecord?.conversationId ?? activeRun.conversationId, result);
    if (nextStatus !== "error") {
      await this.continueAgentAfterInsertions(sessionId, agentId, result);
    }

    return result;
  }

  async continueAgentAfterInsertions(sessionId, agentId, finishResult = {}) {
    const normalizedSessionId = normalizeText(sessionId);
    const normalizedAgentId = normalizeText(agentId);
    if (!normalizedSessionId || !normalizedAgentId) {
      return false;
    }

    const readyInsertions = Array.isArray(finishResult?.readyInsertions)
      ? finishResult.readyInsertions
      : [];
    if (readyInsertions.length > 0) {
      await this.startBackgroundRun(normalizedSessionId, normalizedAgentId);
      return true;
    }

    return this.wakeAgentIfNeeded({
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId
    });
  }

  async handleReadyInsertions(conversationId, finishResult = {}) {
    const normalizedConversationId = normalizeText(conversationId);
    const readyInsertions = Array.isArray(finishResult?.readyInsertions)
      ? finishResult.readyInsertions
      : [];
    if (!normalizedConversationId || readyInsertions.length === 0) {
      return null;
    }

    const messages = readyInsertions
      .map((item) => item?.message)
      .filter((item) => item && typeof item === "object");
    if (messages.length === 0) {
      return null;
    }

    const appendResult = this.historyStore?.appendMessages?.(normalizedConversationId, messages, {
      updatedAt: Date.now()
    }) ?? null;

    this.conversationEventBroadcaster?.publishMessagesAppended?.(
      normalizedConversationId,
      messages
    );

    return appendResult;
  }

  async wakeAgentIfNeeded(options = {}) {
    const sessionId = normalizeText(options.sessionId);
    const agentId = normalizeText(options.agentId);
    if (!sessionId || !agentId || this.isAgentBusy(sessionId, agentId)) {
      return false;
    }

    const queue = this.schedulerService.refreshAgentQueue(sessionId, agentId);
    const hasReady = Array.isArray(queue)
      ? queue.some((item) => normalizeText(item?.status) === "ready")
      : false;

    if (!hasReady) {
      return false;
    }

    void this.startBackgroundRun(sessionId, agentId);
    return true;
  }

  async startBackgroundRun(sessionId, agentId) {
    const existingRun = this.getActiveRun(sessionId, agentId);
    if (existingRun) {
      return existingRun;
    }

    const agentRecord = this.orchestratorStore?.getAgent?.(agentId) ?? null;
    const conversationId = normalizeText(agentRecord?.conversationId);
    if (!conversationId) {
      return null;
    }

    const restoredRun = this.restorePersistedRun(sessionId, agentId, conversationId, "background");
    if (restoredRun) {
      return restoredRun;
    }

    const atomic = this.schedulerService.beginAtomicStep({
      sessionId,
      agentId,
      stepType: "background_run",
      metadata: {
        conversationId
      }
    });
    const runRecord = this.conversationRunCoordinator?.beginRun?.({
      sessionId,
      agentId,
      conversationId,
      stepId: atomic.stepId,
      mode: "background",
      status: "running"
    }) ?? {
      sessionId,
      agentId,
      conversationId,
      stepId: atomic.stepId,
      mode: "background",
      status: "running",
      signal: null
    };
    const detachBroadcast =
      this.conversationRunCoordinator?.attachConversationBroadcast?.(runRecord, {
        listenerId: `conversation_broadcast_${runRecord.runId}`
      }) ?? (() => {});

    this.orchestratorStore?.upsertAgent?.({
      agentId,
      sessionId,
      conversationId,
      agentType: agentRecord?.agentType ?? "generic",
      displayName: agentRecord?.displayName ?? "",
      isPrimary: agentRecord?.isPrimary ?? false,
      status: "running",
      lastActiveAt: Date.now()
    });

    try {
      const readyInsertions = this.schedulerService.flushReadyInsertions(sessionId, agentId);
      await this.handleReadyInsertions(conversationId, { readyInsertions });
      this.conversationRunCoordinator?.emitEvent?.(runRecord, {
        type: "session_start",
        mode: "background"
      });

      const runResult = await this.runtimeService.runConversationById({
        conversationId,
        currentAtomicStepId: atomic.stepId,
        runId: runRecord.runId,
        abortSignal: runRecord.signal,
        onEvent: (payload) => {
          this.conversationRunCoordinator?.emitEvent?.(runRecord, payload);
        }
      });

      if (normalizeText(runResult?.status) === "pending_approval") {
        runRecord.status = "waiting_approval";
        this.orchestratorStore?.upsertAgent?.({
          agentId,
          sessionId,
          conversationId,
          agentType: agentRecord?.agentType ?? "generic",
          displayName: agentRecord?.displayName ?? "",
          isPrimary: agentRecord?.isPrimary ?? false,
          status: "waiting_approval",
          lastActiveAt: Date.now()
        });
        this.conversationRunCoordinator?.emitEvent?.(runRecord, {
          type: "session_end",
          mode: "background",
          status: "waiting_approval",
          history: runResult?.history ?? null
        });
        return runRecord;
      }

      const finishResult = this.schedulerService.finishAtomicStep({
        sessionId,
        agentId,
        stepId: atomic.stepId
      });

      this.orchestratorStore?.upsertAgent?.({
        agentId,
        sessionId,
        conversationId,
        agentType: agentRecord?.agentType ?? "generic",
        displayName: agentRecord?.displayName ?? "",
        isPrimary: agentRecord?.isPrimary ?? false,
        status:
          normalizeText(runResult?.status) === "pending_approval"
            ? "waiting_approval"
            : "idle",
        lastActiveAt: Date.now()
      });

      await this.handleReadyInsertions(conversationId, finishResult);
      const latestHistory =
        this.historyStore?.getConversation?.(conversationId) ?? runResult?.history ?? null;
      this.conversationRunCoordinator?.emitEvent?.(runRecord, {
        type: "session_end",
        mode: "background",
        status: normalizeText(runResult?.status) || "completed",
        history: latestHistory
      });
      this.conversationRunCoordinator?.finishRun?.(runRecord, {
        status: normalizeText(runResult?.status) || "completed"
      });
      if (runResult?.subagentCompletionRequest) {
        await this.orchestratorSupervisorService?.dispatchCompletionToPrimary?.(
          runResult.subagentCompletionRequest
        );
      }
      if (
        normalizeText(runResult?.status) === "goal_incomplete" ||
        normalizeText(runResult?.status) === "plan_incomplete"
      ) {
        void this.startBackgroundRun(sessionId, agentId);
        return runRecord;
      }
      await this.continueAgentAfterInsertions(sessionId, agentId, finishResult);
      return runRecord;
    } catch (error) {
      const finishResult = this.schedulerService.finishAtomicStep({
        sessionId,
        agentId,
        stepId: atomic.stepId
      });
      await this.handleReadyInsertions(conversationId, finishResult);
      const aborted = isAbortError(error);
      const nextMetadata = {
        ...(agentRecord?.metadata ?? {})
      };
      if (aborted) {
        delete nextMetadata.lastError;
      } else {
        nextMetadata.lastError = error?.message || "background run failed";
      }
      if (!aborted) {
        this.conversationRunCoordinator?.emitEvent?.(runRecord, {
          type: "error",
          message: error?.message || "background run failed"
        });
      }
      this.conversationRunCoordinator?.emitEvent?.(runRecord, {
        type: "session_end",
        mode: "background",
        status: aborted ? "aborted" : "error"
      });
      this.conversationRunCoordinator?.finishRun?.(runRecord, {
        status: aborted ? "idle" : "error"
      });
      this.orchestratorStore?.upsertAgent?.({
        agentId,
        sessionId,
        conversationId,
        agentType: agentRecord?.agentType ?? "generic",
        displayName: agentRecord?.displayName ?? "",
        isPrimary: agentRecord?.isPrimary ?? false,
        status: aborted ? "idle" : "error",
        lastActiveAt: Date.now(),
        metadata: nextMetadata
      });
      return null;
    } finally {
      detachBroadcast();
    }
  }
}
