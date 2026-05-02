import { createOpenAIClient } from "../openai/createOpenAIClient.js";
import {
  MODEL_PROVIDER_PROTOCOLS,
  getModelProviderDefinition
} from "./modelProviderDefinitions.js";
import { buildModelProviderRequest } from "./requestBuilder.js";

function createUnsupportedProviderError(provider) {
  return new Error(`Unsupported model provider protocol: ${provider?.protocol ?? "unknown"}`);
}

async function runOpenAIChatCompletions(runtimeConfig = {}, params = {}, options = {}) {
  const client = createOpenAIClient(runtimeConfig);
  const request = buildModelProviderRequest(runtimeConfig, params);
  const requestOptions = options?.signal ? { signal: options.signal } : undefined;

  return client.chat.completions.create(request, requestOptions);
}

export function createModelProviderRequest(runtimeConfig = {}, params = {}) {
  return buildModelProviderRequest(runtimeConfig, params);
}

export async function runModelProviderCompletion(runtimeConfig = {}, params = {}, options = {}) {
  const provider = getModelProviderDefinition(runtimeConfig.provider);

  if (provider.protocol === MODEL_PROVIDER_PROTOCOLS.OPENAI_CHAT_COMPLETIONS) {
    return runOpenAIChatCompletions(runtimeConfig, params, options);
  }

  throw createUnsupportedProviderError(provider);
}

export async function runModelProviderStream(runtimeConfig = {}, params = {}, options = {}) {
  return runModelProviderCompletion(runtimeConfig, { ...params, stream: true }, options);
}
