import { safeJsonParse } from "../../../utils/safeJsonParse.js";
import { normalizeRemoteExecutedToolResponse } from "../tools/remoteToolResultHooks.js";

function normalizeToolNames(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const toolName = String(item ?? "").trim();
    if (!toolName) {
      continue;
    }

    const key = toolName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(toolName);
  }

  return normalized;
}

export class ScopedToolRegistry {
  constructor(options = {}) {
    this.baseToolRegistry = options.baseToolRegistry ?? null;
    this.allowedToolNames = normalizeToolNames(options.allowedToolNames ?? []);
    this.allowedToolNameSet = new Set(this.allowedToolNames.map((item) => item.toLowerCase()));
    this.scopeName = String(options.scopeName ?? "remote-control").trim() || "remote-control";
  }

  isToolAllowed(toolName) {
    const normalized = String(toolName ?? "").trim();
    if (!normalized) {
      return false;
    }

    if (this.allowedToolNameSet.size === 0) {
      return true;
    }

    return this.allowedToolNameSet.has(normalized.toLowerCase());
  }

  listTools() {
    if (!this.baseToolRegistry || typeof this.baseToolRegistry.listTools !== "function") {
      return [];
    }

    return this.baseToolRegistry
      .listTools()
      .filter((tool) => this.isToolAllowed(tool?.name));
  }

  getOpenAITools() {
    return this.listTools().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  async executeToolCall(toolCall, executionContext = {}) {
    const toolName = String(toolCall?.function?.name ?? "").trim();
    if (!this.isToolAllowed(toolName)) {
      throw new Error(`Tool is not enabled in ${this.scopeName}: ${toolName || "unknown"}`);
    }

    if (!this.baseToolRegistry) {
      throw new Error("base tool registry is unavailable");
    }

    if (typeof this.baseToolRegistry.getTool === "function") {
      const tool = this.baseToolRegistry.getTool(toolName);
      if (!tool || typeof tool.execute !== "function") {
        throw new Error(`Tool is not registered: ${toolName}`);
      }

      const rawArguments = toolCall?.function?.arguments ?? "{}";
      const parsedArguments = safeJsonParse(rawArguments, {});
      const rawResult = await tool.execute(parsedArguments, executionContext);
      return normalizeRemoteExecutedToolResponse({
        toolName,
        rawResult,
        isError: false
      });
    }

    if (typeof this.baseToolRegistry.executeToolCall === "function") {
      const rawResult = await this.baseToolRegistry.executeToolCall(toolCall, executionContext);
      return normalizeRemoteExecutedToolResponse({
        toolName,
        rawResult,
        isError: Boolean(rawResult?.isError)
      });
    }

    throw new Error("base tool registry does not support execute");
  }
}
