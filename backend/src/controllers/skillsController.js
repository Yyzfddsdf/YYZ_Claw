function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createSkillsController({ skillCatalog, skillValidator }) {
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

      const skills = await skillCatalog.listSkills({
        workspacePath,
        query,
        category,
        includeGlobal,
        includeProject,
        includeSystem,
        selectedSkillNames
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

      const result = await skillCatalog.getSkillContent(skillName, req.query?.filePath ?? "SKILL.md", {
        workspacePath
      });
      if (!result) {
        const notFoundError = createValidationError("skill not found");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const bundleFiles = await skillCatalog.listBundleFiles(skillName, { workspacePath });

      res.json({
        skill: {
          name: result.skill.name,
          displayName: result.skill.displayName,
          shortDescription: result.skill.shortDescription,
          defaultPrompt: result.skill.defaultPrompt,
          category: result.skill.category,
          relativePath: result.skill.relativePath,
          isSystem: result.skill.isSystem,
          description: result.skill.description,
          version: result.skill.version,
          author: result.skill.author,
          license: result.skill.license,
          platforms: result.skill.platforms,
          prerequisites: result.skill.prerequisites,
          requiredEnvironmentVariables: result.skill.requiredEnvironmentVariables,
          relatedSkills: result.skill.hermes.relatedSkills,
          requiresTools: result.skill.hermes.requiresTools,
          requiresToolsets: result.skill.hermes.requiresToolsets,
          fallbackForTools: result.skill.hermes.fallbackForTools,
          fallbackForToolsets: result.skill.hermes.fallbackForToolsets
        },
        filePath: result.filePath,
        content: result.content,
        bundleFiles
      });
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
