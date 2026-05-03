import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function normalizeReplyTarget(value = {}, providerKey = "") {
  const source = normalizeObject(value);
  const messageId = normalizeText(source.messageId ?? source.message_id);
  const chatId = normalizeText(source.chatId ?? source.chat_id);
  const userId = normalizeText(source.userId ?? source.user_id);
  const normalizedProviderKey = normalizeText(source.providerKey ?? providerKey).toLowerCase();

  if (!messageId && !chatId && !userId) {
    return null;
  }

  return {
    providerKey: normalizedProviderKey,
    messageId,
    chatId,
    userId
  };
}

function normalizeParsedFile(file = {}, index = 0) {
  const source = normalizeObject(file);
  const name = normalizeText(source.name) || `file_${index + 1}`;
  const extractedText = String(source.extractedText ?? "").trim();
  const note = String(source.note ?? "").trim();
  const displayText = extractedText || note;
  if (!displayText) {
    return null;
  }

  return {
    name,
    text: displayText,
    parseStatus: normalizeText(source.parseStatus) || "parsed"
  };
}

function normalizeAttachment(attachment = {}, index = 0) {
  const source = normalizeObject(attachment);
  const name = normalizeText(source.name) || `image_${index + 1}`;
  const mimeType = normalizeText(source.mimeType);
  if (!mimeType.startsWith("image/")) {
    return null;
  }

  return {
    name,
    mimeType
  };
}

function normalizeInboundMessage(message = {}, options = {}) {
  const source = normalizeObject(message);
  const providerKey = normalizeText(options.providerKey).toLowerCase() || "remote";
  const providerLabel = normalizeText(options.providerLabel) || providerKey;
  const originMessageId = normalizeText(source.originMessageId ?? source.messageId ?? source.id);
  const content = normalizeText(source.content ?? source.text);
  const parsedFiles = (Array.isArray(source.parsedFiles) ? source.parsedFiles : [])
    .map((item, index) => normalizeParsedFile(item, index))
    .filter(Boolean);
  const attachments = (Array.isArray(source.attachments) ? source.attachments : [])
    .map((item, index) => normalizeAttachment(item, index))
    .filter(Boolean);
  const timestamp = Number(source.timestamp ?? Date.now());
  const replyTarget = normalizeReplyTarget(source.replyTarget, providerKey);

  if (!originMessageId && !content && parsedFiles.length === 0 && attachments.length === 0) {
    return null;
  }
  if (!content && parsedFiles.length === 0 && attachments.length === 0) {
    return null;
  }

  return {
    id: originMessageId || `${providerKey}_inbound_${randomUUID()}`,
    providerKey,
    providerLabel,
    content,
    parsedFiles,
    attachments,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    messageType: normalizeText(source.messageType).toLowerCase(),
    sessionKey: normalizeText(source.sessionKey),
    replyTarget
  };
}

function buildUserMessageContent(inbound) {
  const sections = ["[远程消息]"];
  const content = normalizeText(inbound?.content);
  if (content) {
    sections.push(content);
  }

  const parsedFiles = Array.isArray(inbound?.parsedFiles) ? inbound.parsedFiles : [];
  for (const file of parsedFiles) {
    sections.push(`【远程文件:${file.name}】\n${file.text}`);
  }

  const attachments = Array.isArray(inbound?.attachments) ? inbound.attachments : [];
  for (const attachment of attachments) {
    sections.push(`【远程图片:${attachment.name}】${attachment.mimeType ? ` ${attachment.mimeType}` : ""}`);
  }

  return sections.join("\n\n").trim();
}

function createUserMessage(inbound) {
  return {
    id: `user_${Date.now()}_${randomUUID().slice(0, 8)}`,
    role: "user",
    content: buildUserMessageContent(inbound),
    timestamp: Number(inbound?.timestamp ?? Date.now())
  };
}

function parseRemoteSlashCommand(inbound) {
  const content = normalizeText(inbound?.content);
  const hasExtraPayload =
    (Array.isArray(inbound?.parsedFiles) && inbound.parsedFiles.length > 0) ||
    (Array.isArray(inbound?.attachments) && inbound.attachments.length > 0);
  if (hasExtraPayload || !content.startsWith("/")) {
    return {
      handled: false,
      action: "none"
    };
  }

  if (/^\/compact\s*$/i.test(content)) {
    return {
      handled: true,
      action: "compact"
    };
  }

  const goalMatch = content.match(/^\/goal\s*[:：]\s*([\s\S]+)$/i);
  if (goalMatch) {
    const goal = normalizeText(goalMatch[1]);
    return {
      handled: Boolean(goal),
      action: goal ? "goal" : "none",
      goal
    };
  }

  return {
    handled: false,
    action: "none"
  };
}

