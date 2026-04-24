import path from "node:path";

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

function resolveWorkingDirectory(executionContext = {}) {
  const candidate = String(
    executionContext.workingDirectory ?? executionContext.workplacePath ?? ""
  ).trim();
  return candidate ? path.resolve(candidate) : process.cwd();
}

function resolveFilePath(filePath, cwd) {
  const normalized = String(filePath ?? "").trim();
  if (!normalized) {
    throw new Error("filePath is required");
  }

  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(cwd, normalized);
}

export default {
  name: "send_file",
  description:
    "Send text and/or a local file to the currently enabled remote channel provider via a platform-agnostic interface.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Local file path, absolute or relative to current workspace."
      },
      fileName: {
        type: "string",
        description: "Optional display filename override."
      },
      mimeType: {
        type: "string",
        description: "Optional MIME type override."
      },
      caption: {
        type: "string",
        description: "Optional short text. Deprecated alias of text."
      },
      text: {
        type: "string",
        description: "Optional text message. Can be sent alone or together with file."
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
    if (!runtimeService || typeof runtimeService.sendFileToChannel !== "function") {
      throw new Error("remote runtime does not support send_file");
    }

    const cwd = resolveWorkingDirectory(executionContext);
    const target = normalizeTarget(args.target, executionContext?.remoteReplyTarget);
    if (!target) {
      throw new Error("target is required (messageId/chatId/userId), and no reply target found");
    }
    const normalizedText = String(args.text ?? args.caption ?? "").trim();
    const hasFilePath = String(args.filePath ?? "").trim().length > 0;
    const resolvedFilePath = hasFilePath ? resolveFilePath(args.filePath, cwd) : "";

    if (!hasFilePath && !normalizedText) {
      throw new Error("filePath or text is required");
    }

    const result = await runtimeService.sendMessageToChannel({
      target,
      file: hasFilePath
        ? {
            filePath: resolvedFilePath,
            fileName: String(args.fileName ?? "").trim(),
            mimeType: String(args.mimeType ?? "").trim()
          }
        : null,
      text: normalizedText,
      turnId: Number(executionContext?.remoteTurnId ?? 0)
    });

    return {
      status: "ok",
      message: hasFilePath
        ? normalizedText
          ? "文字与文件已发送到远程通道"
          : "文件已发送到远程通道"
        : "文字消息已发送到远程通道",
      target,
      ...(hasFilePath ? { filePath: resolvedFilePath } : {}),
      ...(normalizedText ? { text: normalizedText } : {}),
      providerResult: result && typeof result === "object" ? result : {}
    };
  }
};
