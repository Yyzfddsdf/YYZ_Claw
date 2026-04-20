import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizeText(value) {
  return String(value ?? "").trim();
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeToolModule(toolModule) {
  const candidate = toolModule?.default ?? toolModule?.tool ?? toolModule;
  const toolName = normalizeText(candidate?.name);
  return toolName;
}

async function readToolNamesFromDir(dirPath) {
  const normalizedDirPath = normalizeText(dirPath);
  if (!normalizedDirPath) {
    return [];
  }

  let entries = [];
  try {
    entries = await fs.readdir(normalizedDirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const toolFilePaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tool.js"))
    .map((entry) => path.join(normalizedDirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const toolNames = [];

  for (const toolFilePath of toolFilePaths) {
    try {
      const importedModule = await import(pathToFileURL(toolFilePath).href);
      const toolName = normalizeToolModule(importedModule);
      if (toolName) {
        toolNames.push(toolName);
      }
    } catch {
      continue;
    }
  }

  return Array.from(new Set(toolNames));
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
    toolsDir: resolveLocalPath(rawDefinition.toolsDir || "tools"),
    hooksDir: resolveLocalPath(rawDefinition.hooksDir || "hooks"),
    inheritedBaseToolNames: Array.isArray(rawDefinition.inheritedBaseToolNames)
      ? rawDefinition.inheritedBaseToolNames.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    inheritedBaseHookNames: Array.isArray(rawDefinition.inheritedBaseHookNames)
      ? rawDefinition.inheritedBaseHookNames.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    exclusiveToolNames: [],
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
      const definitionFile = path.join(agentDir, "definition.js");
      try {
        await fs.access(definitionFile);
      } catch {
        continue;
      }

      const importedModule = await import(pathToFileURL(definitionFile).href);
      const rawDefinition = importedModule?.default ?? importedModule?.definition ?? importedModule;
      const definition = normalizeDefinition(rawDefinition, agentDir);
      const prompt = await readOptionalText(definition.promptFile);
      const exclusiveToolNames = await readToolNamesFromDir(definition.toolsDir);

      this.definitionMap.set(definition.agentType, {
        ...definition,
        prompt,
        exclusiveToolNames
      });
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
      inheritedBaseToolNames: [...item.inheritedBaseToolNames],
      inheritedBaseHookNames: [...item.inheritedBaseHookNames],
      exclusiveToolNames: [...item.exclusiveToolNames],
      metadata: { ...item.metadata }
    }));
  }
}
