function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStringArray(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )
  );
}

export const BUILT_IN_SLASH_COMMANDS = Object.freeze([
  { name: "/compact", description: "手动压缩当前会话" },
  { name: "/goal:目标", description: "设置当前会话目标" },
  { name: "/list-skills", description: "查看当前会话实际生效的 skills" },
  { name: "/list-mcps", description: "查看当前会话实际生效的 MCP" },
  { name: "/list-commands", description: "查看当前会话实际生效的命令" },
  { name: "/list-plugins", description: "查看当前会话当前启用的插件" }
]);

export function parseSlashCommandText(text) {
  const rawText = normalizeText(text);
  if (!rawText.startsWith("/")) {
    return {
      handled: false,
      action: "none",
      messageText: rawText
    };
  }

  if (/^\/compact\s*$/i.test(rawText)) {
    return {
      handled: true,
      action: "compact"
    };
  }

  const goalMatch = rawText.match(/^\/goal\s*[:：]\s*([\s\S]+)$/i);
  if (goalMatch) {
    const goal = normalizeText(goalMatch[1]);
    return {
      handled: Boolean(goal),
      action: goal ? "goal" : "none",
      goal
    };
  }

  if (/^\/list-skills\s*$/i.test(rawText)) {
    return { handled: true, action: "list_skills" };
  }

  if (/^\/list-mcps\s*$/i.test(rawText)) {
    return { handled: true, action: "list_mcps" };
  }

  if (/^\/list-commands\s*$/i.test(rawText)) {
    return { handled: true, action: "list_commands" };
  }

  if (/^\/list-plugins\s*$/i.test(rawText)) {
    return { handled: true, action: "list_plugins" };
  }

  return {
    handled: false,
    action: "none",
    messageText: rawText
  };
}

function formatSection(title, lines = []) {
  const body = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (body.length === 0) {
    return `${title}\n- 无`;
  }
  return `${title}\n${body.join("\n")}`;
}

function formatSkillLine(skill) {
  const scope = normalizeText(skill?.scope);
  const pluginName = normalizeText(skill?.pluginName);
  const sourceLabel =
    scope === "plugin" && pluginName
      ? `plugin:${pluginName}`
      : scope || "unknown";
  const name = normalizeText(skill?.displayName) || normalizeText(skill?.name) || normalizeText(skill?.skillKey);
  const description = normalizeText(skill?.shortDescription) || normalizeText(skill?.description);
  return `- [${sourceLabel}] ${name}${description ? ` - ${description}` : ""}`;
}

function formatPluginLine(plugin) {
  const pluginName = normalizeText(plugin?.name);
  const displayName = normalizeText(plugin?.displayName) || pluginName;
  const description = normalizeText(plugin?.description);
  return `- [plugin:${pluginName}] ${displayName}${description ? ` - ${description}` : ""}`;
}

function formatCommandLine(command) {
  const pluginName = normalizeText(command?.pluginName);
  const sourceLabel = pluginName ? `plugin:${pluginName}` : "built-in";
  const name = normalizeText(command?.name);
  const description = normalizeText(command?.description);
  return `- [${sourceLabel}] ${name}${description ? ` - ${description}` : ""}`;
}

function formatMcpLine(server) {
  const sourceType = normalizeText(server?.sourceType);
  const pluginName = normalizeText(server?.pluginName);
  const sourceLabel =
    sourceType === "plugin" && pluginName
      ? `plugin:${pluginName}`
      : "global";
  const displayName = normalizeText(server?.displayName) || normalizeText(server?.name);
  const transport = normalizeText(server?.transport);
  const command = normalizeText(server?.command);
  const url = normalizeText(server?.url);
  const detail = transport
    ? transport
    : command
      ? command
      : url;
  return `- [${sourceLabel}] ${displayName}${detail ? ` - ${detail}` : ""}`;
}

