import {
  applyToolPendingApprovalToPayload,
  applyToolResultToPayload,
  createToolMessagePayloadFromCall,
  createToolMessagePayloadFromResult,
  parseToolMessagePayload,
  serializeToolMessagePayload
} from "./toolEventCodec.js";

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

function normalizeMessage(message = {}) {
  return {
    id: String(message?.id ?? createId("message")),
    role: String(message?.role ?? "assistant"),
    content: String(message?.content ?? ""),
    reasoningContent: String(message?.reasoningContent ?? ""),
    timestamp: Number(message?.timestamp ?? Date.now()),
    toolCallId: String(message?.toolCallId ?? "").trim(),
    toolName: String(message?.toolName ?? "").trim(),
    toolCalls: normalizeToolCalls(message?.toolCalls),
    meta:
      message?.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
        ? { ...message.meta }
        : {},
    tokenUsage: message?.tokenUsage ?? null
  };
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

      const payload = parseToolMessagePayload(item.content);
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

      const payload = parseToolMessagePayload(item.content);
      if (payload && payload.toolName === toolName && !payload.result) {
        return index;
      }
    }
  }

  return -1;
}

export class AgentConversationRecorder {
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
          timestamp: Date.now(),
          content: messageContent,
          reasoningContent,
          toolCalls
        })
      );
      return;
    }

    if (event?.type === "tool_call") {
      const toolPayload = createToolMessagePayloadFromCall(event);
      this.messages.push(
        normalizeMessage({
          id: createId("tool-call"),
          role: "tool",
          timestamp: Date.now(),
          content: serializeToolMessagePayload(toolPayload),
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
        const currentPayload = parseToolMessagePayload(targetMessage.content);

        if (currentPayload) {
          const mergedPayload = applyToolPendingApprovalToPayload(currentPayload, event);
          this.messages[targetIndex] = normalizeMessage({
            ...targetMessage,
            content: serializeToolMessagePayload(mergedPayload),
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
        const currentPayload = parseToolMessagePayload(targetMessage.content);

        if (currentPayload) {
          const mergedPayload = applyToolResultToPayload(currentPayload, event);
          this.messages[targetIndex] = normalizeMessage({
            ...targetMessage,
            content: serializeToolMessagePayload(mergedPayload),
            meta: {
              kind: "tool_event",
              ...mergedPayload
            }
          });
          return;
        }
      }

      const fallbackPayload = createToolMessagePayloadFromResult(event);
      this.messages.push(
        normalizeMessage({
          id: createId("tool-result"),
          role: "tool",
          timestamp: Date.now(),
          content: serializeToolMessagePayload(fallbackPayload),
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
