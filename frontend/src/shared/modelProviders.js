export const MODEL_PROVIDER_IDS = {
  OPENAI_COMPLETION: "openai-completion",
  OPENAI_RESPONSES: "openai-responses",
  DEEPSEEK_COMPLETION: "deepseek-completion",
  DASHSCOPE_COMPLETION: "dashscope-completion",
  ANTHROPIC_MESSAGES: "anthropic-messages"
};

export const DEFAULT_MODEL_PROVIDER = MODEL_PROVIDER_IDS.OPENAI_COMPLETION;

export const MODEL_PROVIDER_OPTIONS = [
  {
    value: MODEL_PROVIDER_IDS.OPENAI_COMPLETION,
    label: "OpenAI Completion",
    description: "标准 OpenAI-compatible Chat Completions，支持 reasoning_effort 强度。",
    capabilities: {
      supportsReasoningEffort: true,
      supportsThinkingSwitch: false,
      supportsReasoningContent: false,
      supportsVision: true
    }
  },
  {
    value: MODEL_PROVIDER_IDS.OPENAI_RESPONSES,
    label: "OpenAI Responses",
    description: "OpenAI Responses API，使用 input/tools/reasoning 格式并内部转换为现有消息流。",
    capabilities: {
      supportsReasoningEffort: true,
      supportsThinkingSwitch: false,
      supportsReasoningContent: true,
      supportsVision: true
    }
  },
  {
    value: MODEL_PROVIDER_IDS.DEEPSEEK_COMPLETION,
    label: "DeepSeek Completion",
    description: "DeepSeek Chat Completions，使用 thinking.type 开关，并支持 reasoning_effort=high/max。",
    capabilities: {
      supportsReasoningEffort: true,
      supportsThinkingSwitch: true,
      supportsReasoningContent: true,
      supportsVision: false
    }
  },
  {
    value: MODEL_PROVIDER_IDS.DASHSCOPE_COMPLETION,
    label: "DashScope 百炼 Completion",
    description: "百炼 OpenAI 兼容接口，使用 enable_thinking 控制思考开关。",
    capabilities: {
      supportsReasoningEffort: false,
      supportsThinkingSwitch: true,
      supportsReasoningContent: true,
      supportsVision: true
    }
  },
  {
    value: MODEL_PROVIDER_IDS.ANTHROPIC_MESSAGES,
    label: "Anthropic Messages",
    description: "Anthropic 官方 Messages API，使用官方 SDK 和独立消息/工具转换。",
    capabilities: {
      supportsReasoningEffort: true,
      supportsThinkingSwitch: false,
      supportsReasoningContent: true,
      supportsVision: true
    }
  }
];

const BASE_THINKING_OFF_OPTION = {
  value: "off",
  label: "关闭",
  description: "不请求思考内容"
};

export function normalizeModelProvider(value) {
  const provider = String(value ?? "").trim();
  return MODEL_PROVIDER_OPTIONS.some((option) => option.value === provider)
    ? provider
    : DEFAULT_MODEL_PROVIDER;
}

export function getModelProviderOption(value) {
  const provider = normalizeModelProvider(value);
  return MODEL_PROVIDER_OPTIONS.find((option) => option.value === provider) ?? MODEL_PROVIDER_OPTIONS[0];
}

export function getProviderCapabilities(value) {
  return { ...getModelProviderOption(value).capabilities };
}

export function getThinkingModeOptionsForProvider(value) {
  const provider = normalizeModelProvider(value);
  const capabilities = getProviderCapabilities(value);

  if (provider === MODEL_PROVIDER_IDS.ANTHROPIC_MESSAGES) {
    return [
      {
        value: "low",
        label: "低",
        description: "传 output_config.effort=low"
      },
      {
        value: "medium",
        label: "中",
        description: "传 output_config.effort=medium"
      },
      {
        value: "high",
        label: "高",
        description: "传 output_config.effort=high"
      },
      {
        value: "xhigh",
        label: "超高",
        description: "传 output_config.effort=xhigh"
      },
      {
        value: "max",
        label: "最高",
        description: "传 output_config.effort=max"
      }
    ];
  }

  if (provider === MODEL_PROVIDER_IDS.OPENAI_RESPONSES) {
    return [
      BASE_THINKING_OFF_OPTION,
      {
        value: "default",
        label: "默认",
        description: "传 reasoning.summary=auto，不指定强度"
      },
      {
        value: "low",
        label: "低",
        description: "传 reasoning.effort=low"
      },
      {
        value: "medium",
        label: "中",
        description: "传 reasoning.effort=medium"
      },
      {
        value: "high",
        label: "高",
        description: "传 reasoning.effort=high"
      }
    ];
  }

  if (provider === MODEL_PROVIDER_IDS.DEEPSEEK_COMPLETION) {
    return [
      BASE_THINKING_OFF_OPTION,
      {
        value: "high",
        label: "高",
        description: "传 thinking.type=enabled 与 reasoning_effort=high"
      },
      {
        value: "max",
        label: "最高",
        description: "传 thinking.type=enabled 与 reasoning_effort=max"
      }
    ];
  }

  if (capabilities.supportsReasoningEffort) {
    return [
      BASE_THINKING_OFF_OPTION,
      {
        value: "default",
        label: "默认",
        description: "开启思考，但不传强度字段"
      },
      {
        value: "low",
        label: "低",
        description: "传 reasoning_effort=low"
      },
      {
        value: "medium",
        label: "中",
        description: "传 reasoning_effort=medium"
      },
      {
        value: "high",
        label: "高",
        description: "传 reasoning_effort=high"
      },
      {
        value: "xhigh",
        label: "超高",
        description: "传 reasoning_effort=xhigh"
      }
    ];
  }

  if (capabilities.supportsThinkingSwitch || capabilities.supportsReasoningContent) {
    return [
      BASE_THINKING_OFF_OPTION,
      {
        value: "default",
        label: "开启",
        description: "传 enable_thinking=true"
      }
    ];
  }

  return [BASE_THINKING_OFF_OPTION];
}

export function isThinkingModeSupportedByProvider(provider, thinkingMode) {
  const mode = String(thinkingMode ?? "off").trim() || "off";
  return getThinkingModeOptionsForProvider(provider).some((option) => option.value === mode);
}

export function providerSupportsThinking(provider) {
  return getThinkingModeOptionsForProvider(provider).some((option) => option.value !== "off");
}
