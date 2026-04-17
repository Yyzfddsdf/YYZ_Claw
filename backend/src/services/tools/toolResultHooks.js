function createHookId() {
  return `hook_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeHookLevel(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "warning" || normalized === "info") {
    return normalized;
  }
  return "hint";
}

function normalizeHookMessage(value) {
  return String(value ?? "").trim();
}

function normalizeToolImageAttachments(attachments) {
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
        id: String(attachment.id ?? `tool_image_${index + 1}`).trim() || `tool_image_${index + 1}`,
        type: "image",
        name: String(attachment.name ?? "").trim(),
        mimeType,
        dataUrl,
        size: Number(attachment.size ?? 0)
      };
    })
    .filter(Boolean);
}

export function normalizeToolResultHooks(hooks) {
  if (!Array.isArray(hooks)) {
    return [];
  }

  return hooks
    .map((hook, index) => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
        return null;
      }

      const message = normalizeHookMessage(hook.message);
      if (!message) {
        return null;
      }

      const metadata =
        hook.metadata && typeof hook.metadata === "object" && !Array.isArray(hook.metadata)
          ? hook.metadata
          : undefined;

      return {
        id: String(hook.id ?? createHookId()).trim() || `${createHookId()}_${index + 1}`,
        type: String(hook.type ?? "generic_hint").trim() || "generic_hint",
        level: normalizeHookLevel(hook.level),
        message,
        ...(metadata ? { metadata } : {})
      };
    })
    .filter(Boolean);
}

export function createToolResultHook({
  type = "generic_hint",
  level = "hint",
  message = "",
  metadata
} = {}) {
  const normalizedHooks = normalizeToolResultHooks([
    {
      type,
      level,
      message,
      metadata
    }
  ]);

  return normalizedHooks[0] ?? null;
}

export function withToolResultHooks(result, hooks = []) {
  return {
    __toolResultEnvelope: true,
    result,
    hooks: normalizeToolResultHooks(hooks)
  };
}

export function isToolResultEnvelope(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.__toolResultEnvelope === true &&
    Object.prototype.hasOwnProperty.call(value, "result")
  );
}

export function stringifyToolResult(result) {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export function formatToolResultHooksForModel(hooks) {
  const normalizedHooks = normalizeToolResultHooks(hooks);
  if (normalizedHooks.length === 0) {
    return "";
  }

  const lines = ["[TOOL_RESULT_HOOKS]"];
  for (const hook of normalizedHooks) {
    lines.push(`- [${hook.level}] ${hook.message}`);
  }

  return lines.join("\n");
}

export function appendToolResultHooksToContent(content, hooks) {
  const normalizedContent = stringifyToolResult(content);
  const hookText = formatToolResultHooksForModel(hooks);

  if (!hookText) {
    return normalizedContent;
  }

  if (!normalizedContent) {
    return hookText;
  }

  return `${normalizedContent}\n\n${hookText}`;
}

export function normalizeExecutedToolResponse({
  toolName,
  rawResult,
  isError = false
} = {}) {
  const envelope = isToolResultEnvelope(rawResult)
    ? rawResult
    : {
        result: rawResult,
        hooks: []
      };

  const hooks = normalizeToolResultHooks(envelope.hooks);
  const content = stringifyToolResult(envelope.result);
  const imageAttachments = normalizeToolImageAttachments(envelope.imageAttachments);
  const resultPayload =
    envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result)
      ? envelope.result
      : null;

  return {
    name: String(toolName ?? "").trim(),
    content,
    modelContent: appendToolResultHooksToContent(content, hooks),
    hooks,
    imageAttachments,
    resultPayload,
    isError: Boolean(isError)
  };
}
