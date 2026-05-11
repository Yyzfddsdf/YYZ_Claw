import fs from "node:fs/promises";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeAgentType(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

const DEFINITION_FILE_NAME = "definition.json";

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeDefinition(rawDefinition = {}, baseDir) {
  const agentType = normalizeAgentType(rawDefinition.agentType);
  if (!agentType) {
    throw new Error(`Subagent definition in ${baseDir} is missing agentType`);
  }

  const resolveLocalPath = (relativePath) => {
    const normalized = normalizeText(relativePath);
    return normalized ? path.resolve(baseDir, normalized) : "";
  };

  return {
    agentType,
    displayName: normalizeText(rawDefinition.displayName) || agentType,
    description: normalizeText(rawDefinition.description),
    promptFile: resolveLocalPath(rawDefinition.promptFile || "prompt.md"),
    metadata:
      rawDefinition.metadata &&
      typeof rawDefinition.metadata === "object" &&
      !Array.isArray(rawDefinition.metadata)
        ? rawDefinition.metadata
        : {},
    baseDir
  };
}

function normalizePluginAgentDefinition(rawDefinition = {}) {
  const agentType = normalizeAgentType(rawDefinition.agentType);
  if (!agentType) {
    return null;
  }

  const prompt = normalizeText(rawDefinition.prompt);
  if (!prompt) {
    return null;
  }

  return {
    agentType,
    displayName:
      normalizeText(rawDefinition.displayName) ||
      normalizeText(rawDefinition.name) ||
      agentType,
    description: normalizeText(rawDefinition.description),
    promptFile: "",
    metadata:
      rawDefinition.metadata &&
      typeof rawDefinition.metadata === "object" &&
      !Array.isArray(rawDefinition.metadata)
        ? rawDefinition.metadata
        : {},
    baseDir: normalizeText(rawDefinition.rootDir),
    prompt
  };
}

export class SubagentDefinitionRegistry {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
    this.pluginCatalog = options.pluginCatalog ?? null;
    this.definitionMap = new Map();
  }

  async loadDefinitionFromDir(agentDir) {
    const definitionFile = path.join(agentDir, DEFINITION_FILE_NAME);
    let rawDefinition = null;

    try {
      const raw = await fs.readFile(definitionFile, "utf8");
      rawDefinition = JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const definition = normalizeDefinition(rawDefinition, agentDir);
    const prompt = await readOptionalText(definition.promptFile);
    return {
      ...definition,
      prompt
    };
  }

  async load() {
    this.definitionMap.clear();

    let entries = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const agentDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.rootDir, entry.name))
      .sort((left, right) => left.localeCompare(right));

    for (const agentDir of agentDirs) {
      const definition = await this.loadDefinitionFromDir(agentDir);
      if (!definition) {
        continue;
      }

      this.definitionMap.set(definition.agentType, definition);
    }

    return this.list();
  }

  async listPluginDefinitions(options = {}) {
    const selectedPluginNames = Array.isArray(options.selectedPluginNames)
      ? options.selectedPluginNames.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    if (
      selectedPluginNames.length === 0 ||
      !this.pluginCatalog ||
      typeof this.pluginCatalog.collectPluginAgents !== "function"
    ) {
      return [];
    }

    const pluginAgents = await this.pluginCatalog.collectPluginAgents({
      selectedPluginNames
    });
    return pluginAgents
      .map((pluginAgent) => normalizePluginAgentDefinition(pluginAgent))
      .filter(Boolean);
  }

  async resolve(agentType, options = {}) {
    const normalizedAgentType = normalizeAgentType(agentType);
    if (!normalizedAgentType) {
      return null;
    }

    const localDefinition = this.definitionMap.get(normalizedAgentType);
    if (localDefinition) {
      return localDefinition;
    }

    const pluginDefinitions = await this.listPluginDefinitions(options);
    return pluginDefinitions.find((definition) => definition.agentType === normalizedAgentType) ?? null;
  }

  get(agentType) {
    return this.definitionMap.get(normalizeAgentType(agentType)) ?? null;
  }

  has(agentType) {
    return this.definitionMap.has(normalizeAgentType(agentType));
  }

  list() {
    return Array.from(this.definitionMap.values()).map((item) => ({
      agentType: item.agentType,
      displayName: item.displayName,
      description: item.description,
      metadata: { ...item.metadata }
    }));
  }

  async listAvailable(options = {}) {
    const definitionsByType = new Map();
    for (const definition of this.definitionMap.values()) {
      definitionsByType.set(definition.agentType, definition);
    }
    for (const definition of await this.listPluginDefinitions(options)) {
      definitionsByType.set(definition.agentType, definition);
    }

    return Array.from(definitionsByType.values()).map((item) => ({
      agentType: item.agentType,
      displayName: item.displayName,
      description: item.description,
      metadata: { ...item.metadata }
    }));
  }
}
