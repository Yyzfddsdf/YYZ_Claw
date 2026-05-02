import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { safeJsonParse } from "../../utils/safeJsonParse.js";
import { normalizeExecutedToolResponse } from "./toolResultHooks.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function normalizeTool(toolModule) {
  const candidate = toolModule?.default ?? toolModule?.tool ?? toolModule;

  if (!candidate || typeof candidate !== "object") {
    throw new Error("Tool module must export an object.");
  }

  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new Error("Tool name must be a non-empty string.");
  }

  if (
    typeof candidate.description !== "string" ||
    candidate.description.trim().length === 0
  ) {
    throw new Error(`Tool ${candidate.name} is missing description.`);
  }

  if (!isPlainObject(candidate.parameters)) {
    throw new Error(`Tool ${candidate.name} must provide a JSON schema object.`);
  }

  if (typeof candidate.execute !== "function") {
    throw new Error(`Tool ${candidate.name} must provide an execute function.`);
  }

  return {
    name: candidate.name,
    description: candidate.description,
    parameters: candidate.parameters,
    execute: candidate.execute,
    isAvailable:
      typeof candidate.isAvailable === "function" ? candidate.isAvailable : null
  };
}

function isToolAvailable(tool, executionContext = {}) {
  if (!tool || typeof tool !== "object") {
    return false;
  }

  if (normalizeDisabledTools(executionContext).has(String(tool.name ?? "").trim())) {
    return false;
  }

  if (typeof tool.isAvailable !== "function") {
    return true;
  }

  return Boolean(tool.isAvailable(executionContext));
}

export class ToolRegistry {
  constructor() {
    this.toolMap = new Map();
  }

  async autoRegisterFromDir(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tool.js"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of toolFiles) {
      const fullPath = path.join(dirPath, fileName);
      const importedModule = await import(pathToFileURL(fullPath).href);
      const tool = normalizeTool(importedModule);
      this.register(tool);
    }

    return this.listTools();
  }

  register(tool) {
    const normalized = normalizeTool(tool);
    this.toolMap.set(normalized.name, normalized);
  }

  hasTool(toolName) {
    return this.toolMap.has(String(toolName ?? "").trim());
  }

  getTool(toolName) {
    return this.toolMap.get(String(toolName ?? "").trim()) ?? null;
  }

  listTools(executionContext = null) {
    const tools = Array.from(this.toolMap.values());
    if (!executionContext) {
      return tools;
    }

    return tools.filter((tool) => isToolAvailable(tool, executionContext));
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
    const toolName = toolCall?.function?.name;

    if (!toolName) {
      throw new Error("Tool call is missing function name.");
    }

    const tool = this.toolMap.get(toolName);

    if (!tool) {
      throw new Error(`Tool is not registered: ${toolName}`);
    }
    if (!isToolAvailable(tool, executionContext)) {
      throw new Error(`Tool is not available in the current runtime: ${toolName}`);
    }

    const rawArguments = toolCall?.function?.arguments ?? "{}";
    const parsedArguments = safeJsonParse(rawArguments, {});

    const result = await tool.execute(parsedArguments, executionContext);
    return normalizeExecutedToolResponse({
      toolName,
      rawResult: result,
      isError: false
    });
  }
}
