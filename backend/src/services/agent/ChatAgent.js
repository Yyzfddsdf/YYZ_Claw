import {
  createModelProviderCapabilities,
  normalizeModelProvider
} from "../modelProviders/modelProviderDefinitions.js";
import { runModelProviderStream } from "../modelProviders/runtime.js";
import { StreamAssembler } from "../stream/StreamAssembler.js";
import {
  getApprovalGroupForToolCall,
  requiresApprovalForToolCall
} from "../config/ApprovalRulesStore.js";
import {
  createAbortError,
  isAbortError,
  sleepWithSignal,
  throwIfAborted
} from "../runs/runAbort.js";
import { ToolCallPreflightService } from "../tools/ToolCallPreflightService.js";
import { isPlanIncomplete } from "../chat/conversationRuntimeShared.js";

const DEFAULT_APPROVAL_MODE = "confirm";
const MAX_RUNTIME_TOOL_EVENT_CONTENT_CHARS = 1800;
const INTERNAL_TOOL_IMAGE_MESSAGE_KIND = "tool_image_input";

function createStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeApprovalMode(value) {
  return String(value ?? "").trim() === "auto" ? "auto" : DEFAULT_APPROVAL_MODE;
}

function getAssistantContentText(assistantRound) {
  return String(assistantRound?.assistantMessage?.content ?? "").trim();
}

function isGoalSubmitted(executionContext = {}) {
  return Boolean(executionContext?.goalState?.submitted);
}

function mergeRuntimeStateObject(targetContext = {}, sourceContext = {}, stateKey) {
  if (
    !sourceContext?.[stateKey] ||
    typeof sourceContext[stateKey] !== "object" ||
    Array.isArray(sourceContext[stateKey])
  ) {
    return;
  }

  const currentState =
    targetContext[stateKey] &&
    typeof targetContext[stateKey] === "object" &&
    !Array.isArray(targetContext[stateKey])
      ? targetContext[stateKey]
      : {};
  Object.assign(currentState, sourceContext[stateKey]);
  targetContext[stateKey] = currentState;
}

function createToolCallSkeleton() {
  return {
    id: "",
    type: "function",
    function: {
      name: "",
      arguments: ""
    }
  };
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens,
    promptTokensDetails:
      usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
        ? usage.prompt_tokens_details
        : null,
    completionTokensDetails:
      usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
        ? usage.completion_tokens_details
        : null
  };
}

function findLastUserMessageIndex(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "").trim() === "user") {
      return index;
    }
  }

  return -1;
}

function clipRuntimeText(text, maxChars = MAX_RUNTIME_TOOL_EVENT_CONTENT_CHARS) {
  const source = String(text ?? "");
  if (source.length <= maxChars) {
    return source;
  }

  const headChars = Math.max(400, Math.floor(maxChars * 0.82));
  const tailChars = Math.max(80, Math.floor(maxChars * 0.12));
  return `${source.slice(0, headChars)}\n...[truncated]...\n${source.slice(-tailChars)}`;
}

function sanitizeToolArgumentsJson(rawArguments) {
  if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    try {
      return JSON.stringify(rawArguments);
    } catch {
      return "{}";
    }
  }

  const text = String(rawArguments ?? "").trim();
  if (!text) {
    return "{}";
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch {
    return "{}";
  }

  return "{}";
}

function sanitizeToolCallsForModel(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") {
        return null;
      }

      return {
        ...toolCall,
        type: String(toolCall.type ?? "function").trim() || "function",
        id: String(toolCall.id ?? "").trim(),
        function: {
          name: String(toolCall?.function?.name ?? "").trim(),
          arguments: sanitizeToolArgumentsJson(toolCall?.function?.arguments)
        }
      };
    })
    .filter((toolCall) => toolCall && toolCall.function.name);
}

function sanitizeConversationForModel(conversation = [], options = {}) {
  const includeReasoningContent = Boolean(options.includeReasoningContent);
  return Array.isArray(conversation)
    ? conversation.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          return message;
        }

        const reasoningContent = includeReasoningContent
          ? String(message.reasoning_content ?? message.reasoningContent ?? "")
          : "";
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
          return reasoningContent
            ? {
                ...message,
                reasoning_content: reasoningContent
              }
            : message;
        }

        const sanitizedMessage = {
          ...message,
          tool_calls: sanitizeToolCallsForModel(message.tool_calls)
        };

        if (reasoningContent) {
          sanitizedMessage.reasoning_content = reasoningContent;
        }

        return sanitizedMessage;
      })
    : [];
}

function normalizeToolImageAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment, index) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return null;
      }

      const dataUrl = String(attachment.dataUrl ?? attachment.url ?? "").trim();
      const mimeType = String(attachment.mimeType ?? "").trim().toLowerCase();
      if (!dataUrl || !mimeType.startsWith("image/")) {
        return null;
      }

      return {
        id: String(attachment.id ?? `tool_image_${index + 1}`).trim() || `tool_image_${index + 1}`,
        type: "image",
        name: String(attachment.name ?? "").trim(),
        mimeType,
        dataUrl,
        size: Number(attachment.size ?? 0)
      };
    })
    .filter(Boolean);
}

export class ChatAgent {
  constructor(options) {
    this.toolRegistry = options.toolRegistry;
    this.approvalRulesStore = options.approvalRulesStore ?? null;
    this.toolCallPreflightService =
      options.toolCallPreflightService ??
      new ToolCallPreflightService({ toolRegistry: this.toolRegistry });
    this.longTermMemoryRecallService = options.longTermMemoryRecallService ?? null;
    this.runtimeBlockRuntime = options.runtimeBlockRuntime ?? null;
    this.runtimeInjectionComposer = options.runtimeInjectionComposer ?? null;
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 3;
    this.baseDelayMs = Number.isInteger(options.baseDelayMs)
      ? options.baseDelayMs
      : 500;
    this.maxDelayMs = Number.isInteger(options.maxDelayMs)
      ? options.maxDelayMs
      : 5000;
    this.maxEmptyFinalResponses = Number.isInteger(options.maxEmptyFinalResponses)
      ? options.maxEmptyFinalResponses
      : 3;
  }

  validateRuntimeConfig(runtimeConfig) {
    const model = runtimeConfig?.model?.trim();
    const baseURL = runtimeConfig?.baseURL?.trim();
    const apiKey = runtimeConfig?.apiKey?.trim();
    const provider = normalizeModelProvider(runtimeConfig?.provider);
    const providerCapabilities =
      runtimeConfig?.providerCapabilities && typeof runtimeConfig.providerCapabilities === "object"
        ? runtimeConfig.providerCapabilities
        : createModelProviderCapabilities(provider);
    const enableDeepThinking = Boolean(runtimeConfig?.enableDeepThinking);
    const reasoningEffort = String(runtimeConfig?.reasoningEffort ?? "").trim();
    const supportsThinking =
      providerCapabilities.supportsReasoningEffort ||
      providerCapabilities.supportsThinkingSwitch ||
      providerCapabilities.supportsReasoningContent;
    const supportsVision =
      runtimeConfig?.supportsVision !== false && providerCapabilities.supportsVision !== false;

    if (!model || !baseURL || !apiKey) {
      throw createStatusError("Invalid runtime config. Please save model/baseURL/apiKey first.", 400);
    }

    return {
      model,
      baseURL,
      apiKey,
      provider,
      providerCapabilities,
      enableDeepThinking: enableDeepThinking && supportsThinking,
      reasoningEffort,
      supportsThinking,
      supportsVision
    };
  }

  createModelProviderRequestParams(conversation, executionContext = {}, runtimeConfig = {}) {
    return {
      messages: sanitizeConversationForModel(conversation, {
        includeReasoningContent: Boolean(runtimeConfig.enableDeepThinking)
      }),
      tools: this.toolRegistry.getOpenAITools(executionContext),
      stream_options: {
        include_usage: true
      }
    };
  }

  isRetryable(error) {
    const status = error?.status;
    const code = error?.code;

    if (status === 429 || (typeof status === "number" && status >= 500)) {
      return true;
    }

    return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND"].includes(code);
  }

  async resolveApprovalRules(approvalRules) {
    if (approvalRules) {
      return approvalRules;
    }

    if (!this.approvalRulesStore || typeof this.approvalRulesStore.read !== "function") {
      return null;
    }

    return this.approvalRulesStore.read();
  }

