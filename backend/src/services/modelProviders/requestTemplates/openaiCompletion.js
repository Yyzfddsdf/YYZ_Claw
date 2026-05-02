import {
  createBaseModelRequest,
  resolveProviderThinkingEnabled
} from "./shared.js";

export function buildOpenAICompletionRequest(runtimeConfig = {}, params = {}) {
  const request = createBaseModelRequest(runtimeConfig, params);
  const enableThinking = resolveProviderThinkingEnabled(runtimeConfig);
  const reasoningEffort = String(runtimeConfig.reasoningEffort ?? "").trim();

  if (enableThinking && reasoningEffort && reasoningEffort !== "default") {
    request.reasoning_effort = reasoningEffort;
  }

  return request;
}
