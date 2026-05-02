import { getCompletionProviderDefinition } from "../providers/completionProviders.js";

export function resolveThinkingEnabled(runtimeConfig = {}) {
  const provider = getCompletionProviderDefinition(runtimeConfig.provider);
  return Boolean(runtimeConfig.enableDeepThinking) && (
    provider.supportsReasoningEffort ||
    provider.supportsThinkingSwitch ||
    provider.supportsReasoningContent
  );
}

export function applyThinkingOptions(request, runtimeConfig = {}) {
  const provider = getCompletionProviderDefinition(runtimeConfig.provider);
  const enableThinking = resolveThinkingEnabled(runtimeConfig);

  if (provider.supportsThinkingSwitch) {
    request.enable_thinking = enableThinking;
  }

  if (
    provider.supportsReasoningEffort &&
    enableThinking &&
    runtimeConfig.reasoningEffort &&
    runtimeConfig.reasoningEffort !== "default"
  ) {
    request.reasoning_effort = runtimeConfig.reasoningEffort;
  }

  return request;
}