function collectAssistantContent(payload = {}) {
  const type = normalizeText(payload.type);
  if (type !== "assistant_message_end") {
    return "";
  }

  return normalizeText(payload.content);
}

function normalizeFileDeliveryTarget(value = {}, providerKey = "") {
  return normalizeReplyTarget(value, providerKey);
}

function resolveWorkingDirectory(executionContext = {}) {
  const candidate = normalizeText(
    executionContext.workingDirectory ?? executionContext.workplacePath
  );
  return candidate ? path.resolve(candidate) : process.cwd();
}

export class RemoteControlRuntimeService {
  constructor(options = {}) {
    this.platformKey = normalizeText(options.platformKey).toLowerCase() || "remote";
    this.platformLabel = normalizeText(options.platformLabel) || this.platformKey;
    this.controlConfigStore = options.controlConfigStore ?? null;
    this.historyStore = options.historyStore ?? null;
    this.runtimeService = options.runtimeService ?? null;
    this.wakeDispatcher = options.wakeDispatcher ?? null;
    this.conversationRunCoordinator = options.conversationRunCoordinator ?? null;
    this.orchestratorSupervisorService = options.orchestratorSupervisorService ?? null;
    this.replyClient = options.replyClient ?? null;
    this.edgeTextToSpeechService = options.edgeTextToSpeechService ?? null;
    this.defaultWorkplacePath = normalizeText(options.defaultWorkplacePath) || process.cwd();
    this.queueFlushDelayMs = Number(options.queueFlushDelayMs ?? 1200);
    this.queue = [];
    this.seenInboundMessageIds = new Set();
    this.queueTimer = null;
    this.flushPromise = null;
    this.isRunning = false;
    this.activeConversationId = "";
    this.lastRunError = "";
    this.lastRunAt = 0;
    this.pendingDeliveryPromise = Promise.resolve();
  }

  getStatus() {
    return {
      running: this.isRunning,
      queuedCount: this.queue.length,
      activeConversationId: this.activeConversationId,
      lastRunError: this.lastRunError,
      lastRunAt: this.lastRunAt
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
    const acceptedIds = [];

    for (const item of list) {
      const normalized = normalizeInboundMessage(item, {
        providerKey: this.platformKey,
        providerLabel: this.platformLabel
      });
      if (!normalized) {
        continue;
      }

      const dedupeKey = `${normalized.providerKey}:${normalized.id}`;
      if (this.seenInboundMessageIds.has(dedupeKey)) {
        continue;
      }

      this.seenInboundMessageIds.add(dedupeKey);
      if (this.seenInboundMessageIds.size > 2000) {
        const overflow = Array.from(this.seenInboundMessageIds).slice(0, 600);
        for (const id of overflow) {
          this.seenInboundMessageIds.delete(id);
        }
      }

      this.queue.push(normalized);
      acceptedIds.push(normalized.id);
    }

    if (this.queue.length > 0) {
      this.scheduleFlush(this.isRunning ? 0 : this.queueFlushDelayMs);
    }

    return {
      acceptedCount: acceptedIds.length,
      acceptedIds,
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
    while (this.queue.length > 0) {
      if (this.isRunning) {
        return;
      }

      const inbound = this.queue.shift();
      if (!inbound) {
        return;
      }

      try {
        await this.runInboundMessage(inbound);
      } catch (error) {
        if (String(error?.code ?? "") === "REMOTE_CONVERSATION_BUSY") {
          this.queue.unshift(inbound);
          this.scheduleFlush(2000);
          return;
        }

        this.lastRunError = String(error?.message ?? `${this.platformLabel} remote run failed`);
        this.lastRunAt = Date.now();
      }
    }
  }

  async resolveTargetConversation() {
    const config = this.controlConfigStore ? await this.controlConfigStore.read() : {};
    const conversationId = normalizeText(config.targetConversationId);
    if (!conversationId) {
      throw new Error("remote target conversation is not configured");
    }

    const conversation = this.historyStore?.getConversation?.(conversationId) ?? null;
    if (!conversation) {
      throw new Error("remote target conversation not found");
    }

    return conversation;
  }

  async runInboundMessage(inbound) {
    if (!this.historyStore || !this.runtimeService) {
      throw new Error("remote chat runtime is unavailable");
    }

    const conversation = await this.resolveTargetConversation();
    const conversationId = normalizeText(conversation.id);
    const slashCommand = parseRemoteSlashCommand(inbound);
    if (slashCommand.handled) {
      await this.handleSlashCommand({
        conversation,
        conversationId,
        inbound,
        slashCommand
      });
      return;
    }

    const userMessage = createUserMessage(inbound);
    let foregroundRun = null;
    let detachConversationBroadcast = () => {};
    let foregroundStatus = "idle";
    let assistantReplyCount = 0;
    let runResult = null;

    this.orchestratorSupervisorService?.ensureSession?.(conversationId);
    const resolvedRuntime = await this.runtimeService.resolveConversationRuntime(conversationId);
    foregroundRun = this.wakeDispatcher?.beginForegroundRun?.({
      sessionId: resolvedRuntime?.sessionId,
      agentId: resolvedRuntime?.agentId,
      conversationId
    }) ?? null;

    if (foregroundRun?.busy) {
      const error = new Error("conversation agent is already running");
      error.code = "REMOTE_CONVERSATION_BUSY";
      throw error;
    }

    this.isRunning = true;
    this.activeConversationId = conversationId;
    this.lastRunError = "";

    try {
      detachConversationBroadcast =
        this.conversationRunCoordinator?.attachConversationBroadcast?.(foregroundRun, {
          listenerId: `remote_broadcast_${this.platformKey}_${Date.now()}`
        }) ?? (() => {});

      this.historyStore.appendMessages(conversationId, [userMessage], {
        updatedAt: Date.now()
      });
      this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
        type: "conversation_messages_appended",
        messages: [userMessage]
      });
      this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
        type: "session_start",
        mode: "background",
        source: "remote",
        providerKey: this.platformKey
      });

