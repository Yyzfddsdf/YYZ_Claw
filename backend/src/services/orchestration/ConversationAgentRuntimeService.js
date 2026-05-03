import { configSchema } from "../../schemas/configSchema.js";
import {
  buildConversationPromptMessages,
  buildCompressionSnapshotMetadata,
  buildCompressionTokenSnapshot,
  createGoalContinuationMessage,
  createPlanContinuationMessage,
  extractFirstSentence,
  isGoalEnabled,
  isPlanIncomplete,
  isAutoTitleCandidate,
  loadApprovalRules,
  normalizePlanState,
  normalizeUsageRecordPayload,
  buildThinkingRuntimeOptions,
  inferThinkingModeFromRuntimeOptions,
  resolvePinnedMemorySummaryPrompt,
  resolveAgentRuntimeConfig,
  scheduleAsyncTitleGeneration
} from "../chat/conversationRuntimeShared.js";
import { AgentConversationRecorder } from "./AgentConversationRecorder.js";
import { resolveAgentSessionId } from "./agentIdentity.js";
import { resolveSubagentCompletionDispatchRequest } from "./subagentCompletionShared.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeToolCalls(toolCalls) {
  return Array.isArray(toolCalls)
    ? toolCalls
        .map((toolCall) => {
          const id = String(toolCall?.id ?? "").trim();
          const functionName = String(toolCall?.function?.name ?? "").trim();
          if (!id || !functionName) {
            return null;
          }

          return {
            id,
            type: "function",
            function: {
              name: functionName,
              arguments: String(toolCall?.function?.arguments ?? "{}")
            }
          };
        })
        .filter(Boolean)
    : [];
}

function normalizeMessageMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }

  return { ...meta };
}

function normalizeRecorderMessageForStorage(message = {}) {
  return {
    id: String(message.id ?? "").trim(),
    role: String(message.role ?? "assistant").trim() || "assistant",
    content: String(message.content ?? ""),
    reasoningContent: String(message.reasoningContent ?? message.reasoning_content ?? ""),
    timestamp: Number(message.timestamp ?? Date.now()),
    toolCallId: String(message.toolCallId ?? "").trim(),
    toolName: String(message.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message.toolCalls),
    meta: normalizeMessageMeta(message.meta),
    tokenUsage:
      message.tokenUsage && typeof message.tokenUsage === "object" ? { ...message.tokenUsage } : null
  };
}

function buildStorageMessageSignature(message = {}) {
  return JSON.stringify({
    role: String(message.role ?? "assistant").trim() || "assistant",
    content: String(message.content ?? ""),
    reasoningContent: String(message.reasoningContent ?? message.reasoning_content ?? ""),
    toolCallId: String(message.toolCallId ?? "").trim(),
    toolName: String(message.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message.toolCalls),
    meta: normalizeMessageMeta(message.meta),
    tokenUsage:
      message.tokenUsage && typeof message.tokenUsage === "object" ? message.tokenUsage : null,
    timestamp: Number(message.timestamp ?? 0)
  });
}

function shouldSyncRecorderOnEvent(event = {}) {
  const type = String(event?.type ?? "").trim();
  return (
    type === "assistant_message_end"
    || type === "tool_call"
    || type === "tool_result"
    || type === "tool_pending_approval"
    || type === "tool_image_input"
    || type === "runtime_hook_injected"
    || type === "usage"
  );
}

