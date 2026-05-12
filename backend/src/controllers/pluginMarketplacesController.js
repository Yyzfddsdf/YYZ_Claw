function createValidationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function createPluginMarketplacesController({
  marketplaceStore,
  pluginCatalog,
  mcpManager,
  subagentDefinitionRegistry
}) {
  function ensureMarketplaceStore() {
    if (!marketplaceStore) {
      throw createValidationError("plugin marketplace store is not available", 500);
    }
  }

  async function refreshPluginRuntime() {
    if (pluginCatalog && typeof pluginCatalog.refresh === "function") {
      await pluginCatalog.refresh();
    }
    if (mcpManager && typeof mcpManager.refresh === "function") {
      await mcpManager.refresh();
    }
    if (subagentDefinitionRegistry && typeof subagentDefinitionRegistry.load === "function") {
      await subagentDefinitionRegistry.load();
    }
  }

  return {
    listMarketplaces: async (_req, res) => {
      ensureMarketplaceStore();
      res.json({
        marketplaces: await marketplaceStore.listMarketplaces()
      });
    },

    addMarketplace: async (req, res) => {
      ensureMarketplaceStore();
      const source = normalizeText(req.body?.source);
      if (!source) {
        throw createValidationError("source is required");
      }

      const marketplace = await marketplaceStore.addMarketplace({
        name: normalizeText(req.body?.name),
        displayName: normalizeText(req.body?.displayName),
        description: normalizeText(req.body?.description),
        source
      });
      res.status(201).json({ marketplace });
    },

    removeMarketplace: async (req, res) => {
      ensureMarketplaceStore();
      const removed = await marketplaceStore.removeMarketplace(req.params.marketplaceId);
      if (!removed) {
        throw createValidationError("marketplace not found", 404);
      }
      res.json({ removed: true });
    },

    listMarketplacePlugins: async (_req, res) => {
      ensureMarketplaceStore();
      res.json(await marketplaceStore.listMarketplacePlugins());
    },

    installMarketplacePlugin: async (req, res) => {
      ensureMarketplaceStore();
      const plugin = req.body?.plugin && typeof req.body.plugin === "object"
        ? req.body.plugin
        : req.body;
      const result = await marketplaceStore.installPlugin(plugin);
      await refreshPluginRuntime();
      res.status(201).json(result);
    }
  };
}
