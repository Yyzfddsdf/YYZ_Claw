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

function buildVisionOmittedTextPart(role = "") {
  return {
    type: "text",
    text: buildVisionOmittedFallback(role)
  };
}

function sanitizeMessageContentForVision(content, supportsVision, role = "") {
  if (supportsVision !== false || !Array.isArray(content)) {
    return content;
  }

  return content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }
    return String(part.type ?? "").trim().toLowerCase() === "image_url"
      ? buildVisionOmittedTextPart(role)
      : part;
  });
}

function buildVisionOmittedFallback(role = "") {
  const normalizedRole = String(role ?? "").trim().toLowerCase();
  if (normalizedRole === "user") {
    return "[系统提示] 图片已省略：当前模型不支持视觉输入。请不要假设图片中的细节内容。";
  }
  if (normalizedRole === "system") {
    return "[系统提示] 图片上下文已省略：当前模型不支持视觉输入。请不要假设图片中的细节内容。";
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

      const sanitizedContent = sanitizeMessageContentForVision(
        message.content,
        runtimeConfig.supportsVision,
        message.role
      );
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
