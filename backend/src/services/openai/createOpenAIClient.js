import OpenAI from "openai";

function parseStringifiedJsonResponse(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function createOpenAIClient(runtimeConfig) {
  const client = new OpenAI({
    apiKey: runtimeConfig.apiKey,
    baseURL: runtimeConfig.baseURL
  });

  const createChatCompletion = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = async (...args) => {
    const result = await createChatCompletion(...args);
    return parseStringifiedJsonResponse(result);
  };

  if (client.responses?.create) {
    const createResponse = client.responses.create.bind(client.responses);
    client.responses.create = async (...args) => {
      const result = await createResponse(...args);
      return parseStringifiedJsonResponse(result);
    };
  }

  return client;
}
