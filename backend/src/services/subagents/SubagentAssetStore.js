import fs from "node:fs/promises";
import path from "node:path";

const DEFINITION_FILE_NAME = "definition.json";
const PROMPT_FILE_NAME = "prompt.md";

function normalizeText(value, maxLength = 20000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeAgentType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [normalizeText(key, 60), normalizeText(item, 500)])
      .filter(([key, item]) => key && item)
  );
}

function normalizeDefinitionPayload(payload = {}, fallbackAgentType = "") {
  const agentType = normalizeAgentType(fallbackAgentType || payload.agentType);
  const displayName = normalizeText(payload.displayName, 80);
  const description = normalizeText(payload.description, 500);
  const prompt = normalizeText(payload.prompt, 20000);

  if (!agentType || !displayName || !description || !prompt) {
    return null;
  }

  return {
    agentType,
    displayName,
    description,
    prompt,
    promptFile: PROMPT_FILE_NAME,
    metadata: normalizeMetadata(payload.metadata)
  };
}

function serializeDefinition(definition) {
  return {
    agentType: definition.agentType,
    displayName: definition.displayName,
    description: definition.description,
    promptFile: PROMPT_FILE_NAME,
    metadata: definition.metadata
  };
}

function toPublicAsset(asset) {
  return {
    agentType: asset.agentType,
    displayName: asset.displayName,
    description: asset.description,
    prompt: asset.prompt,
    metadata: { ...asset.metadata }
  };
}

export class SubagentAssetStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir;
  }

  resolveAgentDir(agentType) {
    const normalized = normalizeAgentType(agentType);
    if (!normalized || normalized === "." || normalized === "..") {
      return "";
    }

    const resolvedRoot = path.resolve(this.rootDir);
    const resolvedDir = path.resolve(resolvedRoot, normalized);
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
      return "";
    }

    return resolvedDir;
  }

  resolveDefinitionFile(agentType) {
    const agentDir = this.resolveAgentDir(agentType);
    return agentDir ? path.join(agentDir, DEFINITION_FILE_NAME) : "";
  }

  resolvePromptFile(agentType) {
    const agentDir = this.resolveAgentDir(agentType);
    return agentDir ? path.join(agentDir, PROMPT_FILE_NAME) : "";
  }

  async ensureDir() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async readAssetFromDir(dirent) {
    if (!dirent.isDirectory()) {
      return null;
    }

    const agentType = normalizeAgentType(dirent.name);
    if (!agentType) {
      return null;
    }

    try {
      const definitionRaw = await fs.readFile(this.resolveDefinitionFile(agentType), "utf8");
      const definition = JSON.parse(definitionRaw);
      const prompt = await fs.readFile(this.resolvePromptFile(agentType), "utf8");
      return normalizeDefinitionPayload(
        {
          ...definition,
          prompt,
          metadata: definition?.metadata
        },
        agentType
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async listSubagents() {
    try {
      const dirents = await fs.readdir(this.rootDir, { withFileTypes: true });
      const assets = await Promise.all(dirents.map((dirent) => this.readAssetFromDir(dirent)));
      return assets
        .filter(Boolean)
        .sort((left, right) => left.agentType.localeCompare(right.agentType))
        .map((asset) => toPublicAsset(asset));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async getSubagent(agentType) {
    const normalized = normalizeAgentType(agentType);
    if (!normalized) {
      return null;
    }

    const asset = await this.readAssetFromDir({
      isDirectory: () => true,
      name: normalized
    });
    return asset ? toPublicAsset(asset) : null;
  }

  async writeSubagent(payload = {}, existingAgentType = "") {
    const normalized = normalizeDefinitionPayload(payload, existingAgentType);
    if (!normalized) {
      throw new Error("agentType, displayName, description and prompt are required");
    }

    const agentDir = this.resolveAgentDir(normalized.agentType);
    if (!agentDir) {
      throw new Error("invalid agentType");
    }

    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, DEFINITION_FILE_NAME),
      JSON.stringify(serializeDefinition(normalized), null, 2),
      "utf8"
    );
    await fs.writeFile(path.join(agentDir, PROMPT_FILE_NAME), `${normalized.prompt}\n`, "utf8");
    return toPublicAsset(normalized);
  }

  async createSubagent(payload = {}) {
    const agentType = normalizeAgentType(payload.agentType);
    if (!agentType) {
      throw new Error("agentType is required");
    }

    if (await pathExists(this.resolveAgentDir(agentType))) {
      throw new Error("subagent already exists");
    }

    return this.writeSubagent({
      ...payload,
      agentType
    });
  }

  async updateSubagent(agentType, payload = {}) {
    const normalized = normalizeAgentType(agentType);
    if (!normalized) {
      throw new Error("agentType is required");
    }

    const existing = await this.getSubagent(normalized);
    if (!existing) {
      return null;
    }

    return this.writeSubagent({
      agentType: normalized,
      displayName: payload.displayName ?? existing.displayName,
      description: payload.description ?? existing.description,
      prompt: payload.prompt ?? existing.prompt,
      metadata: payload.metadata ?? existing.metadata
    });
  }

  async deleteSubagent(agentType) {
    const normalized = normalizeAgentType(agentType);
    const agentDir = this.resolveAgentDir(normalized);
    if (!normalized || !agentDir) {
      return false;
    }

    if (!(await pathExists(agentDir))) {
      return false;
    }

    await fs.rm(agentDir, { recursive: true, force: true });
    return true;
  }
}
