function safeJsonParse(raw, fallback = null) {
  if (typeof raw !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeToolName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "unknown_tool";
}

function normalizeToolCallId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    return rawArguments;
  }

  return safeJsonParse(typeof rawArguments === "string" ? rawArguments : "", {});
}

function normalizeResultText(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value ?? "", null, 2);
}

function extractCommandFromArgs(argsObject) {
  if (!argsObject || typeof argsObject !== "object") {
    return "";
  }

  const command = typeof argsObject.command === "string" ? argsObject.command.trim() : "";
  return command;
}

function normalizeApprovalStatus(value) {
  const text = typeof value === "string" ? value.trim() : "";

  if (text === "pending_approval" || text === "approved" || text === "rejected") {
    return text;
  }

  return "running";
}

function normalizeHookLevel(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "info" || text === "warning") {
    return text;
  }
  return "hint";
}

function normalizeHooks(hooks) {
  if (!Array.isArray(hooks)) {
    return [];
  }

  return hooks
    .map((hook, index) => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
        return null;
      }

      const message = typeof hook.message === "string" ? hook.message.trim() : "";
      if (!message) {
        return null;
      }

      const metadata =
        hook.metadata && typeof hook.metadata === "object" && !Array.isArray(hook.metadata)
          ? hook.metadata
          : undefined;

      return {
        id:
          (typeof hook.id === "string" && hook.id.trim()) ||
          `hook_${index + 1}`,
        type:
          (typeof hook.type === "string" && hook.type.trim()) ||
          "generic_hint",
        level: normalizeHookLevel(hook.level),
        message,
        ...(metadata ? { metadata } : {})
      };
    })
    .filter(Boolean);
}

export function createToolMessagePayloadFromCall(event) {
  const argumentsObject = normalizeArguments(event?.arguments);

  return {
    format: "tool_event",
    version: 2,
    toolCallId: normalizeToolCallId(event?.toolCallId),
    toolName: normalizeToolName(event?.toolName),
    command: extractCommandFromArgs(argumentsObject),
    arguments: argumentsObject,
    result: "",
    isError: false,
    approvalStatus: "running",
    pendingApprovalId: "",
    hooks: normalizeHooks(event?.hooks)
  };
}

export function applyToolPendingApprovalToPayload(payload, event) {
  return {
    ...payload,
    approvalStatus: "pending_approval",
    pendingApprovalId: normalizeToolCallId(event?.approvalId),
    result: ""
  };
}

export function createToolMessagePayloadFromResult(event) {
  return {
    format: "tool_event",
    version: 2,
    toolCallId: normalizeToolCallId(event?.toolCallId),
    toolName: normalizeToolName(event?.toolName),
    command: "",
    arguments: {},
    result: normalizeResultText(event?.content),
    isError: Boolean(event?.isError),
    approvalStatus: "approved",
    pendingApprovalId: "",
    hooks: normalizeHooks(event?.hooks)
  };
}

export function applyToolResultToPayload(payload, event) {
  const nextHooks = normalizeHooks(event?.hooks);
  return {
    ...payload,
    result: normalizeResultText(event?.content),
    isError: Boolean(event?.isError),
    approvalStatus: "approved",
    hooks: nextHooks.length > 0 ? nextHooks : normalizeHooks(payload?.hooks)
  };
}

export function parseToolMessagePayload(content) {
  const parsed = safeJsonParse(content, null);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  if (parsed.format !== "tool_event") {
    return null;
  }

  return {
    format: "tool_event",
    version: Number(parsed.version ?? 1),
    toolCallId: normalizeToolCallId(parsed.toolCallId),
    toolName: normalizeToolName(parsed.toolName),
    command: typeof parsed.command === "string" ? parsed.command : "",
    arguments:
      parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
        ? parsed.arguments
        : {},
    result: typeof parsed.result === "string" ? parsed.result : "",
    isError: Boolean(parsed.isError),
    approvalStatus: normalizeApprovalStatus(parsed.approvalStatus),
    pendingApprovalId: typeof parsed.pendingApprovalId === "string" ? parsed.pendingApprovalId : "",
    hooks: normalizeHooks(parsed.hooks)
  };
}

export function serializeToolMessagePayload(payload) {
  return JSON.stringify(payload);
}
