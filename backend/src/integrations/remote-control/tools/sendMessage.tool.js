function normalizeTarget(value = null, fallbackValue = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallback =
    fallbackValue && typeof fallbackValue === "object" && !Array.isArray(fallbackValue)
      ? fallbackValue
      : {};
  const messageId = String(source.messageId ?? source.message_id ?? "").trim();
  const chatId = String(source.chatId ?? source.chat_id ?? "").trim();
  const userId = String(source.userId ?? source.user_id ?? "").trim();
  const fallbackMessageId = String(fallback.messageId ?? fallback.message_id ?? "").trim();
  const fallbackChatId = String(fallback.chatId ?? fallback.chat_id ?? "").trim();
  const fallbackUserId = String(fallback.userId ?? fallback.user_id ?? "").trim();
  const finalMessageId = messageId || fallbackMessageId;
  const finalChatId = chatId || fallbackChatId;
  const finalUserId = userId || fallbackUserId;
  if (!finalMessageId && !finalChatId && !finalUserId) {
    return null;
  }
  return { messageId: finalMessageId, chatId: finalChatId, userId: finalUserId };
}

export default {
  name: "send_message",
  description:
    "Send text or synthesized audio message to current remote channel provider. Text goes through native text channel (Feishu interactive), audio is generated from text via TTS then sent as audio message.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text message content."
      },
      audio: {
        type: "string",
        description: "Text to synthesize as audio and send as audio message."
      },
      target: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          chatId: { type: "string" },
          userId: { type: "string" }
        },
        additionalProperties: false
      }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const runtimeService = executionContext?.remoteRuntimeService ?? null;
    if (!runtimeService || typeof runtimeService.sendMessageToChannel !== "function") {
      throw new Error("remote runtime does not support send_message");
    }

    const target = normalizeTarget(args.target, executionContext?.remoteReplyTarget);
    if (!target) {
      throw new Error("target is required (messageId/chatId/userId), and no reply target found");
    }

    const text = String(args.text ?? "").trim();
    const audioText = String(args.audio ?? "").trim();
    if (!text && !audioText) {
      throw new Error("text or audio is required");
    }
    if (text && audioText) {
      throw new Error("send_message only supports one of text or audio at a time");
    }

    const result = await runtimeService.sendMessageToChannel({
      target,
      text,
      audio: audioText
        ? {
            text: audioText
          }
        : null,
      turnId: Number(executionContext?.remoteTurnId ?? 0)
    });

    return {
      status: "ok",
      mode: audioText ? "audio" : "text",
      message: audioText ? "音频消息已发送到远程通道" : "文字消息已发送到远程通道",
      target,
      providerResult: result && typeof result === "object" ? result : {}
    };
  }
};
