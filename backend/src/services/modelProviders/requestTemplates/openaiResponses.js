import {
  createBaseModelRequest,
  resolveProviderThinkingEnabled
} from "./shared.js";

const RESPONSE_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

function normalizeString(value) {
  return String(value ?? "");
}

function stringifyToolOutput(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? "");
  } catch {
    return normalizeString(value);
  }
}

function convertInputContentPart(part = {}, role = "user") {
  if (typeof part === "string") {
    return {
      type: role === "assistant" ? "output_text" : "input_text",
      text: part
    };
  }

  if (part?.type === "text") {
    return {
      type: role === "assistant" ? "output_text" : "input_text",
      text: normalizeString(part.text)
    };
  }

  if (part?.type === "image_url") {
    const imageUrl =
      typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (!imageUrl) {
      return null;
    }

    return {
      type: "input_image",
      image_url: imageUrl,
      detail: part.image_url?.detail ?? "auto"
    };
  }

  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text: normalizeString(part?.text ?? part?.content ?? "")
  };
}

function convertMessageContent(content, role = "user") {
  if (Array.isArray(content)) {
    return content
      .map((part) => convertInputContentPart(part, role))
      .filter(Boolean);
  }

  return normalizeString(content);
}

function createAssistantMessageInput(message = {}) {
  const content = convertMessageContent(message.content ?? "", "assistant");
  const textContent = Array.isArray(content)
    ? content.map((part) => part?.text ?? "").join("")
    : content;

  if (!textContent) {
    return null;
  }

  return {
    role: "assistant",
    content: textContent
  };
}

function convertToolCall(toolCall = {}) {
  const callId = normalizeString(toolCall.id || toolCall.call_id);
  const functionInfo = toolCall.function ?? {};

  return {
    type: "function_call",
    call_id: callId,
    id: callId || undefined,
    name: normalizeString(functionInfo.name ?? toolCall.name),
    arguments: normalizeString(functionInfo.arguments ?? toolCall.arguments ?? "{}"),
    status: "completed"
  };
}

function convertMessageToResponseInput(message = {}) {
  const role = normalizeString(message.role);

  if (role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: normalizeString(message.tool_call_id ?? message.call_id),
        output: stringifyToolOutput(message.content)
      }
    ];
  }

  if (role === "assistant") {
    const items = [];
    const assistantMessage = createAssistantMessageInput(message);
    if (assistantMessage) {
      items.push(assistantMessage);
    }

    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const converted = convertToolCall(toolCall);
      if (converted.call_id && converted.name) {
        items.push(converted);
      }
    }

    return items;
  }

  if (role === "system" || role === "developer" || role === "user") {
    return [
      {
        role,
        content: convertMessageContent(message.content ?? "", role)
      }
    ];
  }

  return [];
}

function convertMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) =>
    convertMessageToResponseInput(message)
  );
}

function convertTool(tool = {}) {
  const functionInfo = tool.function ?? tool;
  const name = normalizeString(functionInfo.name);

  if (!name) {
    return null;
  }

  return {
    type: "function",
    name,
    description: normalizeString(functionInfo.description),
    parameters: functionInfo.parameters ?? {
      type: "object",
      properties: {}
    },
    strict: functionInfo.strict ?? null
  };
}

function convertTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).map(convertTool).filter(Boolean);
}

export function buildOpenAIResponsesRequest(runtimeConfig = {}, params = {}) {
  const request = createBaseModelRequest(runtimeConfig, params);
  const messages = request.messages;
  const tools = request.tools;
  const maxTokens = request.max_tokens;

  request.input = convertMessages(messages);
  request.tools = convertTools(tools);
  request.parallel_tool_calls = true;

  if (request.tools.length === 0) {
    delete request.tools;
    delete request.parallel_tool_calls;
  }

  if (maxTokens !== undefined) {
    request.max_output_tokens = maxTokens;
  }

  const enableThinking = resolveProviderThinkingEnabled(runtimeConfig);
  const effort = normalizeString(runtimeConfig.reasoningEffort).trim();
  if (enableThinking) {
    request.reasoning = {
      summary: "auto"
    };

    if (RESPONSE_REASONING_EFFORTS.has(effort)) {
      request.reasoning.effort = effort;
    }
  }

  delete request.messages;
  delete request.max_tokens;
  delete request.stream_options;

  return request;
}
