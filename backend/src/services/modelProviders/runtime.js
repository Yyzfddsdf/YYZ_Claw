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

function sanitizeMessageContentForVision(content, supportsVision) {
  if (supportsVision !== false || !Array.isArray(content)) {
    return content;
  }

  return content.filter((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return true;
    }
    return String(part.type ?? "").trim().toLowerCase() !== "image_url";
  });
}

function buildVisionOmittedFallback(role = "") {
  const normalizedRole = String(role ?? "").trim().toLowerCase();
  if (normalizedRole === "user") {
    return "【图片已省略：当前模型不支持视觉输入】";
  }
  if (normalizedRole === "system") {
    return "【图片上下文已省略：当前模型不支持视觉输入】";
  }
  return "";
}

function sanitizeParamsForRuntimeCapabilities(runtimeConfig = {}, params = {}) {
  if (runtimeConfig?.supportsVision !== false || !Array.isArray(params?.messages)) {
    return params;
  }

  return {
    ...params,
    messages: params.messages.map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return message;
      }

      const sanitizedContent = sanitizeMessageContentForVision(message.content, runtimeConfig.supportsVision);
      const contentIsEmptyArray = Array.isArray(sanitizedContent) && sanitizedContent.length === 0;

      return {
        ...message,
        content: contentIsEmptyArray
          ? buildVisionOmittedFallback(message.role)
          : sanitizedContent
      };
    })
  };
}

async function runOpenAIChatCompletions(runtimeConfig = {}, params = {}, options = {}) {
  const client = createOpenAIClient(runtimeConfig);
  const request = buildModelProviderRequest(
    runtimeConfig,
    sanitizeParamsForRuntimeCapabilities(runtimeConfig, params)
  );
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
  const request = buildModelProviderRequest(
    runtimeConfig,
    sanitizeParamsForRuntimeCapabilities(runtimeConfig, params)
  );
  const requestOptions = options?.signal ? { signal: options.signal } : undefined;
  const response = await client.messages.create(request, requestOptions);

  if (request.stream) {
    return convertAnthropicStreamToOpenAIChunks(response);
  }

  return convertAnthropicMessageToCompletion(response);
}

export function createModelProviderRequest(runtimeConfig = {}, params = {}) {
  return buildModelProviderRequest(
    runtimeConfig,
    sanitizeParamsForRuntimeCapabilities(runtimeConfig, params)
  );
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
