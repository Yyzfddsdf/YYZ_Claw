export default {
  name: "skill_view",
  description:
    "View the full content of an enabled skill. Global skills default to user-home .yyz/skills; project skills are resolved from the current workspace .yyz/skills. Plugin skills are resolved from enabled plugins and must use the exact plugin skillKey shown in the skills prompt, for example plugin:presentations/presentations.",
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
          "Skill identifier. Prefer the exact skillKey shown in the skills prompt, such as global:session-memory, project:my-skill, or plugin:presentations/presentations. Plugin skills should always use plugin:<pluginName>/<skillPath>; bare skill names are accepted only as a fallback and may be ambiguous."
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
    const pluginCatalog = executionContext.pluginCatalog;

    if (!skillCatalog || typeof skillCatalog.getSkillContent !== "function") {
      throw new Error("skill catalog is not available");
    }

    const workspacePath =
      args.workspacePath ??
      executionContext.workspacePath ??
      executionContext.workplacePath ??
      executionContext.workingDirectory;

    const normalizedSkillName = String(args.skillName ?? "").trim();
    const activePluginNames = Array.isArray(executionContext.activePluginNames)
      ? executionContext.activePluginNames.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const result = normalizedSkillName.startsWith("plugin:")
      && pluginCatalog
      && typeof pluginCatalog.getPluginSkillContent === "function"
        ? await pluginCatalog.getPluginSkillContent(normalizedSkillName, args.filePath, {
            selectedPluginNames: activePluginNames
          })
        : await skillCatalog.getSkillContent(normalizedSkillName, args.filePath, {
            workspacePath
          });
    if (!result) {
      throw new Error(`skill not found: ${String(args.skillName ?? "").trim()}`);
    }

    return {
      skill: {
        name: result.skill.name,
        scope: result.skill.scope,
        skillKey: result.skill.skillKey,
        pluginName: result.skill.pluginName,
        pluginDisplayName: result.skill.pluginDisplayName,
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
