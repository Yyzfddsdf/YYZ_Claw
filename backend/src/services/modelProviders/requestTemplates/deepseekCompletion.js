import {
  createBaseModelRequest,
  resolveProviderThinkingEnabled
} from "./shared.js";

const DEEPSEEK_REASONING_EFFORTS = new Set(["high", "max"]);

export function buildDeepSeekCompletionRequest(runtimeConfig = {}, params = {}) {
  const request = createBaseModelRequest(runtimeConfig, params);
  const enableThinking = resolveProviderThinkingEnabled(runtimeConfig);
  const reasoningEffort = String(runtimeConfig.reasoningEffort ?? "").trim();

  request.thinking = {
    type: enableThinking ? "enabled" : "disabled"
  };

  if (enableThinking && DEEPSEEK_REASONING_EFFORTS.has(reasoningEffort)) {
    request.reasoning_effort = reasoningEffort;
  }

  return request;
}
