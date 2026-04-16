export default {
  name: "skill_view",
  description:
    "View the full content of a skill from .yyz/skills, including SKILL.md and optional bundled files.",
  parameters: {
    type: "object",
    properties: {
      workspacePath: {
        type: "string",
        description: "Optional workspace path used to resolve project-level skills."
      },
      skillName: {
        type: "string",
        description: "Skill name, skillKey, relative path, or directory basename."
      },
      filePath: {
        type: "string",
        description: "Optional file path inside the skill directory. Defaults to SKILL.md."
      }
    },
    required: ["skillName"],
    additionalProperties: false
  },
  async execute(args = {}, executionContext = {}) {
    const skillCatalog = executionContext.skillCatalog;

    if (!skillCatalog || typeof skillCatalog.getSkillContent !== "function") {
      throw new Error("skill catalog is not available");
    }

    const workspacePath =
      args.workspacePath ??
      executionContext.workspacePath ??
      executionContext.workplacePath ??
      executionContext.workingDirectory;

    const result = await skillCatalog.getSkillContent(args.skillName, args.filePath, {
      workspacePath
    });
    if (!result) {
      throw new Error(`skill not found: ${String(args.skillName ?? "").trim()}`);
    }

    const bundleFiles = await skillCatalog.listBundleFiles(args.skillName, {
      workspacePath
    });

    return {
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
    };
  }
};
