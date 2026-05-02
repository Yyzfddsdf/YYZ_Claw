import {
  createBaseModelRequest,
  resolveProviderThinkingEnabled
} from "./shared.js";

export function buildDashScopeCompletionRequest(runtimeConfig = {}, params = {}) {
  const request = createBaseModelRequest(runtimeConfig, params);

  request.enable_thinking = resolveProviderThinkingEnabled(runtimeConfig);

  return request;
}
