function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

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

export class RemoteControlProviderAdapter {
  constructor(options = {}) {
    this.providerKey = normalizeProviderKey(options.providerKey);
    this.configStore = options.configStore ?? null;
    this.runtimeService = options.runtimeService ?? null;
    this.eventIngestService = options.eventIngestService ?? null;
    this.connectionService = options.connectionService ?? null;
    this.toolRegistry = options.toolRegistry ?? null;
    this.historyStore = options.historyStore ?? null;
  }

  async getConfig() {
    if (!this.configStore || typeof this.configStore.read !== "function") {
      return {};
    }
    return this.configStore.read();
  }

  async saveConfig(nextConfig) {
    if (!this.configStore || typeof this.configStore.save !== "function") {
      throw new Error("provider config store is unavailable");
    }
    return this.configStore.save(nextConfig);
  }

  listAvailableTools() {
    if (!this.toolRegistry || typeof this.toolRegistry.listTools !== "function") {
      return [];
    }

    return normalizeToolNames(
      this.toolRegistry
        .listTools()
        .map((tool) => String(tool?.name ?? "").trim())
        .filter(Boolean)
    );
  }

  listRecords(query = {}) {
    if (!this.historyStore || typeof this.historyStore.listRecords !== "function") {
      return {
        records: [],
        nextCursor: null
      };
    }

    return this.historyStore.listRecords(query);
  }

  enqueueMessages(messages = []) {
    if (!this.runtimeService || typeof this.runtimeService.enqueueUserMessages !== "function") {
      throw new Error("provider runtime service is unavailable");
    }
    return this.runtimeService.enqueueUserMessages(messages);
  }

  getStatus() {
    const connectionStatus =
      this.connectionService && typeof this.connectionService.getStatus === "function"
        ? this.connectionService.getStatus()
        : null;

    if (!this.runtimeService || typeof this.runtimeService.getStatus !== "function") {
      const fallback = {
        running: false,
        queuedCount: 0,
        activeTurnId: 0,
        lastRunError: "",
        lastRunAt: 0
      };
      return connectionStatus ? { ...fallback, connection: connectionStatus } : fallback;
    }

    const runtimeStatus = this.runtimeService.getStatus();
    return connectionStatus
      ? {
          ...runtimeStatus,
          connection: connectionStatus
        }
      : runtimeStatus;
  }

  flushQueue() {
    if (!this.runtimeService || typeof this.runtimeService.flushQueue !== "function") {
      throw new Error("provider runtime service is unavailable");
    }
    return this.runtimeService.flushQueue();
  }

  handleEvent(payload = {}) {
    if (!this.eventIngestService || typeof this.eventIngestService.handleCallback !== "function") {
      return {
        kind: "ignored",
        reason: "event_ingest_unavailable"
      };
    }
    return this.eventIngestService.handleCallback(payload);
  }

  async setActive(active, options = {}) {
    const enabled = Boolean(active);
    const forceRefresh = Boolean(options.forceRefresh ?? options.forceRestart);

    if (!this.connectionService) {
      return null;
    }

    if (typeof this.connectionService.setActive === "function") {
      return this.connectionService.setActive(enabled, {
        forceRefresh
      });
    }

    if (!enabled) {
      if (typeof this.connectionService.stop === "function") {
        return this.connectionService.stop();
      }
      return null;
    }

    if (typeof this.connectionService.start === "function") {
      return this.connectionService.start({
        forceRefresh
      });
    }

    return null;
  }
}
