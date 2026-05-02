import { MODEL_PROVIDERS, normalizeModelProvider } from "./modelProviderDefinitions.js";
import { buildAnthropicMessagesRequest } from "./requestTemplates/anthropicMessages.js";
import { buildDashScopeCompletionRequest } from "./requestTemplates/dashscopeCompletion.js";
import { buildDeepSeekCompletionRequest } from "./requestTemplates/deepseekCompletion.js";
import { buildOpenAICompletionRequest } from "./requestTemplates/openaiCompletion.js";
import { buildOpenAIResponsesRequest } from "./requestTemplates/openaiResponses.js";

export function buildModelProviderRequest(runtimeConfig = {}, params = {}) {
  const provider = normalizeModelProvider(runtimeConfig.provider);

  if (provider === MODEL_PROVIDERS.DASHSCOPE_COMPLETION) {
    return buildDashScopeCompletionRequest(runtimeConfig, params);
  }

  if (provider === MODEL_PROVIDERS.DEEPSEEK_COMPLETION) {
    return buildDeepSeekCompletionRequest(runtimeConfig, params);
  }

  if (provider === MODEL_PROVIDERS.ANTHROPIC_MESSAGES) {
    return buildAnthropicMessagesRequest(runtimeConfig, params);
  }

  if (provider === MODEL_PROVIDERS.OPENAI_RESPONSES) {
    return buildOpenAIResponsesRequest(runtimeConfig, params);
  }

  return buildOpenAICompletionRequest(runtimeConfig, params);
}