export class ConversationAgentRuntimeService {
  constructor(options = {}) {
    this.chatAgent = options.chatAgent ?? null;
    this.agentRuntimeFactory = options.agentRuntimeFactory ?? null;
    this.subagentDefinitionRegistry = options.subagentDefinitionRegistry ?? null;
    this.configStore = options.configStore ?? null;
    this.historyStore = options.historyStore ?? null;
    this.memoryStore = options.memoryStore ?? null;
    this.compressionService = options.compressionService ?? null;
    this.approvalRulesStore = options.approvalRulesStore ?? null;
    this.agentsPromptStore = options.agentsPromptStore ?? null;
    this.memorySummaryStore = options.memorySummaryStore ?? null;
    this.skillCatalog = options.skillCatalog ?? null;
    this.skillValidator = options.skillValidator ?? null;
    this.skillPromptBuilder = options.skillPromptBuilder ?? null;
    this.personaStore = options.personaStore ?? null;
    this.memorySummaryService = options.memorySummaryService ?? null;
    this.orchestratorSchedulerService = options.orchestratorSchedulerService ?? null;
    this.orchestratorStore = options.orchestratorStore ?? null;
    this.orchestratorSupervisorService = options.orchestratorSupervisorService ?? null;
  }

  async resolveConversationRuntime(conversationId) {
    const history = this.historyStore?.getConversation?.(conversationId) ?? null;
    if (!history) {
      throw new Error(`conversation not found: ${conversationId}`);
    }

    const sessionId = resolveAgentSessionId(history);
    const agentRecord =
      this.orchestratorStore?.findAgentByConversationId?.(conversationId) ?? null;
    const isSubagent = normalizeText(history?.source).toLowerCase() === "subagent";
    const rootConversation =
      sessionId && sessionId !== conversationId
        ? this.historyStore?.getConversation?.(sessionId) ?? null
        : history;
    const activeSkillNames =
      Array.isArray(rootConversation?.skills) && rootConversation.skills.length > 0
        ? rootConversation.skills
        : Array.isArray(history?.skills)
          ? history.skills
          : [];

    if (!isSubagent) {
      const personaPrompt = await this.personaStore?.resolvePrompt?.(history?.personaId);
      return {
        history,
        sessionId: sessionId || conversationId,
        agentId: agentRecord?.agentId ?? `primary:${sessionId || conversationId}`,
        agentType: "primary",
        isSubagent: false,
        activeSkillNames,
        developerPrompt: "",
        personaPrompt: normalizeText(personaPrompt),
        definitionPrompt: "",
        chatAgent: this.chatAgent
      };
    }

    const definition = this.subagentDefinitionRegistry?.get?.(agentRecord?.agentType ?? "") ?? null;
    if (!definition) {
      throw new Error(`subagent definition not found for ${agentRecord?.agentType ?? "unknown"}`);
    }

    const runtime = await this.agentRuntimeFactory.createRuntime(definition);

    return {
      history,
      sessionId,
      agentId: agentRecord?.agentId ?? "",
      agentType: definition.agentType,
      isSubagent: true,
      activeSkillNames,
      developerPrompt: "",
      personaPrompt: "",
      definitionPrompt: normalizeText(runtime?.definitionSystemPrompt),
      chatAgent: runtime?.chatAgent ?? this.chatAgent
    };
  }

