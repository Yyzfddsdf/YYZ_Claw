import OpenAI from "openai";

export function createOpenAIClient(runtimeConfig) {
  return new OpenAI({
    apiKey: runtimeConfig.apiKey,
    baseURL: runtimeConfig.baseURL
  });
}
