const MAX_RULE_CHARS_PER_PLUGIN = 1200;
const MAX_PLUGIN_CONTEXT_CHARS = 8000;
const MAX_PLUGIN_SKILLS_PER_PLUGIN = 20;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function clipText(value, maxChars) {
  const source = normalizeText(value);
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildPluginDescription(plugin) {
  return normalizeText(plugin.interface?.longDescription) || normalizeText(plugin.description);
}

function buildPluginRules(plugin) {
  return (Array.isArray(plugin.rules) ? plugin.rules : [])
    .map((rule) => {
      const content = clipText(rule?.content, MAX_RULE_CHARS_PER_PLUGIN);
      if (!content) {
        return "";
      }
      const path = normalizeText(rule?.path);
      return path ? `# ${path}\n${content}` : content;
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildPluginSkillLines(skills) {
  return (Array.isArray(skills) ? skills : [])
    .slice(0, MAX_PLUGIN_SKILLS_PER_PLUGIN)
    .flatMap((skill) => {
      const skillKey = normalizeText(skill.skillKey);
      const name = normalizeText(skill.name);
      const description = normalizeText(skill.description || skill.shortDescription);
      const defaultPrompt = normalizeText(skill.defaultPrompt);
      const allowImplicitInvocation = skill.allowImplicitInvocation === true;
      const lines = [
        `- ${skillKey || name} (name: ${name})${description ? ` - ${description}` : ""}`,
        allowImplicitInvocation && defaultPrompt ? `  default prompt: ${defaultPrompt}` : "",
        `  view: skill_view({ "skillName": "${skillKey || name}" })`
      ];
      return lines.filter(Boolean);
    });
}

function buildPluginBlock(plugin) {
  const description = buildPluginDescription(plugin);
  const rules = buildPluginRules(plugin);
  const skillLines = buildPluginSkillLines(plugin.skills);
  if (!description && !rules && skillLines.length === 0) {
    return "";
  }

  const lines = [`<plugin name="${plugin.name}" version="${plugin.version}">`];
  if (description) {
    lines.push("<description>");
    lines.push(description);
    lines.push("</description>");
  }
  if (rules) {
    lines.push("<rules>");
    lines.push(rules);
    lines.push("</rules>");
  }
  if (skillLines.length > 0) {
    lines.push("<skills>");
    lines.push("Plugin skills are enabled or disabled only with the plugin. They cannot be toggled independently.");
    lines.push("Use the full plugin skillKey when calling skill_view.");
    lines.push(...skillLines);
    lines.push("</skills>");
  }
  lines.push("</plugin>");
  return lines.join("\n");
}

export class PluginPromptBuilder {
  constructor(options = {}) {
    this.pluginCatalog = options.pluginCatalog ?? null;
  }

  async buildIndexPrompt(options = {}) {
    if (!this.pluginCatalog || typeof this.pluginCatalog.read !== "function") {
      return "";
    }

    const selectedPluginNames = Array.isArray(options.selectedPluginNames)
      ? options.selectedPluginNames.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    if (selectedPluginNames.length === 0) {
      return "";
    }

    const selectedPluginNameSet = new Set(selectedPluginNames.map((item) => item.toLowerCase()));
    const enabledPlugins = (await this.pluginCatalog.read()).plugins
      .filter((plugin) => selectedPluginNameSet.has(normalizeText(plugin.name).toLowerCase()));
    const pluginSkills = typeof this.pluginCatalog.collectPluginSkills === "function"
      ? await this.pluginCatalog.collectPluginSkills({ enabledOnly: true, selectedPluginNames })
      : [];
    const skillsByPluginName = new Map();
    pluginSkills.forEach((skill) => {
      const pluginName = normalizeText(skill.pluginName);
      const existing = skillsByPluginName.get(pluginName) ?? [];
      existing.push(skill);
      skillsByPluginName.set(pluginName, existing);
    });

    const pluginBlocks = enabledPlugins
      .map((plugin) => buildPluginBlock({
        ...plugin,
        skills: skillsByPluginName.get(plugin.name) ?? []
      }))
      .filter(Boolean);
    if (pluginBlocks.length === 0) {
      return "";
    }

    return clipText(
      [
        "你正在使用 plugin 协议。plugins 是会话级能力包，和 skills 一样由当前会话显式启用后进入上下文。",
        "只使用当前会话已启用的 plugins；未启用的 plugin 不可默认可见。",
        "plugin skills 不在普通 skills 列表中显示；它们随插件整体启用，不能单独开关。",
        "需要查看某个已启用 plugin skill 的完整内容时，直接调用 skill_view，并使用完整 plugin skillKey。",
        "<plugins>",
        ...pluginBlocks,
        "</plugins>",
        ""
      ].join("\n"),
      MAX_PLUGIN_CONTEXT_CHARS
    );
  }
}
