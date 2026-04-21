import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { configSchema } from "../../../schemas/configSchema.js";
import { ChatAgent } from "../../../services/agent/ChatAgent.js";
import { buildConversationPromptMessages } from "../../../services/chat/conversationRuntimeShared.js";
import { RuntimeBlockRegistry } from "../../../services/runtime/RuntimeBlockRegistry.js";
import { RuntimeBlockRuntime } from "../../../services/runtime/RuntimeBlockRuntime.js";
import { RuntimeInjectionComposer } from "../../../services/runtime/RuntimeInjectionComposer.js";
import { RuntimeScopeBuilder } from "../../../services/runtime/RuntimeScopeBuilder.js";
import longTermMemoryRecallProvider from "../../../services/runtime/providers/longTermMemoryRecall.runtime-block.js";
import { ScopedToolRegistry } from "./ScopedToolRegistry.js";
import { RemoteConversationRecorder } from "./RemoteConversationRecorder.js";
import remoteRuntimeHooksProvider from "./providers/remoteRuntimeHooks.runtime-block.js";

function createEphemeralId(prefix = "remote") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
        return null;
      }

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
    .filter(Boolean);
}

function normalizeMessageMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }

  return {
    ...meta
  };
}

function normalizeAttachment(attachment = {}, index = 0) {
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
    return null;
  }

  const dataUrl = String(attachment.dataUrl ?? attachment.url ?? "").trim();
  const mimeType = String(attachment.mimeType ?? "").trim();
  const hasRenderableImage = dataUrl.length > 0 && mimeType.startsWith("image/");
  if (!hasRenderableImage) {
    return null;
  }

  return {
    id: String(attachment.id ?? `image_${index + 1}`).trim() || `image_${index + 1}`,
    name: String(attachment.name ?? "").trim(),
    mimeType,
    dataUrl,
    size: Number(attachment.size ?? 0)
  };
}

function normalizeParsedFile(file = {}, index = 0) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    return null;
  }

  const name = String(file.name ?? `file_${index + 1}`).trim() || `file_${index + 1}`;
  const extractedText = String(file.extractedText ?? "");
  const note = String(file.note ?? "").trim();
  const parseStatus = String(file.parseStatus ?? "").trim() || "parsed";

  return {
    id: String(file.id ?? `parsed_file_${index + 1}`).trim() || `parsed_file_${index + 1}`,
    name,
    mimeType: String(file.mimeType ?? "").trim(),
    extension: String(file.extension ?? "").trim(),
    size: Number(file.size ?? 0),
    parseStatus,
    note,
    extractedText
  };
}

function normalizeReplyTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const messageId = String(value.messageId ?? value.message_id ?? "").trim();
  const chatId = String(value.chatId ?? value.chat_id ?? "").trim();
  if (!messageId && !chatId) {
    return null;
  }

  return {
    messageId,
    chatId
  };
}

function normalizeInboundMessage(message = {}, options = {}) {
  const platformKey = String(options.platformKey ?? "remote").trim() || "remote";
  const defaultSessionKey = String(options.defaultSessionKey ?? `${platformKey}_default`).trim();

  const content = String(message.content ?? message.text ?? "").trim();
  const attachments = (Array.isArray(message.attachments) ? message.attachments : [])
    .map((item, index) => normalizeAttachment(item, index))
    .filter(Boolean);
  const parsedFiles = (Array.isArray(message.parsedFiles) ? message.parsedFiles : [])
    .map((item, index) => normalizeParsedFile(item, index))
    .filter(Boolean);
  const timestamp = Number(message.timestamp ?? Date.now());
  const originMessageId = String(message.originMessageId ?? message.messageId ?? "").trim();
  const messageId = originMessageId || createEphemeralId(`${platformKey}_inbound`);
  const sessionKey = String(message.sessionKey ?? "").trim() || defaultSessionKey;
  const messageType = String(message.messageType ?? "").trim().toLowerCase();
  const replyTarget = normalizeReplyTarget(message.replyTarget);

  if (!content && attachments.length === 0 && parsedFiles.length === 0) {
    return null;
  }

  return {
    id: messageId,
    content,
    attachments,
    parsedFiles,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    sessionKey,
    messageType,
    replyTarget
  };
}

