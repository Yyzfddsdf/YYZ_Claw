import {
  applyRemoteToolPendingApprovalToPayload,
  applyRemoteToolResultToPayload,
  createRemoteToolMessagePayloadFromCall,
  createRemoteToolMessagePayloadFromResult,
  parseRemoteToolMessagePayload,
  serializeRemoteToolMessagePayload
} from "./remoteToolEventCodec.js";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

function normalizeImageAttachments(attachments) {
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
        id: String(attachment.id ?? `image_${index + 1}`).trim() || `image_${index + 1}`,
        type: "image",
        name: String(attachment.name ?? "").trim(),
        mimeType,
        dataUrl,
        size: Number(attachment.size ?? 0)
      };
    })
    .filter(Boolean);
}

function normalizeMessageMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }
  return { ...meta };
}

function normalizeMessage(message = {}) {
  const normalized = {
    id: String(message?.id ?? createId("remote_message")),
    role: String(message?.role ?? "assistant"),
    source: String(message?.source ?? "").trim(),
    content: String(message?.content ?? ""),
    reasoningContent: String(message?.reasoningContent ?? ""),
    timestamp: Number(message?.timestamp ?? Date.now()),
    toolCallId: String(message?.toolCallId ?? "").trim(),
    toolName: String(message?.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message?.toolCalls),
    meta: normalizeMessageMeta(message?.meta),
    tokenUsage: message?.tokenUsage ?? null
  };

  if (!normalized.source) {
    normalized.source =
      normalized.role === "assistant"
        ? "assistant"
        : normalized.role === "tool"
          ? "tool"
          : normalized.role === "user"
            ? "user"
            : "system";
  }

  return normalized;
}

function findToolMessageIndex(messages, event) {
  const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId.trim() : "";
  const toolName = typeof event?.toolName === "string" ? event.toolName.trim() : "";

  if (toolCallId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (item.role !== "tool") {
        continue;
      }

      const payload = parseRemoteToolMessagePayload(item.content);
      if (payload && payload.toolCallId === toolCallId) {
        return index;
      }
    }
  }

  if (toolName) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = messages[index];
      if (item.role !== "tool") {
        continue;
      }

      const payload = parseRemoteToolMessagePayload(item.content);
      if (payload && payload.toolName === toolName && !payload.result) {
        return index;
      }
    }
  }

  return -1;
}

export class RemoteConversationRecorder {
  constructor(options = {}) {
    this.messages = Array.isArray(options.initialMessages)
      ? options.initialMessages.map((item) => normalizeMessage(item))
      : [];
    this.activeAssistantMessageId = "";
  }

