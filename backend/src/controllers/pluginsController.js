function createValidationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function createPluginsController({
  pluginCatalog,
  pluginSettingsStore,
  mcpManager,
  subagentDefinitionRegistry,
  agentRuntimeFactory
}) {
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
      const pluginCommands =
        typeof pluginCatalog.collectPluginCommands === "function"
          ? await pluginCatalog.collectPluginCommands({ enabledOnly: false })
          : [];
      const pluginAgents =
        typeof pluginCatalog.collectPluginAgents === "function"
          ? await pluginCatalog.collectPluginAgents({ enabledOnly: false })
          : [];
      const skillCountByPlugin = new Map();
      const skillsByPlugin = new Map();
      const commandCountByPlugin = new Map();
      const commandsByPlugin = new Map();
      const agentCountByPlugin = new Map();
      const agentsByPlugin = new Map();
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
      for (const command of pluginCommands) {
        const pluginName = String(command?.pluginName ?? "").trim();
        if (!pluginName) {
          continue;
        }
        commandCountByPlugin.set(pluginName, (commandCountByPlugin.get(pluginName) ?? 0) + 1);
        const existing = commandsByPlugin.get(pluginName) ?? [];
        existing.push({
          pluginName: command.pluginName,
          pluginDisplayName: command.pluginDisplayName,
          name: command.name,
          description: command.description,
          relativePath: command.relativePath
        });
        commandsByPlugin.set(pluginName, existing);
      }
      for (const agent of pluginAgents) {
        const pluginName = String(agent?.pluginName ?? "").trim();
        if (!pluginName) {
          continue;
        }
        agentCountByPlugin.set(pluginName, (agentCountByPlugin.get(pluginName) ?? 0) + 1);
        const existing = agentsByPlugin.get(pluginName) ?? [];
        existing.push({
          pluginName: agent.pluginName,
          pluginDisplayName: agent.pluginDisplayName,
          agentType: agent.agentType,
          name: agent.name,
          displayName: agent.displayName,
          description: agent.description,
          relativePath: agent.relativePath
        });
        agentsByPlugin.set(pluginName, existing);
      }

      res.json({
        rootDir: catalog.rootDir,
        plugins: plugins.map((plugin) => ({
          ...plugin,
          skillCount: skillCountByPlugin.get(plugin.name) ?? plugin.skillCount ?? 0,
          skills: skillsByPlugin.get(plugin.name) ?? [],
          commandCount: commandCountByPlugin.get(plugin.name) ?? plugin.commandCount ?? 0,
          commands: commandsByPlugin.get(plugin.name) ?? [],
          agentCount: agentCountByPlugin.get(plugin.name) ?? plugin.agentCount ?? 0,
          agents: agentsByPlugin.get(plugin.name) ?? []
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
      if (subagentDefinitionRegistry && typeof subagentDefinitionRegistry.load === "function") {
        await subagentDefinitionRegistry.load();
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
      if (subagentDefinitionRegistry && typeof subagentDefinitionRegistry.load === "function") {
        await subagentDefinitionRegistry.load();
      }
      if (agentRuntimeFactory && typeof agentRuntimeFactory.clear === "function") {
        agentRuntimeFactory.clear();
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
