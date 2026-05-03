function resolveRemoteContext(executionContext = {}) {
  const remoteContext =
    executionContext?.remoteContext &&
    typeof executionContext.remoteContext === "object" &&
    !Array.isArray(executionContext.remoteContext)
      ? executionContext.remoteContext
      : null;

  if (!remoteContext?.replyTarget || !remoteContext?.channel) {
    return null;
  }

  return remoteContext;
}

export default {
  name: "send_message",
  description:
    "Send an extra text or synthesized audio message back to the current remote IM source. The destination is fixed by the inbound remote message and cannot be provided by the model.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text message content to send to the current remote source."
      },
      audio: {
        type: "string",
        description: "Text to synthesize as audio and send to the current remote source."
      }
    },
    required: [],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const remoteContext = resolveRemoteContext(executionContext);
    if (!remoteContext || typeof remoteContext.channel?.sendMessageToChannel !== "function") {
      throw new Error("send_message is only available during a remote-origin run");
    }

    const text = String(args.text ?? "").trim();
    const audioText = String(args.audio ?? "").trim();
    if (!text && !audioText) {
      throw new Error("text or audio is required");
    }
    if (text && audioText) {
      throw new Error("send_message only supports one of text or audio at a time");
    }

    const result = await remoteContext.channel.sendMessageToChannel({
      target: remoteContext.replyTarget,
      text,
      audio: audioText
        ? {
            text: audioText
          }
        : null,
      runId: String(executionContext?.runId ?? "").trim()
    });

    return {
      status: "ok",
      mode: audioText ? "audio" : "text",
      message: audioText ? "音频消息已发送到远程来源" : "文字消息已发送到远程来源",
      providerKey: String(remoteContext.providerKey ?? "").trim(),
      providerResult: result && typeof result === "object" ? result : {}
    };
  }
};