  applyEvent(event = {}) {
    if (event?.type === "assistant_token") {
      if (!this.activeAssistantMessageId) {
        this.activeAssistantMessageId = createId("assistant");
        this.messages.push(
          normalizeMessage({
            id: this.activeAssistantMessageId,
            role: "assistant",
            source: "assistant",
            timestamp: Date.now(),
            content: event.token ?? "",
            reasoningContent: ""
          })
        );
        return;
      }

      this.messages = this.messages.map((item) =>
        item.id === this.activeAssistantMessageId
          ? {
              ...item,
              content: item.content + String(event.token ?? "")
            }
          : item
      );
      return;
    }

    if (event?.type === "assistant_reasoning_token") {
      if (!this.activeAssistantMessageId) {
        this.activeAssistantMessageId = createId("assistant");
        this.messages.push(
          normalizeMessage({
            id: this.activeAssistantMessageId,
            role: "assistant",
            source: "assistant",
            timestamp: Date.now(),
            content: "",
            reasoningContent: event.token ?? ""
          })
        );
        return;
      }

      this.messages = this.messages.map((item) =>
        item.id === this.activeAssistantMessageId
          ? {
              ...item,
              reasoningContent: String(item.reasoningContent ?? "") + String(event.token ?? "")
            }
          : item
      );
      return;
    }

    if (event?.type === "assistant_message_end") {
      const toolCalls = normalizeToolCalls(event?.toolCalls);
      const messageContent = typeof event?.content === "string" ? event.content : "";
      const reasoningContent =
        typeof event?.reasoningContent === "string" ? event.reasoningContent : "";

      if (this.activeAssistantMessageId) {
        this.messages = this.messages.map((item) =>
          item.id === this.activeAssistantMessageId
            ? {
                ...item,
                content: messageContent || item.content,
                reasoningContent: reasoningContent || item.reasoningContent || "",
                toolCalls
              }
            : item
        );
        return;
      }

      this.activeAssistantMessageId = createId("assistant");
      this.messages.push(
        normalizeMessage({
          id: this.activeAssistantMessageId,
          role: "assistant",
          source: "assistant",
          timestamp: Date.now(),
          content: messageContent,
          reasoningContent,
          toolCalls
        })
      );
      return;
    }

    if (event?.type === "tool_call") {
      const toolPayload = createRemoteToolMessagePayloadFromCall(event);
      this.messages.push(
        normalizeMessage({
          id: createId("tool-call"),
          role: "tool",
          source: "tool",
          timestamp: Date.now(),
          content: serializeRemoteToolMessagePayload(toolPayload),
          toolCallId: String(toolPayload.toolCallId ?? "").trim(),
          toolName: String(toolPayload.toolName ?? "").trim(),
          meta: {
            kind: "tool_event",
            ...toolPayload
          }
        })
      );
      this.activeAssistantMessageId = "";
      return;
    }

    if (event?.type === "tool_pending_approval") {
      const targetIndex = findToolMessageIndex(this.messages, event);
      if (targetIndex >= 0) {
        const targetMessage = this.messages[targetIndex];
        const currentPayload = parseRemoteToolMessagePayload(targetMessage.content);

        if (currentPayload) {
          const mergedPayload = applyRemoteToolPendingApprovalToPayload(currentPayload, event);
          this.messages[targetIndex] = normalizeMessage({
            ...targetMessage,
            content: serializeRemoteToolMessagePayload(mergedPayload),
            meta: {
              kind: "tool_event",
              ...mergedPayload
            }
          });
        }
      }
      return;
    }

    if (event?.type === "tool_result") {
      const targetIndex = findToolMessageIndex(this.messages, event);
      if (targetIndex >= 0) {
        const targetMessage = this.messages[targetIndex];
        const currentPayload = parseRemoteToolMessagePayload(targetMessage.content);

        if (currentPayload) {
          const mergedPayload = applyRemoteToolResultToPayload(currentPayload, event);
          this.messages[targetIndex] = normalizeMessage({
            ...targetMessage,
            content: serializeRemoteToolMessagePayload(mergedPayload),
            meta: {
              kind: "tool_event",
              ...mergedPayload
            }
          });
          return;
        }
      }

      const fallbackPayload = createRemoteToolMessagePayloadFromResult(event);
      this.messages.push(
        normalizeMessage({
          id: createId("tool-result"),
          role: "tool",
          source: "tool",
          timestamp: Date.now(),
          content: serializeRemoteToolMessagePayload(fallbackPayload),
          toolCallId: String(fallbackPayload.toolCallId ?? "").trim(),
          toolName: String(fallbackPayload.toolName ?? "").trim(),
          meta: {
            kind: "tool_event",
            ...fallbackPayload
          }
        })
      );
      return;
    }

    if (event?.type === "tool_image_input") {
      const imageAttachments = normalizeImageAttachments(event?.imageAttachments);
      if (imageAttachments.length === 0) {
        return;
      }

      this.messages.push(
        normalizeMessage({
          id: createId("tool-image-input"),
          role: "user",
          source: "user",
          timestamp: Date.now(),
          content:
            String(event?.content ?? "").trim()
            || "Tool returned image attachments for follow-up reasoning.",
          meta: {
            kind: "tool_image_input",
            toolCallId: String(event?.toolCallId ?? "").trim(),
            toolName: String(event?.toolName ?? "").trim(),
            attachments: imageAttachments
          }
        })
      );
      this.activeAssistantMessageId = "";
      return;
    }

    if (event?.type === "runtime_hook_injected") {
      const content = String(event?.content ?? "").trim();
      if (!content) {
        return;
      }

      this.messages.push(
        normalizeMessage({
          id: createId("runtime-hook"),
          role: "user",
          source: "user",
          timestamp: Date.now(),
          content,
          meta: {
            kind: "runtime_hook_injected",
            hookType: String(event?.hookType ?? "").trim() || "runtime_hooks",
            level: String(event?.level ?? "").trim() || "info",
            source: String(event?.source ?? "").trim() || "hook",
            blockId: String(event?.blockId ?? "").trim(),
            metadata:
              event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
                ? event.metadata
                : {}
          }
        })
      );
      return;
    }

    if (event?.type === "usage") {
      const normalizedUsage = event?.usage && typeof event.usage === "object" ? { ...event.usage } : null;
      if (!normalizedUsage || !this.activeAssistantMessageId) {
        return;
      }

      this.messages = this.messages.map((item) =>
        item.id === this.activeAssistantMessageId
          ? {
              ...item,
              tokenUsage: normalizedUsage
            }
          : item
      );
    }
  }

  getMessages() {
    return this.messages.map((item) => normalizeMessage(item));
  }
}
