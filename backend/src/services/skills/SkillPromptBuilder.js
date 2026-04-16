function toSkillBullet(skill) {
  const labelParts = [skill.name];
  const scope = String(skill.scope ?? "").trim();
  const category = String(skill.category ?? "").trim();
  const description = String(skill.description ?? "").trim();

  if (scope) {
    labelParts.push(`<${scope}>`);
  }

  if (category) {
    labelParts.push(`[${category}]`);
  }

  return `- ${labelParts.join(" ")}${description ? ` - ${description}` : ""}`;
}

export class SkillPromptBuilder {
  constructor(options) {
    this.skillCatalog = options.skillCatalog;
    this.maxListedSkills = Number.isInteger(options.maxListedSkills)
      ? options.maxListedSkills
      : 40;
  }

  async buildIndexPrompt(options = {}) {
    const catalog = await this.skillCatalog.read({
      workspacePath: options.workspacePath,
      includeGlobal: options.includeGlobal !== false,
      includeProject: options.includeProject !== false
    });
    const selectedSkillNames = new Set(
      (options.selectedSkillNames ?? []).map((item) => String(item ?? "").trim().toLowerCase())
    );
    const includeSystem = options.includeSystem !== false;
    const limit = Number.isInteger(options.limit) ? options.limit : this.maxListedSkills;

    const runtimeSkills = catalog.skills.filter((skill) => !skill.isSystem);
    const systemSkills = catalog.skills.filter((skill) => skill.isSystem);
    const projectSkills = runtimeSkills.filter((skill) => skill.scope === "project");
    const globalSkills = runtimeSkills.filter((skill) => skill.scope === "global");

    const selectedSkills = catalog.skills.filter((skill) =>
      selectedSkillNames.has(skill.normalizedName) ||
      selectedSkillNames.has(skill.normalizedRelativePath) ||
      selectedSkillNames.has(skill.normalizedSkillKey)
    );
    const sections = [];

    if (selectedSkills.length > 0) {
      sections.push("## 当前会话已启用技能");
      sections.push(...selectedSkills.slice(0, limit).map((skill) => toSkillBullet(skill)));
    }

    if (sections.length === 0) {
      return "";
    }

    return [
      "你正在使用 skills 协议。skills 是可按需加载的知识包，不是工具本体。",
      "只使用当前会话已启用的 skills；未启用的 skills 不可默认可见。",
      "需要查看某个已启用 skill 的完整内容时，直接调用 skill_view。",
      "<skills>",
      ...sections,
      "</skills>",
      "规则：",
      "- 先看标题和描述，再决定是否展开完整内容。",
      ""
    ].join("\n");
  }
}