async function buildListSkillsText({
  workplacePath = "",
  selectedSkillNames = [],
  selectedPluginNames = [],
  skillCatalog,
  pluginCatalog
}) {
  const nativeSkills = skillCatalog && typeof skillCatalog.listSkills === "function"
    ? await skillCatalog.listSkills({
        workspacePath: workplacePath,
        includeGlobal: true,
        includeProject: true,
        includeSystem: true,
        selectedSkillNames
      })
    : [];
  const selectedNativeSkills = nativeSkills.filter((skill) => skill?.selected);
  const pluginSkills =
    pluginCatalog && typeof pluginCatalog.collectPluginSkills === "function"
      ? await pluginCatalog.collectPluginSkills({ selectedPluginNames })
      : [];

  return [
    "当前会话实际生效的 Skills",
    formatSection("普通 Skills", selectedNativeSkills.map(formatSkillLine)),
    formatSection("Plugin Skills", pluginSkills.map(formatSkillLine))
  ].join("\n\n");
}

async function buildListPluginsText({ selectedPluginNames = [], pluginCatalog }) {
  const plugins =
    pluginCatalog && typeof pluginCatalog.listPlugins === "function"
      ? await pluginCatalog.listPlugins()
      : [];
  const selectedSet = new Set(selectedPluginNames.map((item) => normalizeName(item)));
  const selectedPlugins = plugins.filter((plugin) => selectedSet.has(normalizeName(plugin?.name)));

  return [
    "当前会话已启用 Plugins",
    formatSection("Plugins", selectedPlugins.map(formatPluginLine))
  ].join("\n\n");
}

async function buildListCommandsText({ selectedPluginNames = [], pluginCatalog }) {
  const pluginCommands =
    pluginCatalog && typeof pluginCatalog.collectPluginCommands === "function"
      ? await pluginCatalog.collectPluginCommands({ selectedPluginNames })
      : [];

  return [
    "当前会话实际生效的 Commands",
    formatSection(
      "Commands",
      [
        ...BUILT_IN_SLASH_COMMANDS.map((item) => ({
          name: item.name,
          description: item.description
        })),
        ...pluginCommands
      ].map(formatCommandLine)
    )
  ].join("\n\n");
}

async function buildListMcpsText({ selectedPluginNames = [], mcpManager }) {
  if (mcpManager && typeof mcpManager.refresh === "function") {
    await mcpManager.refresh();
  }

  const status = mcpManager?.getStatus?.() ?? { servers: [] };
  const selectedSet = new Set(selectedPluginNames.map((item) => normalizeName(item)));
  const activeServers = (Array.isArray(status?.servers) ? status.servers : []).filter((server) => {
    const sourceType = normalizeName(server?.sourceType);
    if (sourceType !== "plugin") {
      return true;
    }
    return selectedSet.has(normalizeName(server?.pluginName));
  });

  return [
    "当前会话实际生效的 MCP",
    formatSection("MCP Servers", activeServers.map(formatMcpLine))
  ].join("\n\n");
}

export async function resolveSlashCommandRuntime({
  text,
  workplacePath = "",
  selectedSkillNames = [],
  selectedPluginNames = [],
  skillCatalog = null,
  pluginCatalog = null,
  mcpManager = null
} = {}) {
  const parsed = parseSlashCommandText(text);
  if (!parsed.handled) {
    return parsed;
  }

  const normalizedSkills = normalizeStringArray(selectedSkillNames);
  const normalizedPlugins = normalizeStringArray(selectedPluginNames);

  if (parsed.action === "list_skills") {
    return {
      ...parsed,
      displayText: await buildListSkillsText({
        workplacePath,
        selectedSkillNames: normalizedSkills,
        selectedPluginNames: normalizedPlugins,
        skillCatalog,
        pluginCatalog
      })
    };
  }

  if (parsed.action === "list_plugins") {
    return {
      ...parsed,
      displayText: await buildListPluginsText({
        selectedPluginNames: normalizedPlugins,
        pluginCatalog
      })
    };
  }

  if (parsed.action === "list_commands") {
    return {
      ...parsed,
      displayText: await buildListCommandsText({
        selectedPluginNames: normalizedPlugins,
        pluginCatalog
      })
    };
  }

  if (parsed.action === "list_mcps") {
    return {
      ...parsed,
      displayText: await buildListMcpsText({
        selectedPluginNames: normalizedPlugins,
        mcpManager
      })
    };
  }

  return parsed;
}
