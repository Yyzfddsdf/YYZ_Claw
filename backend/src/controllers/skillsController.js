function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createSkillsController({ skillCatalog, skillValidator, pluginCatalog }) {
  return {
    refreshSkills: async (_req, res) => {
      if (!skillCatalog || typeof skillCatalog.refresh !== "function") {
        throw createValidationError("skill catalog is not available");
      }

      const catalog = await skillCatalog.refresh();
      res.json({
        refreshed: true,
        skillCount: catalog.skills.length
      });
    },

    listSkills: async (req, res) => {
      if (!skillCatalog || typeof skillCatalog.listSkills !== "function") {
        throw createValidationError("skill catalog is not available");
      }

      const query = String(req.query?.query ?? "").trim();
      const category = String(req.query?.category ?? "").trim();
      const workspacePath = String(req.query?.workspacePath ?? "").trim();
      const includeGlobal = String(req.query?.includeGlobal ?? "true").trim() !== "false";
      const includeProject = String(req.query?.includeProject ?? "true").trim() !== "false";
      const includeSystem = String(req.query?.includeSystem ?? "true").trim() !== "false";
      const selectedSkillNames = String(req.query?.selectedSkillNames ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const selectedPluginNames = String(req.query?.selectedPluginNames ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      const nativeSkills = await skillCatalog.listSkills({
        workspacePath,
        query,
        category,
        includeGlobal,
        includeProject,
        includeSystem,
        selectedSkillNames
      });
      const pluginSkills =
        pluginCatalog && typeof pluginCatalog.collectPluginSkills === "function"
          ? (await pluginCatalog.collectPluginSkills({
              enabledOnly: true,
              selectedPluginNames
            })).map((skill) => ({
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
            }))
          : [];
      const skills = [...nativeSkills, ...pluginSkills].filter((skill) => {
        if (!query) {
          return true;
        }
        return [
          skill.name,
          skill.displayName,
          skill.description,
          skill.shortDescription,
          skill.pluginName,
          skill.relativePath
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase());
      });

      res.json({
        skills,
        skillCount: skills.length
      });
    },

    getSkillByName: async (req, res) => {
      const skillName = String(req.params.skillName ?? "").trim();
      const workspacePath = String(
        req.query?.workspacePath ??
          req.query?.workplacePath ??
          req.query?.workingDirectory ??
          ""
      ).trim();

      if (!skillName) {
        throw createValidationError("skillName is required");
      }

      if (!skillCatalog || typeof skillCatalog.getSkillContent !== "function") {
        throw createValidationError("skill catalog is not available");
      }

      const result = skillName.startsWith("plugin:")
        && pluginCatalog
        && typeof pluginCatalog.getPluginSkillContent === "function"
          ? await pluginCatalog.getPluginSkillContent(skillName, req.query?.filePath ?? "SKILL.md")
          : await skillCatalog.getSkillContent(skillName, req.query?.filePath ?? "SKILL.md", {
              workspacePath
            });
      if (!result) {
        const notFoundError = createValidationError("skill not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.json({
        skill: {
          name: result.skill.name,
          scope: result.skill.scope,
          skillKey: result.skill.skillKey,
          pluginName: result.skill.pluginName,
          pluginDisplayName: result.skill.pluginDisplayName,
          displayName: result.skill.displayName,
          shortDescription: result.skill.shortDescription,
          defaultPrompt: result.skill.defaultPrompt,
          iconSmall: result.skill.iconSmall,
          iconLarge: result.skill.iconLarge,
          brandColor: result.skill.brandColor,
          category: result.skill.category,
          relativePath: result.skill.relativePath,
          isSystem: result.skill.isSystem,
          description: result.skill.description,
          version: result.skill.version,
          author: result.skill.author,
          license: result.skill.license
        },
        filePath: result.filePath,
        content: result.content
      });
    },

    getSkillAsset: async (req, res) => {
      const skillName = String(req.params.skillName ?? "").trim();
      const filePath = String(req.query?.filePath ?? "").trim();
      const workspacePath = String(
        req.query?.workspacePath ??
          req.query?.workplacePath ??
          req.query?.workingDirectory ??
          ""
      ).trim();

      if (!skillName) {
        throw createValidationError("skillName is required");
      }

      if (!filePath) {
        throw createValidationError("filePath is required");
      }

      if (!skillCatalog || typeof skillCatalog.getSkillAsset !== "function") {
        throw createValidationError("skill catalog is not available");
      }

      const result = skillName.startsWith("plugin:")
        && pluginCatalog
        && typeof pluginCatalog.getPluginSkillAsset === "function"
          ? await pluginCatalog.getPluginSkillAsset(skillName, filePath)
          : await skillCatalog.getSkillAsset(skillName, filePath, {
              workspacePath
            });
      if (!result) {
        const notFoundError = createValidationError("skill not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      res.setHeader("Content-Type", result.mimeType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(result.content);
    },

    validateSkillByName: async (req, res) => {
      const skillName = String(req.params.skillName ?? "").trim();
      const workspacePath = String(
        req.query?.workspacePath ??
          req.query?.workplacePath ??
          req.query?.workingDirectory ??
          ""
      ).trim();

      if (!skillName) {
        throw createValidationError("skillName is required");
      }

      if (!skillValidator || typeof skillValidator.validate !== "function") {
        throw createValidationError("skill validator is not available");
      }

      const report = await skillValidator.validate(skillName, { workspacePath });
      res.json(report);
    }
  };
}
