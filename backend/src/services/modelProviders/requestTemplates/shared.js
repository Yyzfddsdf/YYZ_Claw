import { createModelProviderCapabilities } from "../modelProviderDefinitions.js";

function normalizeToolCallId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolCallName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolCallArguments(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

function sanitizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
        return null;
      }

      const id = normalizeToolCallId(toolCall.id);
      const name = normalizeToolCallName(toolCall?.function?.name);
      if (!id || !name) {
        return null;
      }

      return {
        ...toolCall,
        id,
        type: toolCall.type ?? "function",
        function: {
          ...toolCall.function,
          name,
          arguments: normalizeToolCallArguments(toolCall?.function?.arguments)
        }
      };
    })
    .filter(Boolean);
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const role = typeof message.role === "string" ? message.role.trim() : "";
  if (!role) {
    return null;
  }

  const nextMessage = { ...message, role };

  if (role === "assistant") {
    const sanitizedToolCalls = sanitizeToolCalls(message.tool_calls);
    if (sanitizedToolCalls.length > 0) {
      nextMessage.tool_calls = sanitizedToolCalls;
    } else if (Object.prototype.hasOwnProperty.call(nextMessage, "tool_calls")) {
      delete nextMessage.tool_calls;
    }
  }

  if (role === "tool") {
    const toolCallId = normalizeToolCallId(message.tool_call_id ?? message.toolCallId);
    if (!toolCallId) {
      return null;
    }
    nextMessage.tool_call_id = toolCallId;
    if (Object.prototype.hasOwnProperty.call(nextMessage, "toolCallId")) {
      delete nextMessage.toolCallId;
    }
  }

  return nextMessage;
}

function normalizeSystemContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part.trim();
        }

        if (part?.type === "text") {
          return String(part.text ?? "").trim();
        }

        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return String(content ?? "").trim();
}

function mergeSystemMessages(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const systemContents = [];
  const nonSystemMessages = [];

  for (const message of normalizedMessages) {
    if (message?.role === "system") {
      const normalizedContent = normalizeSystemContent(message.content);
      if (normalizedContent) {
        systemContents.push(normalizedContent);
      }
      continue;
    }

    nonSystemMessages.push(message);
  }

  if (systemContents.length === 0) {
    return nonSystemMessages;
  }

  return [
    {
      role: "system",
      content: systemContents.join("\n\n")
    },
    ...nonSystemMessages
  ];
}

export function repairConversationMessages(messages = []) {
  const output = [];
  const pendingToolOwners = new Map();

  for (const rawMessage of Array.isArray(messages) ? messages : []) {
    const message = sanitizeMessage(rawMessage);
    if (!message) {
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      output.push(message);
      for (const toolCall of message.tool_calls) {
        pendingToolOwners.set(toolCall.id, message);
      }
      continue;
    }

    if (message.role === "tool") {
      const owner = pendingToolOwners.get(message.tool_call_id);
      if (!owner) {
        continue;
      }

      const ownerIndex = output.indexOf(owner);
      if (ownerIndex === -1) {
        pendingToolOwners.delete(message.tool_call_id);
        continue;
      }

      let insertAt = ownerIndex + 1;
      while (insertAt < output.length && output[insertAt]?.role === "tool") {
        insertAt += 1;
      }

      output.splice(insertAt, 0, message);
      pendingToolOwners.delete(message.tool_call_id);
      continue;
    }

    output.push(message);
  }

  // Final validation: ensure every assistant message with tool_calls is
  // immediately followed by tool result messages covering all tool_call IDs.
  // Injects stub results for any missing ones to prevent 400 errors.
  for (let i = 0; i < output.length; i += 1) {
    const msg = output[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }

    const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));

    let j = i + 1;
    while (j < output.length && output[j]?.role === "tool") {
      expectedIds.delete(output[j].tool_call_id);
      j += 1;
    }

    if (expectedIds.size > 0) {
      for (const missingId of expectedIds) {
        output.splice(j, 0, {
          role: "tool",
          tool_call_id: missingId,
          content: "[Tool result unavailable]"
        });
        j += 1;
      }
    }
  }

  return mergeSystemMessages(output);
}


export function resolveProviderThinkingEnabled(runtimeConfig = {}) {
  const capabilities =
    runtimeConfig?.providerCapabilities && typeof runtimeConfig.providerCapabilities === "object"
      ? runtimeConfig.providerCapabilities
      : createModelProviderCapabilities(runtimeConfig.provider);
  const providerSupportsThinking =
    capabilities.supportsReasoningEffort ||
    capabilities.supportsThinkingSwitch ||
    capabilities.supportsReasoningContent;

  return Boolean(runtimeConfig.enableDeepThinking) && providerSupportsThinking;
}

export function createBaseModelRequest(runtimeConfig = {}, params = {}) {
  const request = {
    ...params,
    model: runtimeConfig.model
  };

  if (Object.prototype.hasOwnProperty.call(request, "messages")) {
    request.messages = repairConversationMessages(request.messages);
  }

  if (params.maxTokens !== undefined && request.max_tokens === undefined) {
    request.max_tokens = params.maxTokens;
  }

  if (request.max_tokens === undefined) {
    const configuredMaxOutputTokens = Number(runtimeConfig?.maxOutputTokens ?? 0);
    if (Number.isFinite(configuredMaxOutputTokens) && configuredMaxOutputTokens > 0) {
      request.max_tokens = Math.trunc(configuredMaxOutputTokens);
    }
  }

  delete request.maxTokens;

  return request;
}
