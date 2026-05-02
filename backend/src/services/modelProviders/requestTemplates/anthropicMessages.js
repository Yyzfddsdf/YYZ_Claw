import {
  createBaseModelRequest,
  resolveProviderThinkingEnabled
} from "./shared.js";

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
const VALID_ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeMaxTokens(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0
    ? Math.trunc(number)
    : DEFAULT_ANTHROPIC_MAX_TOKENS;
}

function parseDataUrl(value) {
  const text = normalizeText(value);
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(text);
  if (!match) {
    return null;
  }

  return {
    mediaType: match[1].toLowerCase(),
    data: match[2]
  };
}

function convertImageUrlPart(part) {
  const url = normalizeText(part?.image_url?.url ?? part?.url);
  if (!url) {
    return null;
  }

  const dataUrl = parseDataUrl(url);
  if (dataUrl) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUrl.mediaType,
        data: dataUrl.data
      }
    };
  }

  if (/^https?:\/\//i.test(url)) {
    return {
      type: "image",
      source: {
        type: "url",
        url
      }
    };
  }

  return null;
}

function convertTextPart(part) {
  const text = typeof part === "string" ? part : part?.text;
  return {
    type: "text",
    text: String(text ?? "")
  };
}

function convertOpenAIContentToAnthropic(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content ?? "");
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string" || part?.type === "text") {
      parts.push(convertTextPart(part));
      continue;
    }

    if (part?.type === "image_url") {
      const imagePart = convertImageUrlPart(part);
      if (imagePart) {
        parts.push(imagePart);
      }
    }
  }

  return parts.length > 0 ? parts : "";
}

function stringifyToolInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  const text = normalizeText(value);
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function convertAssistantToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      const id = normalizeText(toolCall?.id);
      const name = normalizeText(toolCall?.function?.name);
      if (!id || !name) {
        return null;
      }

      return {
        type: "tool_use",
        id,
        name,
        input: stringifyToolInput(toolCall?.function?.arguments)
      };
    })
    .filter(Boolean);
}

function convertToolResultMessage(message) {
  const toolUseId = normalizeText(message?.tool_call_id ?? message?.toolCallId);
  if (!toolUseId) {
    return null;
  }

  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: String(message?.content ?? "")
      }
    ]
  };
}

function appendOrMergeUserMessage(messages, content) {
  const previous = messages[messages.length - 1];
  const contentParts = Array.isArray(content)
    ? content
    : [{ type: "text", text: String(content ?? "") }];

  if (!previous || previous.role !== "user") {
    messages.push({ role: "user", content });
    return;
  }

  previous.content = [
    ...(Array.isArray(previous.content)
      ? previous.content
      : [{ type: "text", text: String(previous.content ?? "") }]),
    ...contentParts
  ];
}

function convertMessages(messages = []) {
  const anthropicMessages = [];
  const systemParts = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = normalizeText(message?.role) || "user";

    if (role === "system") {
      const content = convertOpenAIContentToAnthropic(message?.content);
      systemParts.push(typeof content === "string" ? content : JSON.stringify(content));
      continue;
    }

    if (role === "tool") {
      const toolResult = convertToolResultMessage(message);
      if (toolResult) {
        appendOrMergeUserMessage(anthropicMessages, toolResult.content);
      }
      continue;
    }

    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = convertOpenAIContentToAnthropic(message?.content);
    if (role === "assistant") {
      const contentParts = [];
      if (typeof content === "string" && content) {
        contentParts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        contentParts.push(...content);
      }
      contentParts.push(...convertAssistantToolCalls(message?.tool_calls));

      anthropicMessages.push({
        role: "assistant",
        content: contentParts.length > 0 ? contentParts : ""
      });
      continue;
    }

    appendOrMergeUserMessage(anthropicMessages, content);
  }

  return {
    system: systemParts.filter(Boolean).join("\n\n"),
    messages: anthropicMessages
  };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const converted = tools
    .map((tool) => {
      const source = tool?.type === "function" ? tool.function : tool;
      const name = normalizeText(source?.name);
      if (!name) {
        return null;
      }

      return {
        name,
        description: String(source?.description ?? ""),
        input_schema: source?.parameters && typeof source.parameters === "object"
          ? source.parameters
          : { type: "object", properties: {} }
      };
    })
    .filter(Boolean);

  return converted.length > 0 ? converted : undefined;
}

export function buildAnthropicMessagesRequest(runtimeConfig = {}, params = {}) {
  const request = createBaseModelRequest(runtimeConfig, params);
  const converted = convertMessages(request.messages);
  const tools = convertTools(request.tools);
  const enableThinking = resolveProviderThinkingEnabled(runtimeConfig);
  const reasoningEffort = normalizeText(runtimeConfig.reasoningEffort);

  const anthropicRequest = {
    model: request.model,
    messages: converted.messages,
    max_tokens: normalizeMaxTokens(request.max_tokens),
    stream: Boolean(request.stream)
  };

  if (converted.system) {
    anthropicRequest.system = converted.system;
  }

  if (Number.isFinite(Number(request.temperature))) {
    anthropicRequest.temperature = Number(request.temperature);
  }

  if (Number.isFinite(Number(request.top_p))) {
    anthropicRequest.top_p = Number(request.top_p);
  }

  if (Array.isArray(request.stop)) {
    anthropicRequest.stop_sequences = request.stop;
  } else if (typeof request.stop === "string" && request.stop) {
    anthropicRequest.stop_sequences = [request.stop];
  }

  if (tools) {
    anthropicRequest.tools = tools;
  }

  if (enableThinking) {
    anthropicRequest.thinking = {
      type: "adaptive",
      display: "summarized"
    };
    if (VALID_ANTHROPIC_EFFORTS.has(reasoningEffort)) {
      anthropicRequest.output_config = { effort: reasoningEffort };
    }
  }

  return anthropicRequest;
}
