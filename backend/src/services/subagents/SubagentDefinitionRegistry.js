import fs from "node:fs/promises";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").trim();
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
  const agentType = normalizeText(rawDefinition.agentType).toLowerCase();
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

export class SubagentDefinitionRegistry {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
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

  get(agentType) {
    return this.definitionMap.get(normalizeText(agentType).toLowerCase()) ?? null;
  }

  has(agentType) {
    return this.definitionMap.has(normalizeText(agentType).toLowerCase());
  }

  list() {
    return Array.from(this.definitionMap.values()).map((item) => ({
      agentType: item.agentType,
      displayName: item.displayName,
      description: item.description,
      metadata: { ...item.metadata }
    }));
  }
}
