import { TavilyWebProvider } from "./providers/tavilyWebProvider.js";

function normalizeRuntimeConfig(runtimeConfig = {}) {
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    return {};
  }
  return runtimeConfig;
}

function normalizeProviderKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) {
    return "tavily";
  }
  return key;
}

export function createWebProvider(executionContext = {}) {
  const runtimeConfig = normalizeRuntimeConfig(executionContext?.runtimeConfig);
  const providerKey = normalizeProviderKey(runtimeConfig.webProvider);

  if (providerKey !== "tavily") {
    throw new Error(`Unsupported web provider: ${providerKey}`);
  }

  return new TavilyWebProvider({
    baseUrl: runtimeConfig.tavilyBaseUrl,
    apiKey: runtimeConfig.tavilyApiKey
  });
}

