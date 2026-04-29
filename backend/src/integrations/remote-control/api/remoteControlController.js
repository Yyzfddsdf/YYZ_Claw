import {
  remoteControlClearRecordsQuerySchema,
  remoteControlConfigUpdateSchema,
  remoteControlInboundPayloadSchema,
  remoteControlRecordsQuerySchema
} from "./remoteControlSchema.js";

function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

function normalizeProviderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeSkillNames(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const skillName = String(item ?? "").trim();
    if (!skillName) {
      continue;
    }

    const key = skillName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(skillName);
  }

  return normalized;
}

function normalizeProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return {
    ...value
  };
}

export function createRemoteControlController({
  remoteControlConfigStore,
  remoteControlProviderRegistry,
  remoteControlHistoryStore,
  personaStore
}) {
  if (!remoteControlConfigStore) {
    throw new Error("remoteControlConfigStore is required");
  }
  if (!remoteControlProviderRegistry) {
    throw new Error("remoteControlProviderRegistry is required");
  }
  if (!remoteControlHistoryStore) {
    throw new Error("remoteControlHistoryStore is required");
  }

  async function setProviderActive(provider, active, options = {}) {
    const adapter = provider?.adapter ?? null;
    if (!adapter || typeof adapter.setActive !== "function") {
      return null;
    }

    return adapter.setActive(Boolean(active), {
      forceRefresh: Boolean(options.forceRefresh)
    });
  }

  async function syncProviderActivation(previousKey, nextKey, options = {}) {
    const previousProvider = remoteControlProviderRegistry.get(previousKey);
    const nextProvider = remoteControlProviderRegistry.get(nextKey);

    if (previousProvider && (!nextProvider || previousProvider.key !== nextProvider.key)) {
      await setProviderActive(previousProvider, false, {
        forceRefresh: false
      });
    }

    if (nextProvider) {
      await setProviderActive(nextProvider, true, {
        forceRefresh: Boolean(options.forceRefresh)
      });
    }
  }

  async function getConfigState() {
    const config = await remoteControlConfigStore.read();
    const providers = remoteControlProviderRegistry.list();
    const activeProviderKey = normalizeProviderKey(config.activeProviderKey);

    return {
      config: {
        activeProviderKey,
        workspacePath: String(config.workspacePath ?? "").trim(),
        personaId: String(config.personaId ?? "").trim(),
        activeSkillNames: normalizeSkillNames(config.activeSkillNames)
      },
      providers
    };
  }

  async function getActiveProviderContext() {
    const state = await getConfigState();
    const activeProviderKey = normalizeProviderKey(state.config.activeProviderKey);
    const provider = remoteControlProviderRegistry.get(activeProviderKey);
    if (provider) {
      await setProviderActive(provider, true, {
        forceRefresh: false
      });
    }
    return {
      ...state,
      activeProviderKey,
      provider
    };
  }

  async function readProviderConfig(provider) {
    const adapter = provider?.adapter ?? null;
    if (!adapter || typeof adapter.getConfig !== "function") {
      return {};
    }

    const result = await adapter.getConfig();
    return normalizeProviderConfig(result);
  }

  async function saveProviderConfig(provider, providerConfig) {
    const adapter = provider?.adapter ?? null;
    if (!adapter || typeof adapter.saveConfig !== "function") {
      throw createValidationError("active provider does not support config saving");
    }

    const normalizedInput = normalizeProviderConfig(providerConfig);
    const saved = await adapter.saveConfig(normalizedInput);
    return normalizeProviderConfig(saved);
  }

  async function getProviderStatus(provider) {
    const adapter = provider?.adapter ?? null;
    if (!adapter || typeof adapter.getStatus !== "function") {
      return {
        running: false,
        queuedCount: 0,
        activeTurnId: 0,
        lastRunError: "",
        lastRunAt: 0
      };
    }
    return adapter.getStatus();
  }

  return {
    getConfig: async (_req, res) => {
      const context = await getActiveProviderContext();
      const providerConfig = context.provider ? await readProviderConfig(context.provider) : {};

      res.json({
        config: context.config,
        providers: context.providers,
        providerConfig
      });
    },

    saveConfig: async (req, res) => {
      const validation = remoteControlConfigUpdateSchema.safeParse(req.body ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const state = await getConfigState();
      const previousActiveProviderKey = normalizeProviderKey(state.config.activeProviderKey);
      let activeProviderKey = state.config.activeProviderKey;
      let workspacePath = String(state.config.workspacePath ?? "").trim();
      let personaId = String(state.config.personaId ?? "").trim();
      let activeSkillNames = normalizeSkillNames(state.config.activeSkillNames);
      if (validation.data.activeProviderKey !== undefined) {
        const requestedKey = normalizeProviderKey(validation.data.activeProviderKey);
        if (requestedKey && !remoteControlProviderRegistry.has(requestedKey)) {
          throw createValidationError(`unknown provider: ${requestedKey}`);
        }
        activeProviderKey = requestedKey;
      }
      if (validation.data.workspacePath !== undefined) {
        workspacePath = String(validation.data.workspacePath ?? "").trim();
      }
      if (validation.data.personaId !== undefined) {
        const requestedPersonaId = String(validation.data.personaId ?? "").trim();
        if (requestedPersonaId) {
          const persona = await personaStore?.getPersona?.(requestedPersonaId);
          if (!persona) {
            throw createValidationError("persona not found");
          }
        }
        personaId = requestedPersonaId;
      }
      if (validation.data.activeSkillNames !== undefined) {
        activeSkillNames = normalizeSkillNames(validation.data.activeSkillNames);
      }

      const savedGlobalConfig = await remoteControlConfigStore.save({
        activeProviderKey,
        workspacePath,
        personaId,
        activeSkillNames
      });

      let providerConfig = null;
      const activeProvider = remoteControlProviderRegistry.get(savedGlobalConfig.activeProviderKey);
      if (validation.data.providerConfig !== undefined) {
        if (!activeProvider) {
          throw createValidationError("active provider is required before saving provider config");
        }
        providerConfig = await saveProviderConfig(activeProvider, validation.data.providerConfig);
      } else if (activeProvider) {
        providerConfig = await readProviderConfig(activeProvider);
      }

      await syncProviderActivation(previousActiveProviderKey, savedGlobalConfig.activeProviderKey, {
        forceRefresh: validation.data.providerConfig !== undefined
      });

      res.json({
        config: savedGlobalConfig,
        providerConfig,
        providers: remoteControlProviderRegistry.list()
      });
    },

    listRecords: async (req, res) => {
      const validation = remoteControlRecordsQuerySchema.safeParse(req.query ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const context = await getActiveProviderContext();
      const result = remoteControlHistoryStore.listRecords(validation.data);
      res.json({
        records: Array.isArray(result?.records) ? result.records : [],
        nextCursor: Number.isFinite(Number(result?.nextCursor)) ? Number(result.nextCursor) : null,
        status: await getProviderStatus(context.provider),
        activeProviderKey: context.activeProviderKey
      });
    },

    clearRecords: async (req, res) => {
      const validation = remoteControlClearRecordsQuerySchema.safeParse(req.query ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const context = await getActiveProviderContext();
      const result = remoteControlHistoryStore.clearRecords({
        providerKey: validation.data.providerKey
      });

      res.json({
        cleared: true,
        providerKey: String(result?.providerKey ?? "").trim(),
        deletedTurns: Number(result?.deletedTurns ?? 0),
        deletedMessages: Number(result?.deletedMessages ?? 0),
        activeProviderKey: context.activeProviderKey,
        status: await getProviderStatus(context.provider)
      });
    },

    enqueueMessages: async (req, res) => {
      const validation = remoteControlInboundPayloadSchema.safeParse(req.body ?? {});
      if (!validation.success) {
        throw createValidationError(formatZodError(validation.error));
      }

      const context = await getActiveProviderContext();
      if (!context.provider || !context.provider.adapter || typeof context.provider.adapter.enqueueMessages !== "function") {
        throw createValidationError("active provider does not support message enqueue");
      }

      const messages = Array.isArray(validation.data.messages) ? validation.data.messages : [];
      if (messages.length === 0) {
        throw createValidationError("at least one message is required");
      }

      const queueResult = await context.provider.adapter.enqueueMessages(messages);
      res.status(202).json({
        accepted: true,
        ...queueResult,
        activeProviderKey: context.activeProviderKey,
        status: await getProviderStatus(context.provider)
      });
    },

    getStatus: async (_req, res) => {
      const context = await getActiveProviderContext();
      res.json({
        activeProviderKey: context.activeProviderKey,
        status: await getProviderStatus(context.provider)
      });
    },

    flushQueue: async (_req, res) => {
      const context = await getActiveProviderContext();
      if (!context.provider || !context.provider.adapter || typeof context.provider.adapter.flushQueue !== "function") {
        throw createValidationError("active provider does not support queue flush");
      }

      await context.provider.adapter.flushQueue();
      res.json({
        flushed: true,
        activeProviderKey: context.activeProviderKey,
        status: await getProviderStatus(context.provider)
      });
    },

    receiveEvent: async (req, res) => {
      const context = await getActiveProviderContext();
      if (!context.provider || !context.provider.adapter || typeof context.provider.adapter.handleEvent !== "function") {
        res.json({
          code: 0,
          msg: "ok",
          kind: "ignored",
          reason: "no_active_provider"
        });
        return;
      }

      const result = await context.provider.adapter.handleEvent(req.body ?? {});
      if (String(result?.kind ?? "").trim() === "challenge") {
        res.json({
          challenge: String(result?.challenge ?? "").trim()
        });
        return;
      }

      res.json({
        code: 0,
        msg: "ok",
        kind: String(result?.kind ?? "ignored").trim() || "ignored",
        reason: String(result?.reason ?? "").trim(),
        eventType: String(result?.eventType ?? "").trim(),
        eventId: String(result?.eventId ?? "").trim(),
        messageIds: Array.isArray(result?.messageIds) ? result.messageIds : [],
        queueResult:
          result?.queueResult && typeof result.queueResult === "object" ? result.queueResult : null,
        activeProviderKey: context.activeProviderKey,
        status: await getProviderStatus(context.provider)
      });
    }
  };
}
