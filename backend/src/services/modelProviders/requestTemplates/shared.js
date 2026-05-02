import { createModelProviderCapabilities } from "../modelProviderDefinitions.js";

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

  if (params.maxTokens !== undefined && request.max_tokens === undefined) {
    request.max_tokens = params.maxTokens;
  }

  delete request.maxTokens;

  return request;
}
