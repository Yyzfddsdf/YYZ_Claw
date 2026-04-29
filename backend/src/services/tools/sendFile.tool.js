import path from "node:path";

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

function isRemoteRuntime(executionContext = {}) {
  return Boolean(resolveRemoteContext(executionContext));
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
    "Send a local file and/or short text back to the current remote IM source. The destination is fixed by the inbound remote message and cannot be provided by the model.",
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
      text: {
        type: "string",
        description: "Optional text message. Can be sent alone or together with file."
      }
    },
    required: [],
    additionalProperties: false
  },
  isAvailable: isRemoteRuntime,
  async execute(args = {}, executionContext = {}) {
    const remoteContext = resolveRemoteContext(executionContext);
    if (!remoteContext || typeof remoteContext.channel?.sendMessageToChannel !== "function") {
      throw new Error("send_file is only available during a remote-origin run");
    }

    const normalizedText = String(args.text ?? "").trim();
    const hasFilePath = String(args.filePath ?? "").trim().length > 0;
    if (!hasFilePath && !normalizedText) {
      throw new Error("filePath or text is required");
    }

    const cwd = resolveWorkingDirectory(executionContext);
    const resolvedFilePath = hasFilePath ? resolveFilePath(args.filePath, cwd) : "";
    const result = await remoteContext.channel.sendMessageToChannel({
      target: remoteContext.replyTarget,
      file: hasFilePath
        ? {
            filePath: resolvedFilePath,
            fileName: String(args.fileName ?? "").trim(),
            mimeType: String(args.mimeType ?? "").trim()
          }
        : null,
      text: normalizedText,
      runId: String(executionContext?.runId ?? "").trim()
    });

    return {
      status: "ok",
      message: hasFilePath
        ? normalizedText
          ? "文字与文件已发送到远程来源"
          : "文件已发送到远程来源"
        : "文字消息已发送到远程来源",
      providerKey: String(remoteContext.providerKey ?? "").trim(),
      ...(hasFilePath ? { filePath: resolvedFilePath } : {}),
      ...(normalizedText ? { text: normalizedText } : {}),
      providerResult: result && typeof result === "object" ? result : {}
    };
  }
};
