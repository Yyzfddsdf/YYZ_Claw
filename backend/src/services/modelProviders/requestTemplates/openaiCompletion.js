import {
  createBaseModelRequest,
  resolveProviderThinkingEnabled
} from "./shared.js";

function stripReasoningContent(messages = []) {
  return Array.isArray(messages)
    ? messages.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          return message;
        }

        const nextMessage = { ...message };
        if (Object.prototype.hasOwnProperty.call(nextMessage, "reasoning_content")) {
          delete nextMessage.reasoning_content;
        }
        if (Object.prototype.hasOwnProperty.call(nextMessage, "reasoningContent")) {
          delete nextMessage.reasoningContent;
        }
        return nextMessage;
      })
    : [];
}

export function buildOpenAICompletionRequest(runtimeConfig = {}, params = {}) {
  const request = createBaseModelRequest(runtimeConfig, params);
  const enableThinking = resolveProviderThinkingEnabled(runtimeConfig);
  const reasoningEffort = String(runtimeConfig.reasoningEffort ?? "").trim();
  request.messages = stripReasoningContent(request.messages);

  if (enableThinking && reasoningEffort && reasoningEffort !== "default") {
    request.reasoning_effort = reasoningEffort;
  }

  return request;
}
