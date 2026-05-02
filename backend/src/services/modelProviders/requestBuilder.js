import { MODEL_PROVIDERS, normalizeModelProvider } from "./modelProviderDefinitions.js";
import { buildDashScopeCompletionRequest } from "./requestTemplates/dashscopeCompletion.js";
import { buildOpenAICompletionRequest } from "./requestTemplates/openaiCompletion.js";

export function buildModelProviderRequest(runtimeConfig = {}, params = {}) {
  const provider = normalizeModelProvider(runtimeConfig.provider);

  if (provider === MODEL_PROVIDERS.DASHSCOPE_COMPLETION) {
    return buildDashScopeCompletionRequest(runtimeConfig, params);
  }

  return buildOpenAICompletionRequest(runtimeConfig, params);
}
