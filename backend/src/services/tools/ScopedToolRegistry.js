function normalizeToolName(value) {
  return String(value ?? "").trim();
}

function normalizeNameSet(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => normalizeToolName(item))
      .filter(Boolean)
  );
}

function isDisabledByContext(toolName, executionContext = {}) {
  const disabledTools = Array.isArray(executionContext?.disabledTools)
    ? executionContext.disabledTools
    : Array.isArray(executionContext?.toolSettings?.disabledTools)
      ? executionContext.toolSettings.disabledTools
      : [];
  return disabledTools
    .map((item) => normalizeToolName(item))
    .filter(Boolean)
    .includes(normalizeToolName(toolName));
}

export class ScopedToolRegistry {
  constructor(options = {}) {
    this.baseRegistry = options.baseRegistry ?? null;
    this.extraRegistry = options.extraRegistry ?? null;
    this.inheritedBaseToolNames = normalizeNameSet(options.inheritedBaseToolNames);
  }

  isBaseToolAllowed(toolName) {
    const normalizedToolName = normalizeToolName(toolName);
    if (!normalizedToolName) {
      return false;
    }

    if (this.inheritedBaseToolNames.size === 0) {
      return false;
    }

    return this.inheritedBaseToolNames.has(normalizedToolName);
  }

  listTools(executionContext = {}) {
    const merged = new Map();

    for (const tool of this.baseRegistry?.listTools?.(executionContext) ?? []) {
      if (this.isBaseToolAllowed(tool?.name) && !isDisabledByContext(tool?.name, executionContext)) {
        merged.set(tool.name, tool);
      }
    }

    for (const tool of this.extraRegistry?.listTools?.(executionContext) ?? []) {
      if (normalizeToolName(tool?.name) && !isDisabledByContext(tool?.name, executionContext)) {
        merged.set(tool.name, tool);
      }
    }

    return Array.from(merged.values());
  }

  getOpenAITools(executionContext = {}) {
    return this.listTools(executionContext).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  async executeToolCall(toolCall, executionContext = {}) {
    const toolName = normalizeToolName(toolCall?.function?.name);
    if (!toolName) {
      throw new Error("Tool call is missing function name.");
    }
    if (isDisabledByContext(toolName, executionContext)) {
      throw new Error(`Tool is disabled for this conversation: ${toolName}`);
    }

    if (this.extraRegistry?.hasTool?.(toolName)) {
      return this.extraRegistry.executeToolCall(toolCall, executionContext);
    }

    if (this.isBaseToolAllowed(toolName) && this.baseRegistry?.executeToolCall) {
      return this.baseRegistry.executeToolCall(toolCall, executionContext);
    }

    throw new Error(`Tool is not available for this agent: ${toolName}`);
  }
}
