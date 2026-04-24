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

function normalizeRecorderMessageForStorage(message = {}, platformKey = "remote") {
  const role = String(message.role ?? "assistant").trim() || "assistant";
  return {
    id:
      String(message.id ?? `${platformKey}_generated_${randomUUID()}`).trim() ||
      `${platformKey}_generated_${randomUUID()}`,
    role,
    source:
      String(message.source ?? "").trim()
      || (
        role === "assistant"
          ? "assistant"
          : role === "tool"
            ? "tool"
            : role === "user"
              ? "user"
              : "system"
      ),
    providerKey: platformKey,
    content: String(message.content ?? ""),
    reasoningContent: String(message.reasoningContent ?? ""),
    toolCallId: String(message.toolCallId ?? "").trim(),
    toolName: String(message.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message.toolCalls),
    timestamp: Number(message.timestamp ?? Date.now()),
    meta: normalizeMessageMeta(message.meta)
  };
}

function buildStorageMessageSignature(message = {}) {
  return JSON.stringify({
    content: String(message.content ?? ""),
    reasoningContent: String(message.reasoningContent ?? ""),
    toolCallId: String(message.toolCallId ?? "").trim(),
    toolName: String(message.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message.toolCalls),
    meta: normalizeMessageMeta(message.meta),
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

function normalizeFileDeliveryTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const messageId = String(value.messageId ?? value.message_id ?? "").trim();
  const chatId = String(value.chatId ?? value.chat_id ?? "").trim();
  const userId = String(value.userId ?? value.user_id ?? "").trim();
  if (!messageId && !chatId && !userId) {
    return null;
  }

  return {
    messageId,
    chatId,
    userId
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

function collectAssistantReplyTexts(messages = [], fallbackText = "") {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const texts = [];
  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    const item = normalizedMessages[index];
    if (String(item?.role ?? "").trim() !== "assistant") {
      continue;
    }

    const content = String(item?.content ?? "").trim();
    if (!content) {
      continue;
    }

    texts.push(content);
  }

  const ordered = texts.reverse();
  if (ordered.length > 0) {
    return ordered;
  }

  const fallback = String(fallbackText ?? "").trim() || "已处理完成。";
  return [fallback];
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
    this.edgeTextToSpeechService = options.edgeTextToSpeechService ?? null;
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
    this.pendingReplyDeliveryTurnId = 0;
    this.pendingReplyDeliveryPromise = Promise.resolve();

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
    let realtimeReplyCount = 0;

    this.pendingReplyDeliveryTurnId = resolvedTurnId;
    this.pendingReplyDeliveryPromise = Promise.resolve();

    const enqueueRealtimeReply = (text) => {
      const content = String(text ?? "").trim();
      if (!content) {
        return this.pendingReplyDeliveryPromise;
      }

      this.pendingReplyDeliveryPromise = this.pendingReplyDeliveryPromise
        .then(async () => {
          await this.deliverReplyToChannel({
            replyTarget,
            text: content,
            turnId: resolvedTurnId
          });
          realtimeReplyCount += 1;
        })
        .catch(() => {});

      return this.pendingReplyDeliveryPromise;
    };

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
    const storedMessageSignatures = new Map();
    for (const item of turnMessages) {
      const id = String(item?.id ?? "").trim();
      if (!id) {
        continue;
      }
      storedMessageSignatures.set(id, buildStorageMessageSignature(item));
    }
    const recorder = new RemoteConversationRecorder({
      initialMessages: turnMessages
    });
    const syncRecorderToHistory = () => {
      const nextMessages = recorder
        .getMessages()
        .map((message) => normalizeRecorderMessageForStorage(message, this.platformKey));

      for (const message of nextMessages) {
        const id = String(message.id ?? "").trim();
        if (!id) {
          continue;
        }

        const nextSignature = buildStorageMessageSignature(message);
        const previousSignature = storedMessageSignatures.get(id);
        if (!previousSignature) {
          this.historyStore.appendMessages(resolvedTurnId, [message]);
          storedMessageSignatures.set(id, nextSignature);
          continue;
        }

        if (previousSignature !== nextSignature) {
          const updated = this.historyStore.updateMessage(resolvedTurnId, message);
          if (updated) {
            storedMessageSignatures.set(id, nextSignature);
          }
        }
      }

      return nextMessages;
    };

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
          remoteRuntimeService: this,
          remoteReplyTarget: replyTarget,
          remoteTurnId: resolvedTurnId,
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
          if (shouldSyncRecorderOnEvent(event)) {
            syncRecorderToHistory();
          }
          if (String(event?.type ?? "").trim() === "assistant_message_end") {
            enqueueRealtimeReply(String(event?.content ?? ""));
          }
        }
      });

      const nextMessages = syncRecorderToHistory();

      await this.pendingReplyDeliveryPromise;
      if (realtimeReplyCount <= 0) {
        const replyTexts = collectAssistantReplyTexts(
          nextMessages,
          String(result?.outputText ?? "")
        );
        for (const text of replyTexts) {
          await this.deliverReplyToChannel({
            replyTarget,
            text,
            turnId: resolvedTurnId
          });
        }
      }

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
    } finally {
      if (this.pendingReplyDeliveryTurnId === resolvedTurnId) {
        this.pendingReplyDeliveryTurnId = 0;
        this.pendingReplyDeliveryPromise = Promise.resolve();
      }
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

  async synthesizeAudioFromText(audio = {}) {
    const audioConfig =
      audio && typeof audio === "object" && !Array.isArray(audio) ? audio : {};
    const audioText = String(audioConfig.text ?? "").trim();
    if (!audioText) {
      return null;
    }

    if (
      !this.edgeTextToSpeechService ||
      typeof this.edgeTextToSpeechService.streamSynthesize !== "function"
    ) {
      throw new Error("TTS service is unavailable");
    }

    const chunks = [];
    for await (const chunk of this.edgeTextToSpeechService.streamSynthesize({
      text: audioText,
      voice: String(audioConfig.voice ?? "").trim(),
      rate: String(audioConfig.rate ?? "").trim(),
      volume: String(audioConfig.volume ?? "").trim(),
      pitch: String(audioConfig.pitch ?? "").trim()
    })) {
      if (chunk && chunk.length > 0) {
        chunks.push(Buffer.from(chunk));
      }
    }

    const buffer = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    if (buffer.length <= 0) {
      throw new Error("TTS did not return audio data");
    }

    return {
      buffer,
      fileName: `tts_${Date.now()}.mp3`,
      mimeType: "audio/mpeg",
      durationMs: 0
    };
  }

  async sendMessageToChannel({ target, file, audio, text = "", turnId } = {}) {
    const normalizedTarget = normalizeFileDeliveryTarget(target) ?? null;
    const fallbackTarget = normalizeReplyTarget(normalizedTarget ?? {});
    const replyTarget = fallbackTarget ?? normalizeReplyTarget(target);
    const messageId = String(replyTarget?.messageId ?? "").trim();
    const chatId = String(normalizedTarget?.chatId ?? "").trim();
    const userId = String(normalizedTarget?.userId ?? "").trim();

    if (!messageId && !chatId && !userId) {
      throw new Error("发送消息失败：缺少 target（messageId/chatId/userId）");
    }

    const normalizedText = String(text ?? "").trim();
    const normalizedFile =
      file && typeof file === "object" && !Array.isArray(file)
        ? {
            filePath: String(file.filePath ?? "").trim(),
            fileName: String(file.fileName ?? "").trim(),
            mimeType: String(file.mimeType ?? "").trim()
          }
        : null;
    const normalizedAudio =
      audio && typeof audio === "object" && !Array.isArray(audio)
        ? {
            text: String(audio.text ?? "").trim(),
            filePath: String(audio.filePath ?? "").trim(),
            fileName: String(audio.fileName ?? "").trim(),
            mimeType: String(audio.mimeType ?? "").trim(),
            voice: String(audio.voice ?? "").trim(),
            rate: String(audio.rate ?? "").trim(),
            volume: String(audio.volume ?? "").trim(),
            pitch: String(audio.pitch ?? "").trim(),
            durationMs: Math.max(0, Math.trunc(Number(audio.durationMs ?? 0) || 0))
          }
        : null;
    const hasFile = Boolean(normalizedFile?.filePath);
    const hasAudio = Boolean(normalizedAudio?.filePath || normalizedAudio?.text);
    const hasText = Boolean(normalizedText);
    if (!hasFile && !hasAudio && !hasText) {
      throw new Error("发送失败：file.filePath 或 audio 或 text 至少提供一个");
    }

    if (!this.replyClient || typeof this.replyClient.sendMessage !== "function") {
      throw new Error(`${this.platformLabel} 当前未实现 sendMessage 能力`);
    }

    const normalizedTurnId = Number(turnId ?? 0);
    if (
      Number.isInteger(normalizedTurnId) &&
      normalizedTurnId > 0 &&
      this.pendingReplyDeliveryTurnId === normalizedTurnId
    ) {
      await this.pendingReplyDeliveryPromise;
    }

    try {
      const preparedAudio =
        hasAudio && normalizedAudio?.text
          ? await this.synthesizeAudioFromText(normalizedAudio)
          : hasAudio
            ? {
                filePath: normalizedAudio.filePath,
                fileName: normalizedAudio.fileName,
                mimeType: normalizedAudio.mimeType,
                durationMs: normalizedAudio.durationMs
              }
            : null;

      const result = await this.replyClient.sendMessage({
        target: {
          messageId,
          chatId,
          userId
        },
        file: hasFile ? normalizedFile : null,
        audio: preparedAudio,
        text: normalizedText
      });

      return result && typeof result === "object" ? result : {};
    } catch (error) {
      const message = `${this.platformLabel} 消息发送失败: ${String(error?.message ?? "unknown error")}`;
      this.lastRunError = message;

      throw error;
    }
  }

  async sendFileToChannel({ target, file, caption = "", turnId } = {}) {
    return this.sendMessageToChannel({
      target,
      file,
      text: String(caption ?? "").trim(),
      turnId
    });
  }
}
