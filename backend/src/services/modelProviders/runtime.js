import Anthropic from "@anthropic-ai/sdk";

import { createOpenAIClient } from "../openai/createOpenAIClient.js";
import {
  MODEL_PROVIDER_PROTOCOLS,
  getModelProviderDefinition
} from "./modelProviderDefinitions.js";
import {
  convertAnthropicMessageToCompletion,
  convertAnthropicStreamToOpenAIChunks
} from "./anthropicAdapter.js";
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

function createAnthropicClient(runtimeConfig = {}) {
  return new Anthropic({
    apiKey: runtimeConfig.apiKey,
    baseURL: runtimeConfig.baseURL
  });
}

async function runAnthropicMessages(runtimeConfig = {}, params = {}, options = {}) {
  const client = createAnthropicClient(runtimeConfig);
  const request = buildModelProviderRequest(runtimeConfig, params);
  const requestOptions = options?.signal ? { signal: options.signal } : undefined;
  const response = await client.messages.create(request, requestOptions);

  if (request.stream) {
    return convertAnthropicStreamToOpenAIChunks(response);
  }

  return convertAnthropicMessageToCompletion(response);
}

export function createModelProviderRequest(runtimeConfig = {}, params = {}) {
  return buildModelProviderRequest(runtimeConfig, params);
}

export async function runModelProviderCompletion(runtimeConfig = {}, params = {}, options = {}) {
  const provider = getModelProviderDefinition(runtimeConfig.provider);

  if (provider.protocol === MODEL_PROVIDER_PROTOCOLS.OPENAI_CHAT_COMPLETIONS) {
    return runOpenAIChatCompletions(runtimeConfig, params, options);
  }

  if (provider.protocol === MODEL_PROVIDER_PROTOCOLS.ANTHROPIC_MESSAGES) {
    return runAnthropicMessages(runtimeConfig, params, options);
  }

  throw createUnsupportedProviderError(provider);
}

export async function runModelProviderStream(runtimeConfig = {}, params = {}, options = {}) {
  return runModelProviderCompletion(runtimeConfig, { ...params, stream: true }, options);
}
