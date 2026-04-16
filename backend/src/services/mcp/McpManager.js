import { McpClient } from "./McpClient.js";

function sanitizeIdentifier(input, fallback) {
  const normalized = String(input ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallback;
}

function buildNamespacedToolName(serverName, toolName) {
  return `mcp__${sanitizeIdentifier(serverName, "server")}__${sanitizeIdentifier(toolName, "tool")}`;
}

function normalizeToolInputSchema(tool) {
  if (tool && typeof tool === "object" && tool.inputSchema && typeof tool.inputSchema === "object") {
    return tool.inputSchema;
  }

  return {
    type: "object",
    properties: {}
  };
}

function normalizeToolDescription(serverDisplayName, tool) {
  const description = String(tool?.description ?? "").trim();

  if (!description) {
    return `[MCP:${serverDisplayName}] ${String(tool?.name ?? "tool")}`;
  }

  return `[MCP:${serverDisplayName}] ${description}`;
}

function normalizeServerArgs(args) {
  return Array.isArray(args) ? args.map((item) => String(item ?? "")) : [];
}

function normalizeResultContent(result) {
  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result?.content)) {
    const parts = result.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        if (typeof item.text === "string") {
          return item.text;
        }

        if (typeof item.content === "string") {
          return item.content;
        }

        return JSON.stringify(item);
      })
      .filter((item) => String(item ?? "").length > 0);

    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  if (typeof result?.text === "string" && result.text.trim().length > 0) {
    return result.text;
  }

  if (result && typeof result === "object") {
    return JSON.stringify(result, null, 2);
  }

  return String(result ?? "");
}

function createExecutionError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export class McpManager {
  constructor({ configStore }) {
    this.configStore = configStore;
    this.clients = new Map();
    this.toolMap = new Map();
    this.serverSummaries = [];
    this.lastLoadErrors = [];
    this.lastConfigFingerprint = "";
  }

  async refresh() {
    const config = await this.configStore.read();
    const fingerprint = JSON.stringify(config ?? {});

    if (
      fingerprint === this.lastConfigFingerprint &&
      this.toolMap.size > 0 &&
      this.hasHealthyClients()
    ) {
      return this.getStatus();
    }

    return this.reload(config);
  }

  async reload(config) {
    await this.closeAllClients();

    this.toolMap.clear();
    this.serverSummaries = [];
    this.lastLoadErrors = [];

    const servers = Array.isArray(config?.servers) ? config.servers : [];
    const seenServerNames = new Set();

    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index];
      if (!server || typeof server !== "object" || server.enabled === false) {
        continue;
      }

      const displayName = String(server.name ?? "").trim() || `server_${index + 1}`;
      let serverName = sanitizeIdentifier(displayName, `server_${index + 1}`);
      let suffix = 2;
      while (seenServerNames.has(serverName)) {
        serverName = `${sanitizeIdentifier(displayName, `server_${index + 1}`)}_${suffix}`;
        suffix += 1;
      }

      seenServerNames.add(serverName);

      const client = new McpClient({
        name: displayName,
        transport: String(server.transport ?? "stdio").trim() === "http" ? "http" : "stdio",
        command: String(server.command ?? "").trim(),
        args: normalizeServerArgs(server.args),
        cwd: String(server.cwd ?? "").trim(),
        env: server.env && typeof server.env === "object" ? server.env : {},
        url: String(server.url ?? "").trim(),
        httpHeaders: server.httpHeaders && typeof server.httpHeaders === "object" ? server.httpHeaders : {},
        startupTimeoutMs: server.startupTimeoutMs,
        requestTimeoutMs: server.requestTimeoutMs
      });

      try {
        await client.start();
        const remoteTools = await client.listTools();
        const normalizedTools = Array.isArray(remoteTools)
          ? remoteTools.map((tool, toolIndex) => {
              const toolName = String(tool?.name ?? "").trim() || `tool_${toolIndex + 1}`;
              const namespacedName = buildNamespacedToolName(serverName, toolName);

              return {
                name: namespacedName,
                description: normalizeToolDescription(displayName, tool),
                parameters: normalizeToolInputSchema(tool),
                execute: async (toolArguments = {}) => {
                  const args =
                    toolArguments && typeof toolArguments === "object" && !Array.isArray(toolArguments)
                      ? toolArguments
                      : {};

                  const response = await client.callTool(toolName, {
                    ...args
                  });

                  return {
                    name: namespacedName,
                    isError: Boolean(response?.isError),
                    content: normalizeResultContent(response)
                  };
                }
              };
            })
          : [];

        for (const tool of normalizedTools) {
          this.toolMap.set(tool.name, tool);
        }

        this.clients.set(serverName, {
          name: serverName,
          displayName,
          client,
          tools: normalizedTools
        });

        this.serverSummaries.push({
          name: serverName,
          displayName,
          transport: String(server.transport ?? "stdio").trim() === "http" ? "http" : "stdio",
          command: String(server.command ?? "").trim(),
          url: String(server.url ?? "").trim(),
          enabled: true,
          toolCount: normalizedTools.length,
          status: "ready",
          error: ""
        });
      } catch (error) {
        this.lastLoadErrors.push({
          name: serverName,
          displayName,
          command: String(server.command ?? "").trim(),
          message: String(error?.message ?? "MCP server failed to start")
        });

        this.serverSummaries.push({
          name: serverName,
          displayName,
          transport: String(server.transport ?? "stdio").trim() === "http" ? "http" : "stdio",
          command: String(server.command ?? "").trim(),
          url: String(server.url ?? "").trim(),
          enabled: true,
          toolCount: 0,
          status: "error",
          error: String(error?.message ?? "MCP server failed to start")
        });

        await client.close().catch(() => {});
      }
    }

    this.lastConfigFingerprint = JSON.stringify(config ?? {});
    return this.getStatus();
  }

  async closeAllClients() {
    const clients = Array.from(this.clients.values());
    this.clients.clear();

    await Promise.all(
      clients.map((entry) => entry.client.close().catch(() => {}))
    );
  }

  hasHealthyClients() {
    if (this.clients.size === 0) {
      return false;
    }

    for (const entry of this.clients.values()) {
      if (!entry?.client || !entry.client.isHealthy?.()) {
        return false;
      }
    }

    return true;
  }

  listTools() {
    return Array.from(this.toolMap.values());
  }

  hasTool(toolName) {
    return this.toolMap.has(String(toolName ?? "").trim());
  }

  getTool(toolName) {
    return this.toolMap.get(String(toolName ?? "").trim()) ?? null;
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

  getStatus() {
    return {
      servers: this.serverSummaries,
      toolCount: this.toolMap.size,
      errorCount: this.lastLoadErrors.length,
      errors: [...this.lastLoadErrors]
    };
  }

  async executeToolCall(toolCall, executionContext = {}) {
    const toolName = String(toolCall?.function?.name ?? "").trim();

    if (!toolName) {
      throw createExecutionError("Tool call is missing function name.", 400);
    }

    const tool = this.getTool(toolName);
    if (!tool) {
      throw createExecutionError(`MCP tool is not registered: ${toolName}`, 404);
    }

    const rawArguments = String(toolCall?.function?.arguments ?? "{}").trim() || "{}";
    let parsedArguments;

    try {
      parsedArguments = JSON.parse(rawArguments);
    } catch {
      parsedArguments = {};
    }

    const result = await tool.execute(parsedArguments, executionContext);
    const content =
      typeof result === "string"
        ? result
        : String(result?.content ?? "").trim() || normalizeResultContent(result);

    return {
      name: toolName,
      content,
      isError: Boolean(result?.isError)
    };
  }
}
