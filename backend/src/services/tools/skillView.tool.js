export default {
  name: "skill_view",
  description:
    "View the full content of an enabled skill. Global skills default to user-home .yyz/skills; project skills are resolved from the current workspace .yyz/skills.",
  parameters: {
    type: "object",
    properties: {
      workspacePath: {
        type: "string",
        description:
          "Optional workspace path used only to resolve project-level skills. Global skills do not come from the project root by default."
      },
      skillName: {
        type: "string",
        description:
          "Skill identifier. Prefer the exact skillKey shown in the skills prompt, such as global:session-memory or project:my-skill. Bare skill names are accepted only as a fallback and may be ambiguous."
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
        license: result.skill.license
      },
      filePath: result.filePath,
      content: result.content
    };
  }
};