function buildInboundMessageMeta(payload, options = {}) {
  const platformKey = String(options.platformKey ?? "remote").trim() || "remote";
  const messageKind = String(options.messageKind ?? `${platformKey}_user_message`).trim();

  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const parsedFiles = Array.isArray(payload?.parsedFiles) ? payload.parsedFiles : [];
  const replyTarget = normalizeReplyTarget(payload?.replyTarget);
  const sessionKey = String(payload?.sessionKey ?? "").trim();
  const messageType = String(payload?.messageType ?? "").trim().toLowerCase();

  return {
    kind: messageKind,
    origin: platformKey,
    ...(sessionKey ? { sessionKey } : {}),
    ...(messageType ? { messageType } : {}),
    ...(replyTarget ? { replyTarget } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(parsedFiles.length > 0 ? { parsedFiles } : {})
  };
}

function normalizeExecutionConfig(runtimeConfig) {
  return {
    ...runtimeConfig,
    enableDeepThinking: false
  };
}

function normalizeSkillNames(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const skillName = String(item ?? "").trim();
    if (!skillName) {
      continue;
    }

    const key = skillName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(skillName);
  }

  return normalized;
}

function resolveWorkspacePath(candidatePath, fallbackPath) {
  const normalizedFallback = String(fallbackPath ?? "").trim() || process.cwd();
  const normalizedCandidate = String(candidatePath ?? "").trim();
  if (!normalizedCandidate) {
    return normalizedFallback;
  }

  const resolvedPath = path.resolve(normalizedCandidate);
  try {
    if (!fs.existsSync(resolvedPath)) {
      return normalizedFallback;
    }
  } catch {
    return normalizedFallback;
  }
  return resolvedPath;
}

function takeBatchBySession(queue = [], defaultSessionKey = "remote_default") {
  if (!Array.isArray(queue) || queue.length === 0) {
    return [];
  }

  const first = queue.shift();
  if (!first) {
    return [];
  }

  const sessionKey = String(first?.sessionKey ?? "").trim() || defaultSessionKey;
  const batch = [first];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    const itemSessionKey = String(item?.sessionKey ?? "").trim() || defaultSessionKey;
    if (itemSessionKey !== sessionKey) {
      continue;
    }

    batch.push(item);
    queue.splice(index, 1);
  }

  return batch.sort((left, right) => Number(left?.timestamp ?? 0) - Number(right?.timestamp ?? 0));
}

function resolveReplyTargetFromBatch(batch = []) {
  const normalizedBatch = Array.isArray(batch) ? batch : [];
  for (let index = normalizedBatch.length - 1; index >= 0; index -= 1) {
    const item = normalizedBatch[index];
    const replyTarget = normalizeReplyTarget(item?.replyTarget);
    if (replyTarget?.messageId || replyTarget?.chatId) {
      return replyTarget;
    }
  }
  return null;
}

function pickFinalAssistantReplyText(messages = [], fallbackText = "") {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    const item = normalizedMessages[index];
    if (String(item?.role ?? "").trim() !== "assistant") {
      continue;
    }

    const content = String(item?.content ?? "").trim();
    if (!content) {
      continue;
    }

    return content;
  }

  const fallback = String(fallbackText ?? "").trim();
  return fallback || "已处理完成。";
}

