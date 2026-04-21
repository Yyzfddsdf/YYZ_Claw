function normalizeResult(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export class RemoteWebhookIngestService {
  constructor(options = {}) {
    this.runtimeService = options.runtimeService ?? null;
    this.normalizePayload = options.normalizePayload ?? null;
  }

  async handleCallback(payload = {}) {
    if (!this.normalizePayload || typeof this.normalizePayload !== "function") {
      throw new Error("normalizePayload is required");
    }

    const normalized = normalizeResult(await this.normalizePayload(payload));
    const kind = String(normalized.kind ?? "").trim().toLowerCase();
    if (kind === "challenge") {
      return {
        kind: "challenge",
        challenge: String(normalized.challenge ?? "").trim()
      };
    }

    if (kind === "ignored") {
      return {
        kind: "ignored",
        reason: String(normalized.reason ?? "ignored").trim() || "ignored",
        eventType: String(normalized.eventType ?? "").trim()
      };
    }

    const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
    if (messages.length === 0) {
      return {
        kind: "ignored",
        reason: "empty_messages"
      };
    }

    if (!this.runtimeService || typeof this.runtimeService.enqueueUserMessages !== "function") {
      throw new Error("runtimeService is unavailable");
    }

    const queueResult = await this.runtimeService.enqueueUserMessages(messages);
    return {
      kind: "accepted",
      eventId: String(normalized.eventId ?? "").trim(),
      messageIds: messages
        .map((item) => String(item?.messageId ?? item?.originMessageId ?? item?.id ?? "").trim())
        .filter(Boolean),
      queueResult
    };
  }
}
