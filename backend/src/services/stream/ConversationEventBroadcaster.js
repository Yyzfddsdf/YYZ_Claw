import { endSse, writeSseEvent } from "./SseChannel.js";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

export class ConversationEventBroadcaster {
  constructor(options = {}) {
    this.heartbeatIntervalMs = Number.isInteger(options.heartbeatIntervalMs)
      ? options.heartbeatIntervalMs
      : 15000;
    this.subscribers = new Map();
    this.sequence = 0;
  }

  subscribe(res) {
    const subscriberId = `subscriber_${Date.now()}_${this.sequence += 1}`;
    const heartbeatId = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": keep-alive\n\n");
      }
    }, this.heartbeatIntervalMs);

    this.subscribers.set(subscriberId, {
      id: subscriberId,
      res,
      heartbeatId
    });

    return () => {
      const subscriber = this.subscribers.get(subscriberId);
      if (!subscriber) {
        return;
      }

      clearInterval(subscriber.heartbeatId);
      this.subscribers.delete(subscriberId);
      endSse(res);
    };
  }

  publishAgentEvent(conversationId, payload = {}) {
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) {
      return 0;
    }

    const data =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? {
            conversationId: normalizedConversationId,
            ...cloneValue(payload)
          }
        : {
            conversationId: normalizedConversationId,
            type: "message",
            value: payload
          };

    let delivered = 0;
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber?.res || subscriber.res.writableEnded) {
        continue;
      }

      writeSseEvent(subscriber.res, "agent", data);
      delivered += 1;
    }

    return delivered;
  }

  publishMessagesAppended(conversationId, messages = []) {
    const normalizedMessages = Array.isArray(messages)
      ? messages.filter((item) => item && typeof item === "object")
      : [];

    if (normalizedMessages.length === 0) {
      return 0;
    }

    return this.publishAgentEvent(conversationId, {
      type: "conversation_messages_appended",
      messages: normalizedMessages
    });
  }
}