export class RemoteControlRuntimeService {
  constructor(options = {}) {
    this.platformKey = String(options.platformKey ?? "remote").trim().toLowerCase() || "remote";
    this.platformLabel = String(options.platformLabel ?? this.platformKey).trim() || this.platformKey;
    this.turnSource = String(options.turnSource ?? this.platformKey).trim() || this.platformKey;
    this.messageKind =
      String(options.messageKind ?? `${this.platformKey}_user_message`).trim() ||
      `${this.platformKey}_user_message`;
    this.defaultSessionKey =
      String(options.defaultSessionKey ?? `${this.platformKey}_default`).trim() ||
      `${this.platformKey}_default`;

    this.coreConfigStore = options.coreConfigStore ?? options.configStore ?? null;
    this.controlConfigStore = options.controlConfigStore ?? null;
    this.historyStore = options.historyStore ?? null;
    this.channelToolRegistry = options.channelToolRegistry ?? null;
    this.replyClient = options.replyClient ?? null;
    this.agentsPromptStore = options.agentsPromptStore ?? null;
    this.memorySummaryStore = options.memorySummaryStore ?? null;
    this.skillPromptBuilder = options.skillPromptBuilder ?? null;
    this.memoryStore = options.memoryStore ?? null;
    this.longTermMemoryRecallService = options.longTermMemoryRecallService ?? null;
    this.remoteHookRegistry = options.remoteHookRegistry ?? null;
    this.remoteHookBlockBuilder = options.remoteHookBlockBuilder ?? null;
    this.defaultWorkplacePath = String(options.defaultWorkplacePath ?? "").trim() || process.cwd();

    this.queue = [];
    this.seenInboundMessageIds = new Set();
    this.queueTimer = null;
    this.queueFlushDelayMs = Number(options.queueFlushDelayMs ?? 1200);
    this.flushPromise = null;
    this.isRunning = false;
    this.activeTurnId = 0;
    this.lastRunError = "";
    this.lastRunAt = 0;

    const runtimeBlockRegistry = new RuntimeBlockRegistry();
    runtimeBlockRegistry.register(longTermMemoryRecallProvider);
    runtimeBlockRegistry.register(remoteRuntimeHooksProvider);
    this.runtimeBlockRuntime = new RuntimeBlockRuntime({
      blockRegistry: runtimeBlockRegistry,
      scopeBuilder: new RuntimeScopeBuilder({
        compressionService: null,
        recentTurnWindow: 10
      }),
      services: {
        remoteHookBlockBuilder: this.remoteHookBlockBuilder
      },
      maxSystemBlocks: 3,
      maxSystemChars: 2200,
      maxCurrentUserBlocks: 2,
      maxCurrentUserChars: 8000
    });
    this.runtimeInjectionComposer = new RuntimeInjectionComposer();
  }

  getStatus() {
    return {
      running: this.isRunning,
      queuedCount: this.queue.length,
      activeTurnId: Number(this.activeTurnId ?? 0),
      lastRunError: String(this.lastRunError ?? ""),
      lastRunAt: Number(this.lastRunAt ?? 0)
    };
  }