  async executeWithRetry(operation, onEvent, signal) {
    let attempt = 0;

    while (true) {
      try {
        throwIfAborted(signal);
        return await operation();
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          throw isAbortError(error) ? error : createAbortError(signal?.reason ?? error);
        }

        const canRetry = attempt < this.maxRetries && this.isRetryable(error);

        if (!canRetry) {
          throw error;
        }

        const jitter = Math.floor(Math.random() * this.baseDelayMs);
        const delayMs = Math.min(
          this.maxDelayMs,
          this.baseDelayMs * 2 ** attempt + jitter
        );

        onEvent?.({
          type: "retry",
          attempt: attempt + 1,
          delayMs,
          message: error?.message || "retryable error"
        });

        await sleepWithSignal(delayMs, signal);
        attempt += 1;
      }
    }
  }

  mergeToolCallChunks(toolCallsByIndex, chunkToolCalls) {
    for (const piece of chunkToolCalls) {
      const index = Number.isInteger(piece?.index) ? piece.index : 0;
      const current = toolCallsByIndex.get(index) ?? createToolCallSkeleton();

      if (piece?.id) {
        current.id = piece.id;
      }

      if (piece?.type) {
        current.type = piece.type;
      }

      if (piece?.function?.name) {
        current.function.name += piece.function.name;
      }

      if (piece?.function?.arguments) {
        current.function.arguments += piece.function.arguments;
      }

      toolCallsByIndex.set(index, current);
    }
  }

  async consumeAssistantStream(stream, assembler, onEvent, options = {}) {
    const emitReasoning = Boolean(options.emitReasoning);
    const signal = options.signal ?? null;
    const toolCallsByIndex = new Map();
    let assistantText = "";
    let reasoningText = "";
    let usage = null;

    throwIfAborted(signal);

    for await (const chunk of stream) {
      throwIfAborted(signal);
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta;
      const normalizedUsage = normalizeTokenUsage(chunk?.usage);

      if (normalizedUsage) {
        usage = normalizedUsage;
      }

      if (!delta) {
        continue;
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        assistantText += delta.content;
        assembler.appendAssistantToken(delta.content);

        onEvent?.({
          type: "assistant_token",
          token: delta.content,
          mergedText: assembler.getMergedText()
        });
      }

      if (
        emitReasoning &&
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content.length > 0
      ) {
        reasoningText += delta.reasoning_content;

        onEvent?.({
          type: "assistant_reasoning_token",
          token: delta.reasoning_content,
          reasoningContent: reasoningText,
          mergedText: assembler.getMergedText()
        });
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        this.mergeToolCallChunks(toolCallsByIndex, delta.tool_calls);
      }
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, item], idx) => ({
        id: item.id || `tool_call_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.function.name,
          arguments: item.function.arguments || "{}"
        }
      }))
      .filter((item) => item.function.name);

    const assistantMessage = {
      role: "assistant",
      content: assistantText
    };

    if (reasoningText) {
      assistantMessage.reasoning_content = reasoningText;
      assistantMessage.reasoningContent = reasoningText;
    }

    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }

    onEvent?.({
      type: "assistant_message_end",
      content: assistantText,
      reasoningContent: reasoningText,
      toolCallCount: toolCalls.length,
      toolCalls,
      mergedText: assembler.getMergedText(),
      usage
    });

    return {
      assistantMessage,
      toolCalls,
      reasoningContent: reasoningText,
      usage
    };
  }

  async executeToolCall(toolCall, executionContext = {}) {
    throwIfAborted(executionContext?.abortSignal);
    const nestedExecutionContext = {
      ...executionContext,
      toolRegistry: this.toolRegistry
    };
    nestedExecutionContext.invokeToolCall = async (nestedToolCall, nestedContext = {}) => {
      const mergedNestedContext = {
        ...nestedExecutionContext,
        ...nestedContext
      };
      return this.toolRegistry.executeToolCall(nestedToolCall, mergedNestedContext);
    };

    try {
      const result = await this.toolRegistry.executeToolCall(toolCall, nestedExecutionContext);
      mergeRuntimeStateObject(executionContext, nestedExecutionContext, "goalState");
      mergeRuntimeStateObject(executionContext, nestedExecutionContext, "planState");
      throwIfAborted(nestedExecutionContext?.abortSignal);
      return result;
    } catch (error) {
      if (isAbortError(error) || nestedExecutionContext?.abortSignal?.aborted) {
        throw isAbortError(error)
          ? error
          : createAbortError(nestedExecutionContext?.abortSignal?.reason ?? error);
      }

      const name = toolCall?.function?.name || "unknown_tool";

      return {
        name,
        isError: true,
        content: JSON.stringify(
          {
            error: error?.message || "tool execution failed"
          },
          null,
          2
        ),
        modelContent: JSON.stringify(
          {
            error: error?.message || "tool execution failed"
          },
          null,
          2
        ),
        hooks: []
      };
    }
  }

  requiresApproval(toolCall, approvalMode, approvalRules) {
    const toolName = String(toolCall?.function?.name ?? "").trim();
    if (toolName === "clarify") {
      return true;
    }
    return requiresApprovalForToolCall(approvalRules, toolCall, approvalMode);
  }

  resolveTurnRuntime(executionContext = {}) {
    const turnRuntime =
      executionContext.turnRuntime && typeof executionContext.turnRuntime === "object"
        ? executionContext.turnRuntime
        : {};
    executionContext.turnRuntime = turnRuntime;
    return turnRuntime;
  }

  resolveRawConversationMessages(executionContext = {}) {
    if (Array.isArray(executionContext?.rawConversationMessages)) {
      return executionContext.rawConversationMessages;
    }

    const historyStore = executionContext?.historyStore;
    const conversationId = String(executionContext?.conversationId ?? "").trim();
    if (!historyStore || typeof historyStore.getConversation !== "function" || !conversationId) {
      return [];
    }

    const conversation = historyStore.getConversation(conversationId);
    return Array.isArray(conversation?.messages) ? conversation.messages : [];
  }

  resolveLongTermMemoryRecall(executionContext = {}) {
    const recallService =
      executionContext?.longTermMemoryRecallService ?? this.longTermMemoryRecallService;
    if (!recallService || typeof recallService.recallFromConversationMessages !== "function") {
      return null;
    }

    const turnRuntime = this.resolveTurnRuntime(executionContext);

    if (turnRuntime.longTermMemoryRecall) {
      return turnRuntime.longTermMemoryRecall;
    }

    const rawConversationMessages = this.resolveRawConversationMessages(executionContext);
    const recallResult = recallService.recallFromConversationMessages(
      rawConversationMessages,
      executionContext?.memoryStore
    );
    turnRuntime.longTermMemoryRecall = recallResult;
    return recallResult;
  }

  recordRuntimeToolEvent(executionContext = {}, payload = {}) {
    const turnRuntime = this.resolveTurnRuntime(executionContext);
    const runtimeToolEvents = Array.isArray(turnRuntime.runtimeToolEvents)
      ? turnRuntime.runtimeToolEvents
      : [];

    runtimeToolEvents.push({
      id:
        String(payload.id ?? "").trim()
        || `runtime_tool_event_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      phase: String(payload.phase ?? "").trim().toLowerCase() === "call" ? "call" : "result",
      toolCallId: String(payload.toolCallId ?? "").trim(),
      toolName: String(payload.toolName ?? "").trim(),
      isError: Boolean(payload.isError),
      argumentsText: clipRuntimeText(String(payload.argumentsText ?? ""), 1200),
      content: clipRuntimeText(String(payload.content ?? "")),
      timestamp: Number(payload.timestamp ?? Date.now()),
      metadata:
        payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? payload.metadata
          : {}
    });

    turnRuntime.runtimeToolEvents = runtimeToolEvents.slice(-24);
    if (turnRuntime.runtimeBlockRuntime) {
      delete turnRuntime.runtimeBlockRuntime;
    }
  }

  resolveRuntimeBlocks(conversation = [], executionContext = {}) {
    const runtimeBlockRuntime =
      executionContext?.runtimeBlockRuntime ?? this.runtimeBlockRuntime;
    if (!runtimeBlockRuntime || typeof runtimeBlockRuntime.resolve !== "function") {
      return null;
    }

    const rawConversationMessages = this.resolveRawConversationMessages(executionContext);
    return runtimeBlockRuntime.resolve({
      conversation,
      rawConversationMessages,
      executionContext
    });
  }

  buildToolImageInputPayload(toolCall, toolResult) {
    const imageAttachments = normalizeToolImageAttachments(toolResult?.imageAttachments);
    if (imageAttachments.length === 0) {
      return null;
    }

    const toolName = String(toolResult?.name ?? toolCall?.function?.name ?? "tool").trim() || "tool";
    const toolCallId = String(toolCall?.id ?? "").trim();
    const content = `Tool ${toolName} returned ${imageAttachments.length} image(s). Use them for the next reasoning step.`;
    const modelContent = [
      {
        type: "text",
        text: content
      },
      ...imageAttachments.map((attachment) => ({
        type: "image_url",
        image_url: {
          url: attachment.dataUrl
        }
      }))
    ];

    return {
      type: "tool_image_input",
      kind: INTERNAL_TOOL_IMAGE_MESSAGE_KIND,
      toolCallId,
      toolName,
      content,
      imageAttachments,
      modelContent
    };
  }

  appendToolImageInput({
    toolCall,
    toolResult,
    conversation,
    executionContext,
    onEvent,
    assembler
  }) {
    const imageInputPayload = this.buildToolImageInputPayload(toolCall, toolResult);
    if (!imageInputPayload) {
      return;
    }

    this.recordRuntimeToolEvent(executionContext, {
      phase: "result",
      toolCallId: imageInputPayload.toolCallId,
      toolName: `${imageInputPayload.toolName}:image_input`,
      isError: false,
      content: imageInputPayload.content,
      metadata: {
        imageCount: imageInputPayload.imageAttachments.length
      }
    });

    onEvent?.({
      type: imageInputPayload.type,
      kind: imageInputPayload.kind,
      toolCallId: imageInputPayload.toolCallId,
      toolName: imageInputPayload.toolName,
      content: imageInputPayload.content,
      imageAttachments: imageInputPayload.imageAttachments,
      mergedText: assembler.getMergedText()
    });

    conversation.push({
      role: "user",
      content: imageInputPayload.modelContent
    });
  }

  buildApiConversation(conversation = [], options = {}) {
    const runtimeInjectionComposer =
      options.runtimeInjectionComposer ?? this.runtimeInjectionComposer;
    if (!runtimeInjectionComposer || typeof runtimeInjectionComposer.compose !== "function") {
      return conversation;
    }

    return runtimeInjectionComposer.compose(conversation, options);
  }

  emitRuntimeHookInjectedEvents(runtimeBlocks, executionContext = {}, onEvent, assembler) {
    const currentUserBlocks = Array.isArray(runtimeBlocks?.blocksByChannel?.current_user)
      ? runtimeBlocks.blocksByChannel.current_user
      : [];
    if (currentUserBlocks.length === 0) {
      return;
    }

    const runtimeHookBlocks = currentUserBlocks.filter((block) => {
      const type = String(block?.type ?? "").trim().toLowerCase();
      return type === "runtime_hooks" || type === "remote_runtime_hooks";
    });
    if (runtimeHookBlocks.length === 0) {
      return;
    }

    const turnRuntime =
      executionContext?.turnRuntime && typeof executionContext.turnRuntime === "object"
        ? executionContext.turnRuntime
        : {};
    executionContext.turnRuntime = turnRuntime;

    const emittedKeys = new Set(
      Array.isArray(turnRuntime.runtimeHookEmittedKeys) ? turnRuntime.runtimeHookEmittedKeys : []
    );

    for (const block of runtimeHookBlocks) {
      const content = String(block?.content ?? "").trim();
      if (!content) {
        continue;
      }

      const dedupeKey = `${String(block?.type ?? "").trim().toLowerCase()}|${content}`;
      if (emittedKeys.has(dedupeKey)) {
        continue;
      }

      emittedKeys.add(dedupeKey);
      onEvent?.({
        type: "runtime_hook_injected",
        blockId: String(block?.id ?? "").trim(),
        hookType: String(block?.type ?? "").trim() || "runtime_hooks",
        source: String(block?.source ?? "").trim() || "hook",
        level: String(block?.level ?? "").trim() || "info",
        content,
        metadata:
          block?.metadata && typeof block.metadata === "object" && !Array.isArray(block.metadata)
            ? block.metadata
            : {},
        mergedText: assembler?.getMergedText?.() ?? ""
      });
    }

    turnRuntime.runtimeHookEmittedKeys = Array.from(emittedKeys).slice(-48);
  }

  preflightAssistantToolCalls(assistantRound, onEvent) {
    const toolCalls = Array.isArray(assistantRound?.toolCalls) ? assistantRound.toolCalls : [];
    if (toolCalls.length === 0) {
      return assistantRound;
    }

    const preflight = this.toolCallPreflightService?.preflightToolCalls?.(toolCalls) ?? {
      toolCalls,
      issues: [],
      repaired: false,
      hasErrors: false
    };
    const sanitizedToolCalls = Array.isArray(preflight.toolCalls) ? preflight.toolCalls : toolCalls;

    assistantRound.toolCalls = sanitizedToolCalls;
    if (assistantRound.assistantMessage) {
      assistantRound.assistantMessage.tool_calls = sanitizedToolCalls;
    }

    return assistantRound;
  }

  createPendingApprovalPayload({
    approvalStore,
    conversationId,
    conversation,
    assistantRound,
    runtimeConfig,
    executionContext,
    approvalMode,
    approvalRules
  }) {
    if (!approvalStore || typeof approvalStore.createPendingToolApproval !== "function") {
      throw createStatusError("approval store is not available", 500);
    }

    const pendingToolCall = assistantRound.toolCalls.find((toolCall) =>
      this.requiresApproval(toolCall, DEFAULT_APPROVAL_MODE, approvalRules)
    ) ?? assistantRound.toolCalls[0];
    const approvalGroup = getApprovalGroupForToolCall(approvalRules, pendingToolCall);
    const approvalSection = String(approvalGroup?.section ?? "unknown").trim() || "unknown";
    const approvalGroupName = String(approvalGroup?.groupName ?? "unknown").trim() || "unknown";
    const serializedExecutionContext = {
      conversationId: String(executionContext?.conversationId ?? "").trim(),
      sessionId: String(executionContext?.sessionId ?? "").trim(),
      agentId: String(executionContext?.agentId ?? "").trim(),
      agentType: String(executionContext?.agentType ?? "").trim(),
      currentAtomicStepId: String(executionContext?.currentAtomicStepId ?? "").trim(),
      workplacePath: String(executionContext?.workplacePath ?? "").trim(),
      workingDirectory: String(executionContext?.workingDirectory ?? "").trim(),
      goal: String(executionContext?.goal ?? "").trim(),
      goalState:
        executionContext?.goalState &&
        typeof executionContext.goalState === "object" &&
        !Array.isArray(executionContext.goalState)
          ? { ...executionContext.goalState }
          : {},
      planState:
        executionContext?.planState &&
        typeof executionContext.planState === "object" &&
        !Array.isArray(executionContext.planState)
          ? { ...executionContext.planState }
          : {},
      activeSkillNames: Array.isArray(executionContext?.activeSkillNames)
        ? executionContext.activeSkillNames
            .map((item) => String(item ?? "").trim())
            .filter((item) => item.length > 0)
        : []
    };

    const approvalId = `approval_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    const approvalRecord = approvalStore.createPendingToolApproval({
      approvalId,
      conversationId,
      toolCallId: pendingToolCall?.id ?? "",
      toolName: pendingToolCall?.function?.name ?? "",
      toolApprovalGroup: approvalGroupName,
      toolApprovalSection: approvalSection,
      toolArguments: sanitizeToolArgumentsJson(pendingToolCall?.function?.arguments),
      toolCalls: sanitizeToolCallsForModel(assistantRound.toolCalls),
      assistantMessage: assistantRound.assistantMessage,
      conversationSnapshot: sanitizeConversationForModel(conversation),
      runtimeConfig,
      executionContext: serializedExecutionContext,
      approvalMode
    });

    return approvalRecord ?? {
      id: approvalId,
      conversationId,
      status: "pending",
      toolCallId: pendingToolCall?.id ?? "",
      toolName: pendingToolCall?.function?.name ?? "",
      toolApprovalGroup: approvalGroupName,
      toolApprovalSection: approvalSection,
      toolArguments: sanitizeToolArgumentsJson(pendingToolCall?.function?.arguments),
      toolCalls: sanitizeToolCallsForModel(assistantRound.toolCalls),
      assistantMessage: assistantRound.assistantMessage,
      conversationSnapshot: sanitizeConversationForModel(conversation),
      approvalMode
    };
  }

  async flushRuntimeInsertionsAtCheckpoint({ conversation, executionContext, checkpoint }) {
    if (!Array.isArray(conversation)) {
      return [];
    }

    const flushQueuedInsertions = executionContext?.flushQueuedInsertions;
    if (typeof flushQueuedInsertions !== "function") {
      return [];
    }

    const messages = await flushQueuedInsertions({ checkpoint });
    const normalizedMessages = Array.isArray(messages)
      ? messages.filter((item) => item && typeof item === "object" && !Array.isArray(item))
      : [];

    for (const message of normalizedMessages) {
      const role = String(message.role ?? "user").trim() || "user";
      const content = String(message.content ?? "");

      if (role === "tool") {
        const toolCallId = String(message.toolCallId ?? message.tool_call_id ?? "").trim();
        if (!toolCallId) {
          continue;
        }

        conversation.push({
          role,
          tool_call_id: toolCallId,
          content
        });
        continue;
      }

      if (role !== "user" && role !== "assistant" && role !== "system") {
        continue;
      }

      const modelMessage = {
        role,
        content
      };
      const toolCalls = sanitizeToolCallsForModel(message.toolCalls ?? message.tool_calls);
      if (role === "assistant" && toolCalls.length > 0) {
        modelMessage.tool_calls = toolCalls;
      }

      conversation.push(modelMessage);
    }

    return normalizedMessages;
  }

  async runConversationLoop({
    validatedConfig,
    conversation,
    assembler,
    onEvent,
    executionContext,
    approvalMode = DEFAULT_APPROVAL_MODE,
    approvalStore,
    conversationId,
    approvalRules
  }) {
    const resolvedApprovalRules = await this.resolveApprovalRules(approvalRules);
    const abortSignal = executionContext?.abortSignal ?? null;
    this.resolveLongTermMemoryRecall(executionContext);
    executionContext.approvalMode = normalizeApprovalMode(approvalMode);
    let emptyFinalResponseCount = 0;

    while (true) {
      throwIfAborted(abortSignal);
      const runtimeBlocks = this.resolveRuntimeBlocks(conversation, executionContext);
      this.emitRuntimeHookInjectedEvents(runtimeBlocks, executionContext, onEvent, assembler);
      const currentTurnUserIndex = findLastUserMessageIndex(conversation);
      const apiConversation = this.buildApiConversation(conversation, {
        currentTurnUserIndex,
        runtimeBlocks: runtimeBlocks?.blocksByChannel ?? null
      });
      const stream = await this.executeWithRetry(
        () =>
          runModelProviderStream(
            validatedConfig,
            this.createModelProviderRequestParams(apiConversation, executionContext, validatedConfig),
            { signal: abortSignal }
          ),
        onEvent,
        abortSignal
      );

      const assistantRound = this.preflightAssistantToolCalls(
        await this.consumeAssistantStream(stream, assembler, onEvent, {
        emitReasoning: validatedConfig.enableDeepThinking,
        signal: abortSignal
        }),
        onEvent
      );
      conversation.push(assistantRound.assistantMessage);

      if (assistantRound.usage) {
        onEvent?.({
          type: "usage",
          model: validatedConfig.model,
          usage: assistantRound.usage,
          mergedText: assembler.getMergedText()
        });
      }

      if (assistantRound.toolCalls.length === 0) {
        const assistantContent = getAssistantContentText(assistantRound);

        if (!assistantContent) {
          const flushedInsertions = await this.flushRuntimeInsertionsAtCheckpoint({
            conversation,
            executionContext,
            checkpoint: "assistant_empty_end"
          });
          if (flushedInsertions.length > 0) {
            emptyFinalResponseCount = 0;
            continue;
          }

          emptyFinalResponseCount += 1;

          if (emptyFinalResponseCount > this.maxEmptyFinalResponses) {
            throw createStatusError("Model returned empty final response too many times.", 502);
          }

          continue;
        }

        const flushedInsertions = await this.flushRuntimeInsertionsAtCheckpoint({
          conversation,
          executionContext,
          checkpoint: "assistant_content_end"
        });
        if (flushedInsertions.length > 0) {
          emptyFinalResponseCount = 0;
          continue;
        }

        const finalState = assembler.snapshot();
        onEvent?.({ type: "final", ...finalState });
        if (isPlanIncomplete(executionContext?.planState)) {
          onEvent?.({
            type: "plan_incomplete",
            plan: executionContext.planState,
            mergedText: assembler.getMergedText()
          });
          return {
            status: "plan_incomplete",
            ...finalState
          };
        }
        if (String(executionContext?.goal ?? "").trim() && !isGoalSubmitted(executionContext)) {
          onEvent?.({
            type: "goal_incomplete",
            goal: String(executionContext?.goal ?? "").trim(),
            mergedText: assembler.getMergedText()
          });
          return {
            status: "goal_incomplete",
            ...finalState
          };
        }
        return {
          status: "completed",
          ...finalState
        };
      }

      if (
        assistantRound.toolCalls.some((toolCall) =>
          this.requiresApproval(toolCall, approvalMode, resolvedApprovalRules)
        )
      ) {
        const approvalRecord = this.createPendingApprovalPayload({
          approvalStore,
          conversationId,
          conversation: [...conversation],
          assistantRound,
          runtimeConfig: validatedConfig,
          executionContext,
          approvalMode,
          approvalRules: resolvedApprovalRules
        });

        onEvent?.({
          type: "tool_pending_approval",
          approvalId: approvalRecord.id,
          conversationId,
          toolCallId: approvalRecord.toolCallId,
          toolName: approvalRecord.toolName,
          toolApprovalGroup: approvalRecord.toolApprovalGroup,
          toolApprovalSection: approvalRecord.toolApprovalSection,
          arguments: approvalRecord.toolArguments,
          toolCount: assistantRound.toolCalls.length,
          approvalMode: normalizeApprovalMode(approvalMode)
        });

        return {
          status: "pending_approval",
          approvalId: approvalRecord.id,
          toolCallId: approvalRecord.toolCallId,
          toolName: approvalRecord.toolName
        };
      }

      for (const toolCall of assistantRound.toolCalls) {
        throwIfAborted(abortSignal);
        this.recordRuntimeToolEvent(executionContext, {
          phase: "call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          argumentsText: toolCall.function.arguments
        });

        onEvent?.({
          type: "tool_call",
          toolName: toolCall.function.name,
          arguments: toolCall.function.arguments,
          toolCallId: toolCall.id
        });

        const toolResult = await this.executeToolCall(toolCall, executionContext);
        this.recordRuntimeToolEvent(executionContext, {
          phase: "result",
          toolCallId: toolCall.id,
          toolName: toolResult.name,
          isError: toolResult.isError,
          content: toolResult.content,
          metadata: {
            hooks: Array.isArray(toolResult.hooks) ? toolResult.hooks.length : 0
          }
        });
        assembler.appendToolResult(
          toolResult.name,
          toolResult.modelContent ?? toolResult.content
        );

        onEvent?.({
          type: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolResult.name,
          content: toolResult.content,
          hooks: Array.isArray(toolResult.hooks) ? toolResult.hooks : [],
          isError: toolResult.isError,
          mergedText: assembler.getMergedText()
        });

        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult.modelContent ?? toolResult.content
        });

        this.appendToolImageInput({
          toolCall,
          toolResult,
          conversation,
          executionContext,
          onEvent,
          assembler
        });
      }

      const flushedInsertions = await this.flushRuntimeInsertionsAtCheckpoint({
        conversation,
        executionContext,
        checkpoint: "tool_results_end"
      });
      if (flushedInsertions.length > 0) {
        emptyFinalResponseCount = 0;
        continue;
      }

      emptyFinalResponseCount = 0;
    }
  }

  async run(params) {
    const {
      messages,
      runtimeConfig,
      onEvent,
      executionContext,
      approvalMode = DEFAULT_APPROVAL_MODE,
      approvalStore,
      approvalRules
    } = params;
    const validatedConfig = this.validateRuntimeConfig(runtimeConfig);
    const assembler = new StreamAssembler();
    const conversation = [...messages];
    const normalizedApprovalMode = normalizeApprovalMode(approvalMode);
    const conversationId = String(executionContext?.conversationId ?? "").trim();
    const resolvedApprovalRules = await this.resolveApprovalRules(approvalRules);

    return this.runConversationLoop({
      validatedConfig,
      conversation,
      assembler,
      onEvent,
      executionContext,
      approvalMode: normalizedApprovalMode,
      approvalStore,
      conversationId,
      approvalRules: resolvedApprovalRules
    });
  }

  async resumePendingApproval(params) {
    const {
      pendingApproval,
      runtimeConfig,
      onEvent,
      approvalStore,
      approvalRules,
      executionContext: executionContextOverride = {}
    } = params;

    if (!pendingApproval) {
      throw createStatusError("pending approval is required", 400);
    }

    const validatedConfig = this.validateRuntimeConfig(runtimeConfig ?? pendingApproval.runtimeConfig);
    const assembler = new StreamAssembler();
    const conversation = Array.isArray(pendingApproval.conversationSnapshot)
      ? [...pendingApproval.conversationSnapshot]
      : [];
    const executionContext = {
      ...(pendingApproval.executionContext ?? {}),
      ...(executionContextOverride ?? {})
    };
    executionContext.approvalMode = String(pendingApproval.approvalMode ?? DEFAULT_APPROVAL_MODE).trim();
    const abortSignal = executionContext?.abortSignal ?? null;
    const preflight = this.toolCallPreflightService?.preflightToolCalls?.(
      Array.isArray(pendingApproval.toolCalls) ? pendingApproval.toolCalls : []
    ) ?? {
      toolCalls: Array.isArray(pendingApproval.toolCalls) ? pendingApproval.toolCalls : [],
      issues: []
    };
    const toolCalls = Array.isArray(preflight.toolCalls) ? preflight.toolCalls : [];

    for (const toolCall of toolCalls) {
      throwIfAborted(abortSignal);
      const toolResult = await this.executeToolCall(toolCall, executionContext);
      this.recordRuntimeToolEvent(executionContext, {
        phase: "result",
        toolCallId: toolCall.id,
        toolName: toolResult.name,
        isError: toolResult.isError,
        content: toolResult.content,
        metadata: {
          hooks: Array.isArray(toolResult.hooks) ? toolResult.hooks.length : 0
        }
      });
      assembler.appendToolResult(
        toolResult.name,
        toolResult.modelContent ?? toolResult.content
      );

      onEvent?.({
        type: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolResult.name,
        content: toolResult.content,
        hooks: Array.isArray(toolResult.hooks) ? toolResult.hooks : [],
        isError: toolResult.isError,
        mergedText: assembler.getMergedText()
      });

      conversation.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult.modelContent ?? toolResult.content
      });

      this.appendToolImageInput({
        toolCall,
        toolResult,
        conversation,
        executionContext,
        onEvent,
        assembler
      });
    }

    const resolvedApprovalRules = await this.resolveApprovalRules(approvalRules);

    return this.runConversationLoop({
      validatedConfig,
      conversation,
      assembler,
      onEvent,
      executionContext,
      approvalMode: pendingApproval.approvalMode ?? DEFAULT_APPROVAL_MODE,
      approvalStore,
      conversationId: String(pendingApproval.conversationId ?? "").trim(),
      approvalRules: resolvedApprovalRules
    });
  }
}
