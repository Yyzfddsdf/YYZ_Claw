function createValidationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function createPluginsController({ pluginCatalog, pluginSettingsStore, mcpManager }) {
  function ensurePluginCatalog() {
    if (!pluginCatalog || typeof pluginCatalog.listPlugins !== "function") {
      throw createValidationError("plugin catalog is not available", 500);
    }
  }

  return {
    listPlugins: async (_req, res) => {
      ensurePluginCatalog();
      const catalog = await pluginCatalog.read();
      const plugins = await pluginCatalog.listPlugins();
      const pluginSkills =
        typeof pluginCatalog.collectPluginSkills === "function"
          ? await pluginCatalog.collectPluginSkills({ enabledOnly: false })
          : [];
      const skillCountByPlugin = new Map();
      const skillsByPlugin = new Map();
      for (const skill of pluginSkills) {
        const pluginName = String(skill.pluginName ?? "").trim();
        if (!pluginName) {
          continue;
        }
        skillCountByPlugin.set(pluginName, (skillCountByPlugin.get(pluginName) ?? 0) + 1);
        const existing = skillsByPlugin.get(pluginName) ?? [];
        existing.push({
          scope: skill.scope,
          pluginName: skill.pluginName,
          pluginDisplayName: skill.pluginDisplayName,
          skillKey: skill.skillKey,
          name: skill.name,
          displayName: skill.displayName,
          shortDescription: skill.shortDescription,
          defaultPrompt: skill.defaultPrompt,
          iconSmall: skill.iconSmall,
          iconLarge: skill.iconLarge,
          brandColor: skill.brandColor,
          allowImplicitInvocation: skill.allowImplicitInvocation !== false,
          description: skill.description,
          version: skill.version,
          author: skill.author,
          license: skill.license,
          category: skill.category,
          relativePath: skill.relativePath,
          isSystem: false,
          enabled: skill.hermes.enabled !== false,
          hidden: Boolean(skill.hermes.hidden),
          selected: false,
          selectable: false
        });
        skillsByPlugin.set(pluginName, existing);
      }

      res.json({
        rootDir: catalog.rootDir,
        plugins: plugins.map((plugin) => ({
          ...plugin,
          skillCount: skillCountByPlugin.get(plugin.name) ?? plugin.skillCount ?? 0,
          skills: skillsByPlugin.get(plugin.name) ?? []
        })),
        errors: catalog.errors,
        pluginCount: plugins.length
      });
    },

    refreshPlugins: async (_req, res) => {
      ensurePluginCatalog();
      await pluginCatalog.refresh();
      if (mcpManager && typeof mcpManager.refresh === "function") {
        await mcpManager.refresh();
      }
      const plugins = await pluginCatalog.listPlugins();
      res.json({
        refreshed: true,
        pluginCount: plugins.length,
        plugins
      });
    },

    setPluginEnabled: async (req, res) => {
      ensurePluginCatalog();
      const pluginName = String(req.params.pluginName ?? "").trim();
      if (!pluginName) {
        throw createValidationError("pluginName is required");
      }

      if (!pluginSettingsStore || typeof pluginSettingsStore.setPluginEnabled !== "function") {
        throw createValidationError("plugin settings store is not available", 500);
      }

      await pluginSettingsStore.setPluginEnabled(pluginName, req.body?.enabled !== false);
      await pluginCatalog.refresh();
      if (mcpManager && typeof mcpManager.refresh === "function") {
        await mcpManager.refresh();
      }
      const plugins = await pluginCatalog.listPlugins();
      const plugin = plugins.find((item) => item.name === pluginName);
      if (!plugin) {
        throw createValidationError("plugin not found", 404);
      }

      res.json({
        plugin
      });
    },

    getPluginAsset: async (req, res) => {
      ensurePluginCatalog();
      const pluginName = String(req.params.pluginName ?? "").trim();
      const filePath = String(req.query?.filePath ?? "").trim();
      if (!pluginName) {
        throw createValidationError("pluginName is required");
      }
      if (!filePath) {
        throw createValidationError("filePath is required");
      }
      if (typeof pluginCatalog.getPluginAsset !== "function") {
        throw createValidationError("plugin asset loading is not available", 500);
      }

      const result = await pluginCatalog.getPluginAsset(pluginName, filePath);
      if (!result) {
        throw createValidationError("plugin not found", 404);
      }

      res.setHeader("Content-Type", result.mimeType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(result.content);
    }
  };
}