  scheduleFlush(delayMs = this.queueFlushDelayMs) {
    if (this.queueTimer) {
      return;
    }

    const waitMs = Number.isFinite(Number(delayMs)) && Number(delayMs) >= 0 ? Number(delayMs) : 0;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.flushQueue().catch(() => {});
    }, waitMs);
  }

  async enqueueUserMessages(payloads = []) {
    const list = Array.isArray(payloads) ? payloads : [payloads];
    const accepted = [];

    for (const item of list) {
      const normalized = normalizeInboundMessage(item, {
        platformKey: this.platformKey,
        defaultSessionKey: this.defaultSessionKey
      });
      if (!normalized) {
        continue;
      }

      if (this.seenInboundMessageIds.has(normalized.id)) {
        continue;
      }

      this.seenInboundMessageIds.add(normalized.id);
      if (this.seenInboundMessageIds.size > 2000) {
        const overflow = Array.from(this.seenInboundMessageIds).slice(0, 600);
        for (const id of overflow) {
          this.seenInboundMessageIds.delete(id);
        }
      }

      this.queue.push(normalized);
      accepted.push(normalized.id);
    }

    if (this.queue.length > 0) {
      if (this.isRunning) {
        this.scheduleFlush(0);
      } else {
        this.scheduleFlush(this.queueFlushDelayMs);
      }
    }

    return {
      acceptedCount: accepted.length,
      acceptedIds: accepted,
      queuedCount: this.queue.length,
      running: this.isRunning
    };
  }

  async flushQueue() {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = this.performFlush().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async performFlush() {
    if (!this.historyStore) {
      throw new Error("historyStore is unavailable");
    }

    while (this.queue.length > 0) {
      if (this.isRunning) {
        return;
      }

      const batch = takeBatchBySession(this.queue, this.defaultSessionKey);
      if (batch.length === 0) {
        return;
      }

      const nextTurn = this.historyStore.beginTurn({
        source: this.turnSource,
        providerKey: this.platformKey,
        createdAt: Date.now()
      });

      this.activeTurnId = Number(nextTurn?.id ?? 0);
      const turnId = this.activeTurnId;
      const userMessages = batch.map((item) => ({
        id: `${this.platformKey}_user_${randomUUID()}`,
        role: "user",
        source: "user",
        providerKey: this.platformKey,
        content: item.content,
        timestamp: item.timestamp,
        meta: buildInboundMessageMeta(item, {
          platformKey: this.platformKey,
          messageKind: this.messageKind
        })
      }));
      this.historyStore.appendMessages(turnId, userMessages);

      this.isRunning = true;
      this.lastRunError = "";
      try {
        await this.runTurn(turnId, {
          batch
        });
      } catch (error) {
        this.lastRunError = String(error?.message ?? `${this.platformLabel} runtime failed`);
      } finally {
        this.lastRunAt = Date.now();
        this.isRunning = false;
        this.activeTurnId = 0;
      }
    }
  }

  async runTurn(turnId, options = {}) {
    const resolvedTurnId = Number(turnId ?? 0);
    if (!Number.isInteger(resolvedTurnId) || resolvedTurnId <= 0) {
      throw new Error("turnId is required");
    }

    const batch = Array.isArray(options.batch) ? options.batch : [];
    const replyTarget = resolveReplyTargetFromBatch(batch);

    const runtimeConfigValidation = configSchema.safeParse(await this.coreConfigStore.read());
    if (!runtimeConfigValidation.success) {
      const errorMessage = "主运行模型配置无效，无法执行远程请求";
      this.historyStore.appendMessages(resolvedTurnId, [
        {
          id: `${this.platformKey}_runtime_error_${randomUUID()}`,
          role: "assistant",
          source: "assistant",
          providerKey: this.platformKey,
          content: errorMessage,
          timestamp: Date.now(),
          meta: {
            kind: "runtime_error"
          }
        }
      ]);
      await this.deliverReplyToChannel({
        replyTarget,
        text: errorMessage,
        turnId: resolvedTurnId
      });
      this.historyStore.closeTurn(resolvedTurnId, {
        status: "failed"
      });
      return;
    }

    const controlConfig = this.controlConfigStore ? await this.controlConfigStore.read() : {};
    const workspacePath = resolveWorkspacePath(
      controlConfig?.workspacePath,
      this.defaultWorkplacePath
    );
    const developerPrompt = String(controlConfig?.developerPrompt ?? "").trim();
    const activeSkillNames = normalizeSkillNames(controlConfig?.activeSkillNames);
    const runtimeConfig = normalizeExecutionConfig(runtimeConfigValidation.data);
    const toolRegistry = new ScopedToolRegistry({
      baseToolRegistry: this.channelToolRegistry,
      allowedToolNames: null,
      scopeName: `${this.platformLabel} runtime`
    });

    const chatAgent = new ChatAgent({
      toolRegistry,
      approvalRulesStore: null,
      longTermMemoryRecallService: this.longTermMemoryRecallService,
      runtimeBlockRuntime: this.runtimeBlockRuntime,
      runtimeInjectionComposer: this.runtimeInjectionComposer,
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000
    });

    const turnMessages = this.historyStore.getMessagesByTurnIds([resolvedTurnId]);
    const existingMessageIds = new Set(turnMessages.map((item) => String(item.id ?? "").trim()).filter(Boolean));
    const recorder = new RemoteConversationRecorder({
      initialMessages: turnMessages
    });

    const contextMessages = this.historyStore.buildContextMessages({
      currentTurnId: resolvedTurnId,
      maxTurns: 30
    });
    const promptMessages = await buildConversationPromptMessages({
      agentsPromptStore: this.agentsPromptStore,
      memorySummaryStore: this.memorySummaryStore,
      skillPromptBuilder: this.skillPromptBuilder,
      workspacePath,
      developerPrompt,
      activeSkillNames,
      definitionPrompt: "",
      includeAgentsPrompt: true,
      includeMemorySummaryPrompt: false,
      includeWorkplacePrompt: true,
      includeLongTermMemoryPrompt: true,
      includeSkillsPrompt: true,
      includeSubagentGuardPrompt: false
    });

    try {
      const result = await chatAgent.run({
        messages: [
          ...promptMessages,
          ...contextMessages
        ],
        runtimeConfig,
        approvalMode: "auto",
        approvalStore: null,
        approvalRules: null,
        executionContext: {
          conversationId: `${this.platformKey}_turn_${resolvedTurnId}`,
          runId: `${this.platformKey}_run_${randomUUID()}`,
          workplacePath: workspacePath,
          workingDirectory: workspacePath,
          memoryStore: this.memoryStore,
          rawConversationMessages: contextMessages
            .filter((message) => String(message?.role ?? "").trim() !== "system")
            .map((message, index) => ({
              id: `${this.platformKey}_context_${resolvedTurnId}_${index + 1}`,
              role: String(message?.role ?? "").trim() || "user",
              content:
                typeof message?.content === "string"
                  ? message.content
                  : JSON.stringify(message?.content ?? ""),
              timestamp: Date.now()
            }))
        },
        onEvent: (event) => {
          recorder.applyEvent(event);
        }
      });

      const nextMessages = recorder.getMessages();
      const appendedMessages = nextMessages
        .filter((message) => !existingMessageIds.has(String(message.id ?? "").trim()))
        .map((message) => ({
          id:
            String(message.id ?? `${this.platformKey}_generated_${randomUUID()}`).trim() ||
            `${this.platformKey}_generated_${randomUUID()}`,
          role: String(message.role ?? "assistant").trim() || "assistant",
          source: String(message.source ?? "").trim()
            || (
              String(message.role ?? "").trim() === "assistant"
                ? "assistant"
                : String(message.role ?? "").trim() === "tool"
                  ? "tool"
                  : String(message.role ?? "").trim() === "user"
                    ? "user"
                    : "system"
            ),
          providerKey: this.platformKey,
          content: String(message.content ?? ""),
          reasoningContent: String(message.reasoningContent ?? ""),
          toolCallId: String(message.toolCallId ?? "").trim(),
          toolName: String(message.toolName ?? "").trim(),
          toolCalls: normalizeToolCalls(message.toolCalls),
          timestamp: Number(message.timestamp ?? Date.now()),
          meta: normalizeMessageMeta(message.meta)
        }));

      if (appendedMessages.length > 0) {
        this.historyStore.appendMessages(resolvedTurnId, appendedMessages);
      }

      const finalReplyText = pickFinalAssistantReplyText(
        appendedMessages,
        String(result?.outputText ?? "")
      );
      await this.deliverReplyToChannel({
        replyTarget,
        text: finalReplyText,
        turnId: resolvedTurnId
      });

      this.historyStore.closeTurn(resolvedTurnId, {
        status: "completed"
      });
    } catch (error) {
      const errorMessage = String(error?.message ?? `${this.platformLabel} 请求执行失败`);
      this.historyStore.appendMessages(resolvedTurnId, [
        {
          id: `${this.platformKey}_runtime_exception_${randomUUID()}`,
          role: "assistant",
          source: "assistant",
          providerKey: this.platformKey,
          content: errorMessage,
          timestamp: Date.now(),
          meta: {
            kind: "runtime_error",
            subtype: "execution_exception"
          }
        }
      ]);
      await this.deliverReplyToChannel({
        replyTarget,
        text: errorMessage,
        turnId: resolvedTurnId
      });
      this.historyStore.closeTurn(resolvedTurnId, {
        status: "failed"
      });
    }
  }

  async deliverReplyToChannel({ replyTarget, text, turnId }) {
    const normalizedReplyTarget = normalizeReplyTarget(replyTarget);
    const messageId = String(normalizedReplyTarget?.messageId ?? "").trim();
    const content = String(text ?? "").trim();
    if (!messageId || !content) {
      return;
    }

    if (!this.replyClient) {
      return;
    }

    const trySend = async () => {
      if (typeof this.replyClient.replyTextInChunks === "function") {
        await this.replyClient.replyTextInChunks({
          messageId,
          text: content
        });
        return;
      }

      if (typeof this.replyClient.replyText === "function") {
        await this.replyClient.replyText({
          messageId,
          text: content
        });
      }
    };

    try {
      await trySend();
    } catch (error) {
      const message = `${this.platformLabel} 回发失败: ${String(error?.message ?? "unknown error")}`;
      this.lastRunError = message;

      if (this.historyStore && Number.isInteger(Number(turnId)) && Number(turnId) > 0) {
        this.historyStore.appendMessages(Number(turnId), [
          {
            id: `${this.platformKey}_delivery_error_${randomUUID()}`,
            role: "assistant",
            source: "assistant",
            providerKey: this.platformKey,
            content: message,
            timestamp: Date.now(),
            meta: {
              kind: "runtime_error",
              subtype: "delivery_exception"
            }
          }
        ]);
      }
    }
  }
}
