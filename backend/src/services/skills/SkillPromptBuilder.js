function toSkillLines(skill) {
  const skillKey = String(skill.skillKey ?? "").trim();
  const labelParts = [skillKey || skill.name];
  const category = String(skill.category ?? "").trim();
  const description = String(skill.description ?? "").trim();
  const defaultPrompt = String(skill.defaultPrompt ?? "").trim();
  const allowImplicitInvocation = skill.allowImplicitInvocation === true;

  if (category) {
    labelParts.push(`[${category}]`);
  }

  const lines = [`- ${labelParts.join(" ")} (name: ${skill.name})${description ? ` - ${description}` : ""}`];
  if (allowImplicitInvocation && defaultPrompt) {
    lines.push(`  default prompt: ${defaultPrompt}`);
  }

  return lines;
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
      sections.push(...selectedSkills.slice(0, limit).flatMap((skill) => toSkillLines(skill)));
    }

    if (sections.length === 0) {
      return "";
    }

    return [
      "你正在使用 skills 协议。skills 是可按需加载的知识包，不是工具本体。",
      "只使用当前会话已启用的 skills；未启用的 skills 不可默认可见。",
      "global skills 默认来自用户主目录 .yyz/skills；不要主动在当前项目根创建或查找 .yyz。",
      "需要查看某个已启用 skill 的完整内容时，直接调用 skill_view。",
      "调用 skill_view 时优先使用列表中的 skillKey（例如 global:session-memory），不要优先使用裸 name；裸 name 只作为兼容兜底。",
      "<skills>",
      ...sections,
      "</skills>",
      "规则：",
      "- 先看标题和描述，再决定是否展开完整内容。",
      ""
    ].join("\n");
  }
}