  async runConversationById(options = {}) {
    const conversationId = normalizeText(options.conversationId);
    if (!conversationId) {
      throw new Error("conversationId is required");
    }

    const configValidation = configSchema.safeParse(await this.configStore.read());
    if (!configValidation.success) {
      throw new Error("config/config.json is invalid. Save model/baseURL/apiKey from frontend first.");
    }

    const resolved = await this.resolveConversationRuntime(conversationId);
    const thinkingRuntimeOptions = buildThinkingRuntimeOptions(
      inferThinkingModeFromRuntimeOptions(options, resolved?.history?.thinkingMode)
    );
    const runtimeConfig = resolveAgentRuntimeConfig(configValidation.data, {
      isSubagent: Boolean(resolved?.isSubagent),
      modelProfileId: resolved?.history?.modelProfileId,
      enableDeepThinking: thinkingRuntimeOptions.enableDeepThinking,
      reasoningEffort: thinkingRuntimeOptions.reasoningEffort
    });
    let existingConversation = resolved.history;
    if (!normalizeText(existingConversation?.modelProfileId) && normalizeText(runtimeConfig?.modelProfileId)) {
      existingConversation =
        this.historyStore.updateConversationModelProfile(
          conversationId,
          runtimeConfig.modelProfileId,
          runtimeConfig.model
        ) ?? existingConversation;
    }
    let effectiveMessages = Array.isArray(existingConversation?.messages)
      ? existingConversation.messages
      : [];

    const shouldAutoCompress = this.compressionService.shouldAutoCompress({
      messages: effectiveMessages,
      maxContextWindow: runtimeConfig.maxContextWindow,
      latestTokenUsage: existingConversation?.tokenUsage ?? null
    });

    if (shouldAutoCompress) {
      options.onEvent?.({
        type: "compression_started",
        trigger: "auto"
      });

      const compressionResult = await this.compressionService.compressConversation({
        messages: effectiveMessages,
        runtimeConfig,
        latestTokenUsage: existingConversation?.tokenUsage ?? null,
        trigger: "auto"
      });

      if (compressionResult?.compressed && Array.isArray(compressionResult.messages)) {
        let updatedHistory = this.historyStore.upsertConversation({
          conversationId,
          title: existingConversation?.title,
          workplacePath: existingConversation?.workplacePath,
          parentConversationId: existingConversation?.parentConversationId,
          source: existingConversation?.source,
          model: existingConversation?.model,
          modelProfileId: existingConversation?.modelProfileId,
          thinkingMode: existingConversation?.thinkingMode,
          approvalMode: existingConversation?.approvalMode,
          goal: existingConversation?.goal,
          skills: existingConversation?.skills,
          disabledTools: existingConversation?.disabledTools,
          developerPrompt: existingConversation?.developerPrompt,
          messages: compressionResult.messages
        });

        const compressionSnapshot = buildCompressionTokenSnapshot(compressionResult);
        if (compressionSnapshot) {
          updatedHistory =
            this.historyStore.updateConversationTokenSnapshot(
              conversationId,
              compressionSnapshot,
              buildCompressionSnapshotMetadata(compressionResult, existingConversation?.model)
            ) ?? updatedHistory;
        }

        existingConversation = updatedHistory ?? existingConversation;
        effectiveMessages = Array.isArray(updatedHistory?.messages)
          ? updatedHistory.messages
          : compressionResult.messages;

        options.onEvent?.({
          type: "compression_completed",
          trigger: "auto",
          history: updatedHistory,
          compression: {
            compressed: true,
            reason: String(compressionResult?.reason ?? ""),
            usageRatio: Number(compressionResult?.usageRatio ?? 0),
            estimatedTokensBefore: Number(compressionResult?.estimatedTokensBefore ?? 0),
            estimatedTokensAfter: Number(compressionResult?.estimatedTokensAfter ?? 0)
          }
        });
      } else {
        options.onEvent?.({
          type: "compression_completed",
          trigger: "auto",
          compression: {
            compressed: false,
            reason: String(compressionResult?.reason ?? "auto_compression_skipped"),
            usageRatio: Number(compressionResult?.usageRatio ?? 0),
            estimatedTokensBefore: Number(compressionResult?.estimatedTokensBefore ?? 0),
            estimatedTokensAfter: Number(compressionResult?.estimatedTokensAfter ?? 0)
          }
        });
      }
    }

    const workplacePath = normalizeText(existingConversation?.workplacePath);
    const pinnedMemorySummaryPrompt = await resolvePinnedMemorySummaryPrompt({
      historyStore: this.historyStore,
      memorySummaryStore: this.memorySummaryStore,
      conversationId,
      workspacePath: workplacePath,
      existingConversation
    });
    const promptMessages = await buildConversationPromptMessages({
      agentsPromptStore: this.agentsPromptStore,
      memorySummaryStore: this.memorySummaryStore,
      skillPromptBuilder: this.skillPromptBuilder,
      workspacePath: workplacePath,
      memorySummaryPrompt: pinnedMemorySummaryPrompt,
      developerPrompt: resolved.developerPrompt,
      personaPrompt: resolved.personaPrompt,
      activeSkillNames: resolved.activeSkillNames,
      runtimeConfig,
      definitionPrompt: resolved.definitionPrompt,
      includeAgentsPrompt: !resolved.isSubagent,
      includeMemorySummaryPrompt: !resolved.isSubagent,
      includeSubagentGuardPrompt: resolved.isSubagent
    });
    const modelHistoryMessages = this.compressionService.buildModelMessages(effectiveMessages);
    const recorder = new AgentConversationRecorder({
      initialMessages: effectiveMessages
    });
    const storedMessageSignatures = new Map();
    for (const message of effectiveMessages) {
      const id = String(message?.id ?? "").trim();
      if (!id) {
        continue;
      }
      storedMessageSignatures.set(id, buildStorageMessageSignature(message));
    }

    const syncRecorderToHistory = () => {
      const messages = recorder
        .getMessages()
        .map((item) => normalizeRecorderMessageForStorage(item));

      for (const message of messages) {
        const messageId = String(message.id ?? "").trim();
        if (!messageId) {
          continue;
        }

        const nextSignature = buildStorageMessageSignature(message);
        const previousSignature = storedMessageSignatures.get(messageId);
        if (previousSignature === nextSignature) {
          continue;
        }

        this.historyStore.upsertConversationMessage(conversationId, message, {
          updatedAt: Number(message.timestamp ?? Date.now())
        });
        storedMessageSignatures.set(messageId, nextSignature);
      }

      return messages;
    };
    const firstUserMessage = effectiveMessages.find(
      (message) => normalizeText(message?.role) === "user" && normalizeText(message?.content)
    );
    const firstSentence = extractFirstSentence(firstUserMessage?.content);
    const executionContext = {
      conversationId,
      runId: normalizeText(options.runId),
      sessionId: resolved.sessionId,
      agentId: resolved.agentId,
      agentType: resolved.agentType,
      currentAtomicStepId: normalizeText(options.currentAtomicStepId),
      abortSignal: options.abortSignal ?? null,
      workplacePath,
      workingDirectory: workplacePath,
      historyStore: this.historyStore,
      rawConversationMessages: effectiveMessages,
      runtimeConfig,
      goal: normalizeText(existingConversation?.goal),
      goalState: {},
      planState: normalizePlanState(existingConversation?.planState),
      memoryStore: this.memoryStore,
      skillCatalog: this.skillCatalog,
      skillValidator: this.skillValidator,
      skillPromptBuilder: this.skillPromptBuilder,
      activeSkillNames: resolved.activeSkillNames,
      developerPrompt: resolved.developerPrompt,
      personaPrompt: resolved.personaPrompt,
      remoteContext:
        options.remoteContext && typeof options.remoteContext === "object"
          ? options.remoteContext
          : null,
      orchestratorSchedulerService: this.orchestratorSchedulerService,
      orchestratorStore: this.orchestratorStore,
      orchestratorSupervisorService: this.orchestratorSupervisorService,
      flushQueuedInsertions: async ({ checkpoint } = {}) => {
        if (!this.orchestratorSchedulerService || !this.historyStore) {
          return [];
        }

        const readyInsertions = this.orchestratorSchedulerService.flushReadyInsertions(
          resolved.sessionId,
          resolved.agentId,
          {
            force: true,
            checkpoint: normalizeText(checkpoint)
          }
        );
        const messages = Array.isArray(readyInsertions)
          ? readyInsertions
              .map((item) => item?.message)
              .filter((item) => item && typeof item === "object" && !Array.isArray(item))
          : [];

        if (messages.length === 0) {
          return [];
        }

        this.historyStore.appendMessages(conversationId, messages, {
          updatedAt: Date.now()
        });
        const payload = {
          type: "conversation_messages_appended",
          messages,
          checkpoint: normalizeText(checkpoint)
        };
        recorder.applyEvent(payload);
        options.onEvent?.(payload);

        return messages;
      }
    };

    const runResult = await resolved.chatAgent.run({
      messages: [
        ...promptMessages,
        ...modelHistoryMessages
      ],
      runtimeConfig,
      executionContext,
      approvalMode: existingConversation?.approvalMode ?? "confirm",
      approvalStore: this.historyStore,
      approvalRules: await loadApprovalRules(this.approvalRulesStore),
      onEvent: (payload) => {
        if (payload?.type === "usage") {
          const usage = normalizeUsageRecordPayload(payload.usage);
          if (usage) {
            this.historyStore.recordConversationTokenUsage(conversationId, usage, {
              model: normalizeText(payload.model ?? runtimeConfig.model)
            });
            recorder.applyEvent({
              ...payload,
              usage
            });
          }
        } else {
          recorder.applyEvent(payload);
        }

        if (shouldSyncRecorderOnEvent(payload)) {
          syncRecorderToHistory();
        }

        options.onEvent?.(payload);
      }
    });

    syncRecorderToHistory();
    let updatedHistory = this.historyStore.getConversation(conversationId);
    let goalContinuationMessage = null;
    let planContinuationMessage = null;

    if (executionContext?.goalState?.submitted) {
      updatedHistory = this.historyStore.updateConversationGoal(conversationId, "") ?? updatedHistory;
    }

    if (
      normalizeText(runResult?.status) === "goal_incomplete" &&
      isGoalEnabled(updatedHistory?.goal)
    ) {
      goalContinuationMessage = createGoalContinuationMessage(updatedHistory.goal);
      updatedHistory = this.historyStore.appendMessages(
        conversationId,
        [goalContinuationMessage],
        {
          updatedAt: goalContinuationMessage.timestamp
        }
      ) ?? updatedHistory;
      options.onEvent?.({
        type: "conversation_messages_appended",
        messages: [goalContinuationMessage],
        checkpoint: "goal_incomplete_end"
      });
    }

    if (
      normalizeText(runResult?.status) === "plan_incomplete" &&
      isPlanIncomplete(executionContext?.planState)
    ) {
      planContinuationMessage = createPlanContinuationMessage(executionContext.planState);
      updatedHistory = this.historyStore.appendMessages(
        conversationId,
        [planContinuationMessage],
        {
          updatedAt: planContinuationMessage.timestamp
        }
      ) ?? updatedHistory;
      options.onEvent?.({
        type: "conversation_messages_appended",
        messages: [planContinuationMessage],
        checkpoint: "plan_incomplete_end"
      });
    }

    if (firstSentence && isAutoTitleCandidate(updatedHistory?.title)) {
      scheduleAsyncTitleGeneration({
        conversationId,
        firstSentence,
        configStore: this.configStore,
        historyStore: this.historyStore
      });
    }

    if (
      !resolved.isSubagent &&
      normalizeText(runResult?.status) !== "pending_approval" &&
      normalizeText(runResult?.status) !== "goal_incomplete" &&
      normalizeText(runResult?.status) !== "plan_incomplete"
    ) {
      this.memorySummaryService?.scheduleRefresh?.({
        conversationId
      });
    }

    const subagentCompletionRequest = resolveSubagentCompletionDispatchRequest({
      executionContext,
      runResult,
      status: normalizeText(runResult?.status) || "completed",
      displayName: this.orchestratorStore?.findAgentByConversationId?.(conversationId)?.displayName,
      agentType: resolved.agentType
    });

    return {
      ...runResult,
      history: updatedHistory,
      goalContinuationMessage,
      planContinuationMessage,
      sessionId: resolved.sessionId,
      agentId: resolved.agentId,
      agentType: resolved.agentType,
      isSubagent: resolved.isSubagent,
      subagentCompletionRequest
    };
  }
}
