import { normalizeExecutedToolResponse } from "./toolResultHooks.js";

function normalizeToolName(toolCall) {
  return String(toolCall?.function?.name ?? "").trim();
}

function normalizeDisabledTools(executionContext = {}) {
  return new Set(
    (Array.isArray(executionContext?.disabledTools)
      ? executionContext.disabledTools
      : Array.isArray(executionContext?.toolSettings?.disabledTools)
        ? executionContext.toolSettings.disabledTools
        : []
    )
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
  );
}

function isToolEnabled(tool, executionContext = {}) {
  if (!tool || typeof tool !== "object") {
    return false;
  }

  return !normalizeDisabledTools(executionContext).has(String(tool.name ?? "").trim());
}

export class UnifiedToolRegistry {
  constructor({ localToolRegistry, mcpManager = null }) {
    this.localToolRegistry = localToolRegistry;
    this.mcpManager = mcpManager;
  }

  async refresh() {
    if (this.mcpManager && typeof this.mcpManager.refresh === "function") {
      await this.mcpManager.refresh();
    }

    return this.listTools();
  }

  register(tool) {
    return this.localToolRegistry.register(tool);
  }

  async autoRegisterFromDir(dirPath) {
    return this.localToolRegistry.autoRegisterFromDir(dirPath);
  }

  listTools(executionContext = null) {
    const toolMap = new Map();

    for (const tool of this.localToolRegistry.listTools(executionContext)) {
      toolMap.set(tool.name, tool);
    }

    for (const tool of this.mcpManager?.listTools?.() ?? []) {
      if (!toolMap.has(tool.name) && (!executionContext || isToolEnabled(tool, executionContext))) {
        toolMap.set(tool.name, tool);
      }
    }

    return Array.from(toolMap.values());
  }

  getOpenAITools(executionContext = {}) {
    return this.listTools(executionContext)
      .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  async executeToolCall(toolCall, executionContext = {}) {
    const toolName = normalizeToolName(toolCall);

    if (!toolName) {
      throw new Error("Tool call is missing function name.");
    }

    const availableTool = this.listTools(executionContext).find((tool) => tool.name === toolName);
    if (!availableTool) {
      throw new Error(`Tool is disabled or not registered: ${toolName}`);
    }

    if (this.localToolRegistry.hasTool(toolName)) {
      return this.localToolRegistry.executeToolCall(toolCall, executionContext);
    }

    if (this.mcpManager && this.mcpManager.hasTool(toolName)) {
      const result = await this.mcpManager.executeToolCall(toolCall, executionContext);
      return normalizeExecutedToolResponse({
        toolName,
        rawResult: result?.result ?? result?.content ?? result,
        isError: Boolean(result?.isError)
      });
    }

    throw new Error(`Tool is not registered: ${toolName}`);
  }
}
