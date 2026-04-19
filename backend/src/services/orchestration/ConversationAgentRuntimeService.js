import { configSchema } from "../../schemas/configSchema.js";
import {
  buildConversationPromptMessages,
  buildCompressionSnapshotMetadata,
  buildCompressionTokenSnapshot,
  extractFirstSentence,
  isAutoTitleCandidate,
  loadApprovalRules,
  normalizeUsageRecordPayload,
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
      return {
        history,
        sessionId: sessionId || conversationId,
        agentId: agentRecord?.agentId ?? `primary:${sessionId || conversationId}`,
        agentType: "primary",
        isSubagent: false,
        activeSkillNames,
        developerPrompt: normalizeText(history?.developerPrompt),
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
    const runtimeConfig = resolveAgentRuntimeConfig(configValidation.data, {
      isSubagent: Boolean(resolved?.isSubagent),
      enableDeepThinking: Boolean(options.enableDeepThinking)
    });
    let existingConversation = resolved.history;
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
          approvalMode: existingConversation?.approvalMode,
          skills: existingConversation?.skills,
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
      activeSkillNames: resolved.activeSkillNames,
      definitionPrompt: resolved.definitionPrompt,
      includeAgentsPrompt: !resolved.isSubagent,
      includeMemorySummaryPrompt: !resolved.isSubagent,
      includeSubagentGuardPrompt: resolved.isSubagent
    });
    const modelHistoryMessages = this.compressionService.buildModelMessages(effectiveMessages);
    const recorder = new AgentConversationRecorder({
      initialMessages: effectiveMessages
    });
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
      memoryStore: this.memoryStore,
      skillCatalog: this.skillCatalog,
      skillValidator: this.skillValidator,
      skillPromptBuilder: this.skillPromptBuilder,
      activeSkillNames: resolved.activeSkillNames,
      developerPrompt: resolved.developerPrompt,
      orchestratorSchedulerService: this.orchestratorSchedulerService,
      orchestratorStore: this.orchestratorStore,
      orchestratorSupervisorService: this.orchestratorSupervisorService
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

        options.onEvent?.(payload);
      }
    });

    const nextMessages = recorder.getMessages();
    const updatedHistory = this.historyStore.mergeConversation({
      conversationId,
      title: existingConversation?.title,
      workplacePath: existingConversation?.workplacePath,
      parentConversationId: existingConversation?.parentConversationId,
      source: existingConversation?.source,
      model: runtimeConfig.model,
      approvalMode: existingConversation?.approvalMode,
      skills: existingConversation?.skills,
      developerPrompt: existingConversation?.developerPrompt,
      messages: nextMessages
    });

    if (firstSentence && isAutoTitleCandidate(updatedHistory?.title)) {
      scheduleAsyncTitleGeneration({
        conversationId,
        firstSentence,
        configStore: this.configStore,
        historyStore: this.historyStore
      });
    }

    if (!resolved.isSubagent && normalizeText(runResult?.status) !== "pending_approval") {
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
      sessionId: resolved.sessionId,
      agentId: resolved.agentId,
      agentType: resolved.agentType,
      isSubagent: resolved.isSubagent,
      subagentCompletionRequest
    };
  }
}