      const remoteContext = {
        isRemote: true,
        providerKey: this.platformKey,
        providerLabel: this.platformLabel,
        sourceMessageId: normalizeText(inbound.id),
        replyTarget: inbound.replyTarget,
        channel: this
      };

      runResult = await this.runtimeService.runConversationById({
        conversationId,
        runId: foregroundRun?.runId,
        currentAtomicStepId: foregroundRun?.stepId,
        abortSignal: foregroundRun?.signal ?? null,
        remoteContext,
        onEvent: async (payload) => {
          this.conversationRunCoordinator?.emitEvent?.(foregroundRun, payload);
          const replyText = collectAssistantContent(payload);
          if (!replyText) {
            return;
          }

          assistantReplyCount += 1;
          await this.deliverReplyToChannel({
            replyTarget: inbound.replyTarget,
            text: replyText
          });
        }
      });

      if (String(runResult?.status ?? "").trim() === "pending_approval") {
        foregroundStatus = "waiting_approval";
        this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
          type: "session_pause",
          mode: "background",
          source: "remote",
          providerKey: this.platformKey,
          pendingApprovalId: runResult?.approvalId,
          toolCallId: runResult?.toolCallId,
          toolName: runResult?.toolName,
          history: runResult?.history ?? null
        });
      } else {
        foregroundStatus = "idle";
        this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
          type: "session_end",
          mode: "background",
          source: "remote",
          providerKey: this.platformKey,
          history: runResult?.history ?? null
        });
      }

      if (assistantReplyCount <= 0 && normalizeText(runResult?.outputText)) {
        await this.deliverReplyToChannel({
          replyTarget: inbound.replyTarget,
          text: normalizeText(runResult.outputText)
        });
      }

      if (runResult?.subagentCompletionRequest) {
        await this.orchestratorSupervisorService?.dispatchCompletionToPrimary?.(
          runResult.subagentCompletionRequest
        );
      }
    } catch (error) {
      foregroundStatus = "error";
      this.lastRunError = String(error?.message ?? `${this.platformLabel} remote run failed`);
      this.conversationRunCoordinator?.emitEvent?.(foregroundRun, {
        type: "error",
        mode: "background",
        source: "remote",
        providerKey: this.platformKey,
        message: this.lastRunError
      });
      throw error;
    } finally {
      detachConversationBroadcast?.();
      if (foregroundRun) {
        await this.wakeDispatcher?.finishForegroundRun?.({
          sessionId: foregroundRun.sessionId,
          agentId: foregroundRun.agentId,
          status: foregroundStatus,
          runResult
        });
      }
      this.lastRunAt = Date.now();
      this.isRunning = false;
      this.activeConversationId = "";
      if (this.queue.length > 0) {
        this.scheduleFlush(0);
      }
    }
  }

  async handleSlashCommand({ conversation, conversationId, inbound, slashCommand }) {
    const action = normalizeText(slashCommand?.action).toLowerCase();

    if (action === "goal") {
      const goal = normalizeText(slashCommand?.goal);
      if (!goal) {
        return;
      }
      this.historyStore.updateConversationGoal(conversationId, goal);
      this.conversationRunCoordinator?.emitEvent?.(null, {
        type: "conversation_updated",
        conversationId,
        source: "remote",
        providerKey: this.platformKey
      });
      await this.deliverReplyToChannel({
        replyTarget: inbound.replyTarget,
        text: `已设置目标：${goal}`
      });
      return;
    }

    if (action === "compact") {
      if (typeof this.runtimeService?.compactConversationById !== "function") {
        throw new Error("remote compact command is unavailable");
      }

      const compressionResult = await this.runtimeService.compactConversationById(conversationId, {
        onEvent: (payload) => {
          this.conversationRunCoordinator?.emitEvent?.(null, {
            ...payload,
            conversationId,
            source: "remote",
            providerKey: this.platformKey
          });
        }
      });
      const compressed = Boolean(compressionResult?.compression?.compressed);
      const reason = normalizeText(compressionResult?.compression?.reason);
      await this.deliverReplyToChannel({
        replyTarget: inbound.replyTarget,
        text: compressed
          ? "已完成当前会话压缩。"
          : `未执行压缩${reason ? `：${reason}` : "。"}`
      });
      return;
    }

    const userMessage = createUserMessage(inbound);
    this.historyStore.appendMessages(conversationId, [userMessage], {
      updatedAt: Date.now()
    });
  }

  async deliverReplyToChannel({ replyTarget, text }) {
    const target = normalizeReplyTarget(replyTarget, this.platformKey);
    const content = normalizeText(text);
    if (!target || !content || !this.replyClient) {
      return;
    }

    this.pendingDeliveryPromise = this.pendingDeliveryPromise
      .then(async () => {
        if (typeof this.replyClient.replyTextInChunks === "function" && target.messageId) {
          await this.replyClient.replyTextInChunks({
            messageId: target.messageId,
            text: content
          });
          return;
        }

        if (typeof this.replyClient.sendMessage === "function") {
          await this.replyClient.sendMessage({
            target,
            text: content
          });
        }
      })
      .catch((error) => {
        this.lastRunError = `${this.platformLabel} 回发失败: ${String(error?.message ?? "unknown error")}`;
      });

    return this.pendingDeliveryPromise;
  }

  async synthesizeAudioFromText(audio = {}) {
    const audioText = normalizeText(audio?.text);
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
      voice: normalizeText(audio?.voice),
      rate: normalizeText(audio?.rate),
      volume: normalizeText(audio?.volume),
      pitch: normalizeText(audio?.pitch)
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

  async sendMessageToChannel({ target, file, audio, text = "" } = {}) {
    const normalizedTarget = normalizeFileDeliveryTarget(target, this.platformKey);
    if (!normalizedTarget) {
      throw new Error("发送消息失败：当前远程来源缺少 reply target");
    }

    const normalizedText = normalizeText(text);
    const normalizedFile =
      file && typeof file === "object" && !Array.isArray(file)
        ? {
            filePath: normalizeText(file.filePath),
            fileName: normalizeText(file.fileName),
            mimeType: normalizeText(file.mimeType)
          }
        : null;
    const normalizedAudio =
      audio && typeof audio === "object" && !Array.isArray(audio)
        ? {
            text: normalizeText(audio.text),
            filePath: normalizeText(audio.filePath),
            fileName: normalizeText(audio.fileName),
            mimeType: normalizeText(audio.mimeType),
            voice: normalizeText(audio.voice),
            rate: normalizeText(audio.rate),
            volume: normalizeText(audio.volume),
            pitch: normalizeText(audio.pitch),
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

    return this.replyClient.sendMessage({
      target: normalizedTarget,
      file: hasFile ? normalizedFile : null,
      audio: preparedAudio,
      text: normalizedText
    });
  }

  async sendFileToChannel({ target, file, caption = "" } = {}) {
    return this.sendMessageToChannel({
      target,
      file,
      text: normalizeText(caption)
    });
  }

  resolveWorkingDirectory(executionContext = {}) {
    const cwd = resolveWorkingDirectory(executionContext);
    try {
      return fs.existsSync(cwd) ? cwd : this.defaultWorkplacePath;
    } catch {
      return this.defaultWorkplacePath;
    }
  }
}
