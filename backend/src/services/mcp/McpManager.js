import fs from "node:fs/promises";
import path from "node:path";

import { McpClient } from "./McpClient.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeIdentifier(input, fallback) {
  const normalized = String(input ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallback;
}

function sanitizeNamespaceSegment(input, fallback = "") {
  const normalized = String(input ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallback;
}

function buildNamespacedToolName(serverName, toolName) {
  const serverSegments = String(serverName ?? "")
    .split("__")
    .map((segment) => sanitizeNamespaceSegment(segment))
    .filter(Boolean);
  const normalizedServerName = serverSegments.length > 0
    ? serverSegments.join("__")
    : "server";
  return `mcp__${normalizedServerName}__${sanitizeIdentifier(toolName, "tool")}`;
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

function normalizeServerEnv(env) {
  return isPlainObject(env) ? env : {};
}

function normalizeServerDefinition(rawServer = {}, fallbackName = "server") {
  const server = isPlainObject(rawServer) ? rawServer : {};
  return {
    name: String(server.name ?? "").trim() || fallbackName,
    transport: String(server.transport ?? "stdio").trim() === "http" ? "http" : "stdio",
    command: String(server.command ?? "").trim(),
    args: normalizeServerArgs(server.args),
    cwd: String(server.cwd ?? "").trim(),
    env: normalizeServerEnv(server.env),
    url: String(server.url ?? "").trim(),
    httpHeaders: isPlainObject(server.httpHeaders) ? server.httpHeaders : {},
    startupTimeoutMs: server.startupTimeoutMs,
    requestTimeoutMs: server.requestTimeoutMs,
    enabled: server.enabled !== false
  };
}

function expandPluginRootToken(value, pluginRootDir) {
  return String(value ?? "").replaceAll("${PLUGIN_ROOT}", String(pluginRootDir ?? "").trim());
}

function expandPluginServerDefinition(server, pluginRootDir) {
  return {
    ...server,
    command: expandPluginRootToken(server.command, pluginRootDir),
    args: Array.isArray(server.args)
      ? server.args.map((item) => expandPluginRootToken(item, pluginRootDir))
      : [],
    cwd: expandPluginRootToken(server.cwd, pluginRootDir),
    env: Object.fromEntries(
      Object.entries(normalizeServerEnv(server.env)).map(([key, value]) => [
        key,
        expandPluginRootToken(value, pluginRootDir)
      ])
    ),
    url: expandPluginRootToken(server.url, pluginRootDir)
  };
}

function normalizePluginNameSet(activePluginNames) {
  return new Set(
    (Array.isArray(activePluginNames) ? activePluginNames : [])
      .map((item) => String(item ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function shouldExposeToolForExecutionContext(tool, executionContext = null) {
  if (!tool?.pluginName) {
    return true;
  }
  const activePluginNames = normalizePluginNameSet(executionContext?.activePluginNames);
  if (activePluginNames.size === 0) {
    return false;
  }
  return activePluginNames.has(String(tool.pluginName ?? "").trim().toLowerCase());
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
  constructor({ configStore, pluginCatalog = null }) {
    this.configStore = configStore;
    this.pluginCatalog = pluginCatalog;
    this.clients = new Map();
    this.toolMap = new Map();
    this.serverSummaries = [];
    this.lastLoadErrors = [];
    this.lastConfigFingerprint = "";
  }

  async readPluginMcpServers() {
    if (!this.pluginCatalog || typeof this.pluginCatalog.read !== "function") {
      return [];
    }

    const catalog = await this.pluginCatalog.read();
    const servers = [];
    const errors = [];

    for (const plugin of Array.isArray(catalog?.plugins) ? catalog.plugins : []) {
      if (!plugin?.enabled || !plugin?.hasMcp || !String(plugin?.mcpPath ?? "").trim()) {
        continue;
      }

      try {
        const filePath = String(plugin.mcpPath).trim();
        const pluginRootDir = String(plugin.rootDir ?? "").trim() || String(await fs.realpath(path.dirname(filePath)));
        const rawText = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(rawText);
        const serverMap = isPlainObject(parsed?.mcpServers)
          ? parsed.mcpServers
          : isPlainObject(parsed?.mcp_servers)
            ? parsed.mcp_servers
            : {};

        for (const [serverKey, rawServer] of Object.entries(serverMap)) {
          const normalizedServer = expandPluginServerDefinition(
            normalizeServerDefinition(rawServer, serverKey),
            pluginRootDir
          );
          if (!normalizedServer.enabled || !normalizedServer.command) {
            continue;
          }
          servers.push({
            ...normalizedServer,
            sourceType: "plugin",
            pluginName: String(plugin.name ?? "").trim(),
            pluginDisplayName: String(plugin.displayName ?? plugin.name ?? "").trim(),
            sourcePath: filePath,
            rawServerKey: String(serverKey ?? "").trim() || normalizedServer.name
          });
        }
      } catch (error) {
        errors.push({
          name: `plugin:${String(plugin.name ?? "").trim() || "plugin"}`,
          displayName: String(plugin.displayName ?? plugin.name ?? "").trim() || String(plugin.name ?? "plugin"),
          command: String(plugin.mcpPath ?? "").trim(),
          message: String(error?.message ?? "Plugin MCP config failed to load")
        });
      }
    }

    return { servers, errors };
  }

  async resolveServerDefinitions() {
    const globalConfig = await this.configStore.read();
    const globalServers = (Array.isArray(globalConfig?.servers) ? globalConfig.servers : [])
      .map((server, index) => ({
        ...normalizeServerDefinition(server, `server_${index + 1}`),
        sourceType: "global",
        pluginName: "",
        pluginDisplayName: "",
        sourcePath: ""
      }))
      .filter((server) => server.enabled !== false);
    const pluginResolution = await this.readPluginMcpServers();
    const pluginServers = Array.isArray(pluginResolution?.servers) ? pluginResolution.servers : [];
    return {
      fingerprint: JSON.stringify({
        globalConfig: globalConfig ?? {},
        pluginServers: pluginServers.map((server) => ({
          pluginName: server.pluginName,
          rawServerKey: server.rawServerKey,
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: server.env,
          transport: server.transport,
          url: server.url,
          httpHeaders: server.httpHeaders,
          startupTimeoutMs: server.startupTimeoutMs,
          requestTimeoutMs: server.requestTimeoutMs
        }))
      }),
      servers: [...globalServers, ...pluginServers],
      preloadErrors: Array.isArray(pluginResolution?.errors) ? pluginResolution.errors : []
    };
  }

  async refresh() {
    const resolved = await this.resolveServerDefinitions();
    const fingerprint = resolved.fingerprint;

    if (
      fingerprint === this.lastConfigFingerprint &&
      this.toolMap.size > 0 &&
      this.hasHealthyClients()
    ) {
      return this.getStatus();
    }

    return this.reload(resolved);
  }

  async reload(resolved) {
    await this.closeAllClients();

    this.toolMap.clear();
    this.serverSummaries = [];
    this.lastLoadErrors = Array.isArray(resolved?.preloadErrors) ? [...resolved.preloadErrors] : [];

    const servers = Array.isArray(resolved?.servers) ? resolved.servers : [];
    const seenServerNames = new Set();

    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index];
      if (!server || typeof server !== "object" || server.enabled === false) {
        continue;
      }

      const displayName = String(server.name ?? "").trim() || `server_${index + 1}`;
      const pluginName = String(server.pluginName ?? "").trim();
      const rawServerKey = String(server.rawServerKey ?? displayName).trim() || `server_${index + 1}`;
      const rawNamespaceBase = pluginName
        ? `${sanitizeIdentifier(pluginName, "plugin")}__${sanitizeIdentifier(rawServerKey, `server_${index + 1}`)}`
        : displayName;
      let serverName = pluginName
        ? rawNamespaceBase
        : sanitizeIdentifier(rawNamespaceBase, `server_${index + 1}`);
      let suffix = 2;
      while (seenServerNames.has(serverName)) {
        serverName = pluginName
          ? `${rawNamespaceBase}__${suffix}`
          : `${sanitizeIdentifier(rawNamespaceBase, `server_${index + 1}`)}_${suffix}`;
        suffix += 1;
      }

      seenServerNames.add(serverName);

      const client = new McpClient({
        name: displayName,
        transport: server.transport,
        command: server.command,
        args: normalizeServerArgs(server.args),
        cwd: server.cwd,
        env: normalizeServerEnv(server.env),
        url: server.url,
        httpHeaders: isPlainObject(server.httpHeaders) ? server.httpHeaders : {},
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
                pluginName,
                sourceType: String(server.sourceType ?? "global").trim() || "global",
                serverName,
                serverDisplayName: displayName,
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
          pluginName,
          client,
          tools: normalizedTools
        });

        this.serverSummaries.push({
          name: serverName,
          displayName,
          pluginName,
          sourceType: String(server.sourceType ?? "global").trim() || "global",
          transport: server.transport,
          command: server.command,
          url: server.url,
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
          pluginName,
          sourceType: String(server.sourceType ?? "global").trim() || "global",
          transport: server.transport,
          command: server.command,
          url: server.url,
          enabled: true,
          toolCount: 0,
          status: "error",
          error: String(error?.message ?? "MCP server failed to start")
        });

        await client.close().catch(() => {});
      }
    }

    this.lastConfigFingerprint = String(resolved?.fingerprint ?? "");
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

  listTools(executionContext = null) {
    return Array.from(this.toolMap.values()).filter((tool) =>
      shouldExposeToolForExecutionContext(tool, executionContext)
    );
  }

  hasTool(toolName) {
    return this.toolMap.has(String(toolName ?? "").trim());
  }

  getTool(toolName) {
    return this.toolMap.get(String(toolName ?? "").trim()) ?? null;
  }

  getOpenAITools(executionContext = null) {
    return this.listTools(executionContext).map((tool) => ({
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
