const DEFAULT_RECENT_TURN_WINDOW = 10;
const MAX_TOOL_EVENT_CONTENT_CHARS = 1800;

function clipText(text, maxChars) {
  const source = String(text ?? "");
  if (source.length <= maxChars) {
    return source;
  }

  const headChars = Math.max(400, Math.floor(maxChars * 0.8));
  const tailChars = Math.max(80, Math.floor(maxChars * 0.15));
  return `${source.slice(0, headChars)}\n...[truncated]...\n${source.slice(-tailChars)}`;
}

function normalizeMessage(message, fallbackId = "") {
  const meta =
    message?.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
      ? message.meta
      : {};

  return {
    id: String(message?.id ?? fallbackId ?? "").trim(),
    role: String(message?.role ?? "").trim() || "user",
    content: String(message?.content ?? ""),
    timestamp: Number(message?.timestamp ?? Date.now()),
    toolCallId: String(message?.toolCallId ?? "").trim(),
    toolName: String(message?.toolName ?? "").trim(),
    meta
  };
}

function normalizeToolEvent(event, index = 0) {
  const metadata =
    event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      ? event.metadata
      : {};

  return {
    id: String(event?.id ?? `tool_event_${index + 1}`).trim() || `tool_event_${index + 1}`,
    phase: String(event?.phase ?? "").trim().toLowerCase() === "call" ? "call" : "result",
    toolCallId: String(event?.toolCallId ?? "").trim(),
    toolName: String(event?.toolName ?? "").trim(),
    isError: Boolean(event?.isError),
    argumentsText: clipText(String(event?.argumentsText ?? ""), 1200),
    content: clipText(String(event?.content ?? ""), MAX_TOOL_EVENT_CONTENT_CHARS),
    timestamp: Number(event?.timestamp ?? Date.now()),
    metadata
  };
}

function groupMessagesIntoTurns(messages = []) {
  const turns = [];
  let currentTurn = null;

  for (const message of messages) {
    if (message.role === "user") {
      currentTurn = {
        id: message.id || `turn_${turns.length + 1}`,
        userMessage: message,
        messages: [message]
      };
      turns.push(currentTurn);
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        id: message.id || `turn_${turns.length + 1}`,
        userMessage: null,
        messages: []
      };
      turns.push(currentTurn);
    }

    currentTurn.messages.push(message);
  }

  return turns.map((turn, index) => ({
    id: turn.id || `turn_${index + 1}`,
    userMessage: turn.userMessage,
    messages: turn.messages,
    userText: String(turn.userMessage?.content ?? "").trim()
  }));
}

export class RuntimeScopeBuilder {
  constructor(options = {}) {
    this.compressionService = options.compressionService ?? null;
    this.recentTurnWindow = Number.isInteger(options.recentTurnWindow)
      ? options.recentTurnWindow
      : DEFAULT_RECENT_TURN_WINDOW;
  }

  build({ conversation = [], rawConversationMessages = [], executionContext = {} } = {}) {
    const systemMessages = Array.isArray(conversation)
      ? conversation
          .filter((message) => String(message?.role ?? "").trim() === "system")
          .map((message, index) => normalizeMessage(message, `system_${index}`))
      : [];

    const runtimeScope =
      this.compressionService &&
      typeof this.compressionService.buildRuntimeScope === "function"
        ? this.compressionService.buildRuntimeScope({
            systemMessages,
            messages: rawConversationMessages
          })
        : {
            systemMessages,
            scopedMessages: rawConversationMessages.map((message, index) =>
              normalizeMessage(message, `scope_${index}`)
            ),
            latestSummary: null
          };

    const turnRuntime =
      executionContext.turnRuntime && typeof executionContext.turnRuntime === "object"
        ? executionContext.turnRuntime
        : {};

    const recentToolEvents = Array.isArray(turnRuntime.runtimeToolEvents)
      ? turnRuntime.runtimeToolEvents.map((event, index) => normalizeToolEvent(event, index))
      : [];

    const scopedMessages = Array.isArray(runtimeScope?.scopedMessages)
      ? runtimeScope.scopedMessages.map((message, index) => normalizeMessage(message, `scope_${index}`))
      : [];
    const turns = groupMessagesIntoTurns(scopedMessages);
    const recentTurns = turns.slice(-this.recentTurnWindow);
    const currentTurn = turns[turns.length - 1] ?? null;

    return {
      systemMessages: Array.isArray(runtimeScope?.systemMessages)
        ? runtimeScope.systemMessages.map((message, index) =>
            normalizeMessage(message, `runtime_system_${index}`)
          )
        : systemMessages,
      scopedMessages,
      latestSummary: runtimeScope?.latestSummary ?? null,
      turns,
      recentTurns,
      currentTurn,
      currentUserMessage: currentTurn?.userMessage ?? null,
      currentUserText: String(currentTurn?.userText ?? "").trim(),
      recentToolEvents,
      longTermMemoryRecall: turnRuntime.longTermMemoryRecall ?? null,
      approvalMode: String(executionContext?.approvalMode ?? "").trim(),
      executionContext
    };
  }
}
