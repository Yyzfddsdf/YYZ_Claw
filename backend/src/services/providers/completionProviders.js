export const COMPLETION_PROVIDERS = Object.freeze({
  OPENAI_COMPLETION: "openai-completion",
  DASHSCOPE_COMPLETION: "dashscope-completion"
});

export const DEFAULT_COMPLETION_PROVIDER = COMPLETION_PROVIDERS.OPENAI_COMPLETION;

const PROVIDER_DEFINITIONS = Object.freeze({
  [COMPLETION_PROVIDERS.OPENAI_COMPLETION]: Object.freeze({
    id: COMPLETION_PROVIDERS.OPENAI_COMPLETION,
    label: "OpenAI Chat Completions",
    supportsReasoningEffort: true,
    supportsThinkingSwitch: false,
    supportsReasoningContent: false,
    supportsVision: true
  }),
  [COMPLETION_PROVIDERS.DASHSCOPE_COMPLETION]: Object.freeze({
    id: COMPLETION_PROVIDERS.DASHSCOPE_COMPLETION,
    label: "DashScope 百炼 Chat Completions",
    supportsReasoningEffort: false,
    supportsThinkingSwitch: true,
    supportsReasoningContent: true,
    supportsVision: true
  })
});

export function normalizeCompletionProvider(value) {
  const provider = String(value ?? "").trim();
  return PROVIDER_DEFINITIONS[provider] ? provider : DEFAULT_COMPLETION_PROVIDER;
}

export function getCompletionProviderDefinition(value) {
  return PROVIDER_DEFINITIONS[normalizeCompletionProvider(value)];
}

export function listCompletionProviderDefinitions() {
  return Object.values(PROVIDER_DEFINITIONS).map((definition) => ({ ...definition }));
}

export function createProviderCapabilities(provider) {
  const definition = getCompletionProviderDefinition(provider);
  return {
    supportsReasoningEffort: definition.supportsReasoningEffort,
    supportsThinkingSwitch: definition.supportsThinkingSwitch,
    supportsReasoningContent: definition.supportsReasoningContent,
    supportsVision: definition.supportsVision
  };
}
