export const MODEL_PROVIDERS = Object.freeze({
  OPENAI_COMPLETION: "openai-completion",
  DASHSCOPE_COMPLETION: "dashscope-completion"
});

export const MODEL_PROVIDER_PROTOCOLS = Object.freeze({
  OPENAI_CHAT_COMPLETIONS: "openai-chat-completions"
});

export const DEFAULT_MODEL_PROVIDER = MODEL_PROVIDERS.OPENAI_COMPLETION;

const PROVIDER_DEFINITIONS = Object.freeze({
  [MODEL_PROVIDERS.OPENAI_COMPLETION]: Object.freeze({
    id: MODEL_PROVIDERS.OPENAI_COMPLETION,
    label: "OpenAI Chat Completions",
    protocol: MODEL_PROVIDER_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
    supportsReasoningEffort: true,
    supportsThinkingSwitch: false,
    supportsReasoningContent: false,
    supportsVision: true
  }),
  [MODEL_PROVIDERS.DASHSCOPE_COMPLETION]: Object.freeze({
    id: MODEL_PROVIDERS.DASHSCOPE_COMPLETION,
    label: "DashScope 百炼 Chat Completions",
    protocol: MODEL_PROVIDER_PROTOCOLS.OPENAI_CHAT_COMPLETIONS,
    supportsReasoningEffort: false,
    supportsThinkingSwitch: true,
    supportsReasoningContent: true,
    supportsVision: true
  })
});

export function normalizeModelProvider(value) {
  const provider = String(value ?? "").trim();
  return PROVIDER_DEFINITIONS[provider] ? provider : DEFAULT_MODEL_PROVIDER;
}

export function getModelProviderDefinition(value) {
  return PROVIDER_DEFINITIONS[normalizeModelProvider(value)];
}

export function listModelProviderDefinitions() {
  return Object.values(PROVIDER_DEFINITIONS).map((definition) => ({ ...definition }));
}

export function createModelProviderCapabilities(provider) {
  const definition = getModelProviderDefinition(provider);
  return {
    supportsReasoningEffort: definition.supportsReasoningEffort,
    supportsThinkingSwitch: definition.supportsThinkingSwitch,
    supportsReasoningContent: definition.supportsReasoningContent,
    supportsVision: definition.supportsVision
  };
}
